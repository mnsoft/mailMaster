'use strict';

/**
 * SMTP 发送层：负责连接、单封投递、错误归类（失败 / 硬退信）。
 * 试运行（dryRun）模式不产生真实投递，用可复现的哈希规则模拟结果，
 * 便于在没有 SMTP 环境时验证整套流程与界面。
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const ses = require('./tencent-ses');
const { render, renderMessage, buildGlobalContext } = require('./template');
const { LOG_STATUS } = require('./db');

/** 硬退信（地址不存在/被拒收）关键词 */
const BOUNCE_PATTERNS = [
  /user unknown/i,
  /unknown user/i,
  /no such user/i,
  /mailbox (not found|unavailable|full|disabled)/i,
  /recipient (address )?(rejected|not found|does not exist)/i,
  /address (rejected|not found)/i,
  /does not exist/i,
  /invalid recipient/i,
  /account (has been )?(disabled|closed)/i,
  /5\.1\.[01]\b/,
  /5\.4\.4\b/,
  /5\.7\.1\b/,
];

const TRANSIENT_PATTERNS = [/timeout/i, /timed out/i, /ETIMEDOUT/i, /ECONNRESET/i, /ESOCKET/i, /throttl/i, /try again/i, /4\.7\.0/i, /rate limit/i];

function hashInt(str) {
  return parseInt(crypto.createHash('md5').update(String(str)).digest('hex').slice(0, 8), 16);
}

/**
 * 归类 SMTP 错误
 * @returns {{ status: string, reason: string, transient: boolean }}
 */
function classifyError(err) {
  const text = [err && err.response, err && err.message, err && err.code].filter(Boolean).join(' | ');
  const code = Number(err && (err.responseCode || err.code)) || 0;

  if (BOUNCE_PATTERNS.some((re) => re.test(text))) {
    return { status: LOG_STATUS.BOUNCED, reason: `硬退信：${text}`, transient: false };
  }
  const transient = code >= 400 && code < 500;
  if (transient || TRANSIENT_PATTERNS.some((re) => re.test(text))) {
    return { status: LOG_STATUS.FAILED, reason: `临时性失败（可重试）：${text}`, transient: true };
  }
  return { status: LOG_STATUS.FAILED, reason: text || '未知错误', transient: false };
}

/**
 * 从传入对象中取出 SMTP 连接参数。
 * 支持两种形态：发信账号对象（含 host/port/secure/user/pass）与旧版 settings（含 smtp 字段）。
 */
function normalizeAccount(input) {
  if (!input) return null;
  if (input.smtp) return Object.assign({}, input.smtp, { fromName: input.smtp.fromName });
  return input;
}

function createTransport(accountOrSettings, timeoutMs = 20000) {
  const account = normalizeAccount(accountOrSettings);
  if (!account || !account.host) throw new Error('未配置 SMTP 服务器地址');
  return nodemailer.createTransport({
    host: account.host,
    port: Number(account.port) || 465,
    secure: account.secure !== false,
    auth: account.user ? { user: account.user, pass: account.pass || '' } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls: { rejectUnauthorized: false },
  });
}

async function verifyTransport(accountOrSettings) {
  const account = normalizeAccount(accountOrSettings);
  const transport = createTransport(account, 12000);
  const started = Date.now();
  try {
    await transport.verify();
    return { ok: true, message: `SMTP 连接与认证成功（${account.email || account.user || account.host}）`, durationMs: Date.now() - started };
  } catch (err) {
    const info = classifyError(err);
    return { ok: false, message: info.reason, durationMs: Date.now() - started };
  } finally {
    try {
      transport.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 纯文本转简易 HTML，保留换行与段落 */
function textToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px;">${block.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * 渲染出最终的收件人邮件内容
 * @param {object} template 模板
 * @param {object} contact 收件人
 * @param {object} settings 全局设置
 * @param {object} extra { account, index, total, now, spintax } —— account 为本封实际使用的发信账号；
 *        spintax 为 { subjectUsed, bodyUsed } 时启用逐封去重（保证同批次措辞尽量不重复）
 */
function renderMail(template, contact, settings, extra = {}) {
  const account = extra.account || null;
  const globals = buildGlobalContext({
    now: extra.now,
    sender: (account && account.fromName) || settings.smtp?.fromName || '',
    senderCompany: settings.senderCompany || '',
    index: extra.index,
    total: extra.total,
  });
  const rendered = renderMessage(template, contact, globals, { spintax: extra.spintax });
  let body = rendered.body;
  if (settings.appendFooter && settings.footerText) {
    body = `${body}\n\n————————————\n${settings.footerText}`;
  }

  // 为腾讯云 SES 模板发送准备变量表：{ 变量名: 替换后的真实内容 }
  const templateData = {};
  for (const raw of rendered.variables || []) {
    if (/^\{\{/.test(raw)) continue;
    const value = render(`{{${raw}}}`, contact, { globals }).text;
    if (value) templateData[raw] = value;
  }

  return {
    to: contact.email,
    subject: rendered.subject || '(无主题)',
    text: body,
    html: textToHtml(body),
    templateData,
    missing: rendered.missing,
    missingText: rendered.missingText,
    variables: rendered.variables,
    spintax: rendered.spintax,
  };
}

/** 试运行模拟结果（可复现：同一邮箱结果固定，便于演示与测试） */
function simulateSend(email) {
  const n = hashInt(email) % 100;
  if (n < 4) return { status: LOG_STATUS.BOUNCED, error: '550 5.1.1 收件人地址不存在（试运行模拟）', messageId: null };
  if (n < 12) return { status: LOG_STATUS.FAILED, error: '421 4.7.0 服务端临时限流（试运行模拟）', messageId: null };
  return { status: LOG_STATUS.SUCCESS, error: '', messageId: `dryrun-${hashInt(email).toString(16)}@mailmaster.local` };
}

/**
 * 发送单封邮件
 * @returns {Promise<{status:string,error:string,messageId:string,missing:string}>}
 */
async function sendMail({ transport, account, settings, mail, dryRun }) {
  const started = Date.now();
  if (dryRun) {
    await new Promise((r) => setTimeout(r, 120 + (hashInt(mail.to) % 180)));
    const sim = simulateSend(mail.to);
    return Object.assign(sim, { durationMs: Date.now() - started, missing: mail.missingText });
  }
  const fromName = (account && account.fromName) || settings.smtp?.fromName;
  const fromEmail = (account && (account.email || account.user)) || settings.smtp?.fromEmail || settings.smtp?.user;
  try {
    const info = await transport.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return {
      status: LOG_STATUS.SUCCESS,
      error: mail.missingText ? `已发送，但${mail.missingText}` : '',
      messageId: info.messageId || '',
      durationMs: Date.now() - started,
      missing: mail.missingText,
    };
  } catch (err) {
    const info = classifyError(err);
    return {
      status: info.status,
      error: info.reason,
      transient: info.transient,
      messageId: '',
      durationMs: Date.now() - started,
      missing: mail.missingText,
    };
  }
}

/**
 * 创建一个发送器：屏蔽 SMTP 与腾讯云邮件推送（SES）的差异。
 * @param {object} account 发信账号
 * @returns {{ provider: string, send: (mail: object) => Promise<object>, close: () => void }}
 */
function createSender(account) {
  if (account && account.provider === 'tencent-ses') {
    return {
      provider: 'tencent-ses',
      async send(mail) {
        const started = Date.now();
        try {
          const res = await ses.sendEmail(account, mail);
          return {
            status: LOG_STATUS.SUCCESS,
            error: mail.missingText ? `已提交，但${mail.missingText}` : '',
            messageId: res.messageId || '',
            requestId: res.requestId || '',
            durationMs: Date.now() - started,
            missing: mail.missingText,
          };
        } catch (err) {
          const info = ses.classifySesError(err);
          return {
            status: info.status,
            error: info.reason,
            transient: info.transient,
            messageId: '',
            durationMs: Date.now() - started,
            missing: mail.missingText,
          };
        }
      },
      close() {
        /* 无长连接需要关闭 */
      },
    };
  }

  const transport = createTransport(account);
  return {
    provider: 'smtp',
    send: (mail) => sendMail({ transport, account, mail, dryRun: false }),
    close() {
      try {
        transport.close();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

/**
 * 该账号需要补充哪些配置（用于执行前校验）
 * @returns {string|null} 缺失说明
 */
function validateAccount(account) {
  if (!account) return '未找到可用的发信邮箱账号';
  if (account.enabled === false) return `发信账号 ${account.email} 已停用`;
  if (account.provider === 'tencent-ses') {
    if (!account.ses || !account.ses.secretId || !account.ses.secretKey) return `腾讯云发信账号 ${account.email} 未配置 SecretId / SecretKey`;
    if ((account.ses.sendMode || 'template') === 'template' && !account.ses.templateId && !account.ses.allowSimple) {
      return `腾讯云发信账号 ${account.email} 未填写发信模板 ID`;
    }
    return null;
  }
  if (!account.host) return `发信账号 ${account.email} 未配置 SMTP 服务器`;
  return null;
}

module.exports = {
  createTransport,
  createSender,
  validateAccount,
  verifyTransport,
  normalizeAccount,
  classifyError,
  renderMail,
  textToHtml,
  sendMail,
  simulateSend,
  BOUNCE_PATTERNS,
};
