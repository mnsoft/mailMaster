'use strict';

/**
 * 腾讯云邮件推送（SES）发送渠道
 * - 签名算法：TC3-HMAC-SHA256（腾讯云 API 3.0）
 * - 接口域名：ses.tencentcloudapi.com（国内）/ ses.intl.tencentcloudapi.com（国际）
 * - 版本号：2020-10-02
 *
 * 说明：腾讯云 SES 默认仅支持「模板发送」（SendEmail.Template），
 * 需先在控制台创建并通过审核的发信模板与发信域名/地址。
 */

const crypto = require('crypto');
const https = require('https');

const DEFAULT_HOST = 'ses.tencentcloudapi.com';
const INTL_HOST = 'ses.intl.tencentcloudapi.com';
const VERSION = '2020-10-02';
const SERVICE = 'ses';

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

/** 生成 TC3-HMAC-SHA256 签名（导出以便测试） */
function buildAuthorization({ secretId, secretKey, host, action, payload, timestamp, region, token }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = sha256Hex(payload);
  const contentType = 'application/json; charset=utf-8';

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${String(action).toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': contentType,
      Host: host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
      'X-TC-Region': region || 'ap-guangzhou',
      ...(token ? { 'X-TC-Token': token } : {}),
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** 调用腾讯云 SES 接口 */
function callApi(account, action, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cred = account.ses || account;
    const secretId = cred.secretId;
    const secretKey = cred.secretKey;
    if (!secretId || !secretKey) {
      reject(new Error('未配置腾讯云 SecretId / SecretKey'));
      return;
    }
    const host = cred.host || (cred.site === 'intl' ? INTL_HOST : DEFAULT_HOST);
    const region = cred.region || (cred.site === 'intl' ? 'ap-singapore' : 'ap-guangzhou');
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const { headers } = buildAuthorization({ secretId, secretKey, host, action, payload: body, timestamp, region, token: cred.token });

    const req = https.request(
      { host, port: 443, method: 'POST', path: '/', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            /* ignore */
          }
          const response = json && json.Response;
          if (!response) {
            reject(new Error(`接口返回异常（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`));
            return;
          }
          if (response.Error) {
            const err = new Error(`${response.Error.Code || 'Error'}: ${response.Error.Message || ''}`);
            err.code = response.Error.Code;
            err.requestId = response.RequestId;
            reject(err);
            return;
          }
          resolve(response);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（20 秒）'));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/** 验证密钥与发信地址：调用 ListEmailAddress 获取控制台已配置的发信地址 */
async function verifyAccount(account) {
  const started = Date.now();
  try {
    const response = await callApi(account, 'ListEmailAddress', {});
    const senders = response.EmailSenders || [];
    const target = String(account.email || '').toLowerCase();
    const matched = senders.find((s) => String(s.EmailAddress || '').toLowerCase() === target);
    return {
      ok: true,
      message: matched
        ? `腾讯云密钥有效，发信地址 ${account.email} 已在控制台配置`
        : `腾讯云密钥有效，但发信地址 ${account.email || '（未填写）'} 未在控制台发信地址列表中找到，请先在控制台创建并验证`,
      senders: senders.map((s) => ({ email: s.EmailAddress, name: s.EmailSenderName })),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, message: `腾讯云接口调用失败：${err.message}`, durationMs: Date.now() - started };
  }
}

/**
 * 查询套餐包 / 账户额度，尽力解析出「总量 / 已用 / 剩余」。
 * ListAccountPackage 为主要接口，失败时回退 QueryAccount。
 */
async function queryQuota(account) {
  const out = { ok: false, packages: [], quota: null, message: '', raw: null };
  try {
    const response = await callApi(account, 'ListAccountPackage', {});
    out.raw = response;
    const list = response.PackageList || response.Packages || response.AccountPackageList || response.PackageInfoList || [];
    out.packages = Array.isArray(list) ? list : [];
    out.quota = parseQuota(out.packages);
    out.ok = true;
    out.message = out.quota ? '已从腾讯云获取套餐包额度' : '已获取套餐包信息，但未识别出标准的额度字段';
    return out;
  } catch (err) {
    out.message = `ListAccountPackage 调用失败：${err.message}`;
  }

  try {
    const response = await callApi(account, 'QueryAccount', {});
    out.raw = response;
    out.quota = parseQuota([response]);
    if (out.quota) {
      out.ok = true;
      out.message = '已从腾讯云账户信息中获取额度';
    }
    return out;
  } catch (err) {
    out.message = `${out.message}；QueryAccount 调用失败：${err.message}`;
    return out;
  }
}

/** 从任意结构里尽力识别额度字段（不同版本字段名可能不同） */
function parseQuota(items) {
  const pick = (obj, keys) => {
    for (const k of Object.keys(obj || {})) {
      const lower = k.toLowerCase();
      if (keys.some((want) => lower.includes(want)) && (typeof obj[k] === 'number' || /^\d+$/.test(String(obj[k])))) {
        const n = Number(obj[k]);
        if (!Number.isNaN(n)) return { key: k, value: n };
      }
    }
    return null;
  };

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const total = pick(item, ['total', 'amount', 'quantity', 'capacity', 'all']);
    const used = pick(item, ['used', 'usedsend', 'consumed', 'sent']);
    const remaining = pick(item, ['remaining', 'remain', 'left', 'balance', 'available', 'surplus']);
    const expire = Object.keys(item).find((k) => /expire|deadline|valid/i.test(k));
    if (total || used || remaining) {
      return {
        total: total ? total.value : null,
        used: used ? used.value : null,
        remaining: remaining ? remaining.value : total && used ? Math.max(0, total.value - used.value) : null,
        expireTime: expire ? item[expire] : null,
        fieldNames: { total: total && total.key, used: used && used.key, remaining: remaining && remaining.key },
      };
    }
  }
  return null;
}

/**
 * 发送一封邮件（模板模式为主）
 * @param {object} account 发信账号（provider: tencent-ses）
 * @param {object} mail { to, subject, text, html, templateData }
 */
async function sendEmail(account, mail) {
  const ses = account.ses || {};
  const payload = {
    FromEmailAddress: account.fromName ? `${account.fromName} <${account.email}>` : account.email,
    Subject: mail.subject,
    Destination: [mail.to],
    TriggerType: 0, // 非触发类（营销推广邮件）
  };
  if (ses.replyTo) payload.ReplyToAddresses = ses.replyTo;
  if (ses.unsubscribe) payload.Unsubscribe = String(ses.unsubscribe);
  if (ses.headerFrom) payload.HeaderFrom = ses.headerFrom;

  if (ses.sendMode === 'html' || !ses.templateId) {
    if (!ses.templateId && !ses.allowSimple) {
      const err = new Error('腾讯云 SES 默认仅支持模板发送：请在账号配置中填写发信模板 ID，或在控制台申请 HTML 直发权限后开启「HTML 直发」');
      err.code = 'ConfigMissing';
      throw err;
    }
    payload.Simple = { Html: mail.html || '', Text: mail.text || '' };
  } else {
    payload.Template = {
      TemplateID: Number(ses.templateId) || ses.templateId,
      TemplateData: JSON.stringify(mail.templateData || {}),
    };
  }

  const response = await callApi(account, 'SendEmail', payload, 25000);
  return { messageId: response.MessageId || '', requestId: response.RequestId || '' };
}

/** 将腾讯云错误归类为「失败 / 退信」 */
const SES_BOUNCE_CODES = ['FailedOperation.RecipientAddressNotFound', 'FailedOperation.InvalidRecipient', 'FailedOperation.MailAddressNotExist'];

function classifySesError(err) {
  const code = String(err.code || '');
  const message = String(err.message || '');
  if (SES_BOUNCE_CODES.some((c) => code.includes(c)) || /not exist|invalid.*(recipient|address)|地址不存在|收件人不存在/i.test(message)) {
    return { status: 'bounced', reason: `硬退信：${code || ''} ${message}`.trim(), transient: false };
  }
  if (/RequestLimitExceeded|LimitExceeded|TooManyRequests|频率/i.test(code + message)) {
    return { status: 'failed', reason: `触发限频（可重试）：${code} ${message}`.trim(), transient: true };
  }
  return { status: 'failed', reason: `${code || '发送失败'} ${message}`.trim(), transient: false };
}

module.exports = {
  DEFAULT_HOST,
  INTL_HOST,
  VERSION,
  buildAuthorization,
  callApi,
  verifyAccount,
  queryQuota,
  parseQuota,
  sendEmail,
  classifySesError,
};
