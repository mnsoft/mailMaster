'use strict';

/**
 * 轻量 MIME 解析：为退信识别服务，只实现真正需要的部分。
 *  - 头部展开（unfold）与 RFC 2047 编码字（=?utf-8?B?..?=）解码
 *  - Content-Type 解析与 multipart 递归拆包
 *  - base64 / quoted-printable 解码，支持 gbk / big5 / latin1 等常见字符集
 *  - delivery-status（DSN）字段提取：Final-Recipient / Action / Status / Diagnostic-Code
 *
 * 不引入第三方依赖，避免 Windows 上的原生模块编译问题。
 */

/** 常见字符集 → Buffer 编码 / TextDecoder 标签 */
const CHARSET_ALIASES = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'us-ascii': 'utf-8',
  'ascii': 'utf-8',
  'gb2312': 'gbk',
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'iso-8859-1': 'latin1',
  'latin1': 'latin1',
  'windows-1252': 'windows-1252',
  'ks_c_5601-1987': 'euc-kr',
  'euc-kr': 'euc-kr',
  'shift_jis': 'shift_jis',
  'iso-2022-jp': 'iso-2022-jp',
};

function decodeBuffer(buf, charset) {
  const label = CHARSET_ALIASES[String(charset || '').trim().toLowerCase()] || 'utf-8';
  if (label === 'utf-8') return buf.toString('utf8');
  if (label === 'latin1') return buf.toString('latin1');
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch (_) {
    return buf.toString('utf8');
  }
}

/** RFC 2047 编码字解码 */
function decodeEncodedWords(input) {
  const text = String(input == null ? '' : input);
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (matched, charset, kind, payload) => {
    try {
      const buf =
        kind.toUpperCase() === 'B'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(
              payload
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))),
              'binary',
            );
      return decodeBuffer(buf, charset);
    } catch (_) {
      return matched;
    }
  });
}

/** 解 quoted-printable */
function decodeQuotedPrintable(input) {
  const text = String(input == null ? '' : input);
  const withoutSoftBreaks = text.replace(/=(?:\r\n|\n|\r)/g, '');
  const bytes = [];
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const ch = withoutSoftBreaks[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/** 按 Content-Transfer-Encoding 解码正文为字符串 */
function decodeBody(raw, encoding, charset) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const cleaned = String(raw).replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      return decodeBuffer(Buffer.from(cleaned, 'base64'), charset);
    } catch (_) {
      return String(raw);
    }
  }
  if (enc === 'quoted-printable') {
    return decodeBuffer(decodeQuotedPrintable(raw), charset);
  }
  return decodeBuffer(Buffer.from(String(raw), 'binary'), charset);
}

/** 把原始报文拆成 { headText, bodyBuffer } */
function splitHeadBody(buffer) {
  const idx = buffer.indexOf('\r\n\r\n');
  if (idx >= 0) return { headBuffer: buffer.slice(0, idx), bodyBuffer: buffer.slice(idx + 4) };
  const alt = buffer.indexOf('\n\n');
  if (alt >= 0) return { headBuffer: buffer.slice(0, alt), bodyBuffer: buffer.slice(alt + 2) };
  return { headBuffer: buffer, bodyBuffer: Buffer.alloc(0) };
}

/** 解析头部为有序字段列表 + 取值助手 */
function parseHeaders(headBuffer) {
  const text = headBuffer.toString('utf8').replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  const fields = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:\s]+)\s*:\s*([\s\S]*)$/.exec(line);
    if (m) fields.push({ name: m[1].toLowerCase(), rawName: m[1], value: decodeEncodedWords(m[2].trim()) });
  }
  const get = (name) => {
    const hit = fields.find((f) => f.name === String(name).toLowerCase());
    return hit ? hit.value : '';
  };
  const all = (name) => fields.filter((f) => f.name === String(name).toLowerCase()).map((f) => f.value);
  return { fields, get, all };
}

/** 解析 Content-Type：返回 { type, params } */
function parseContentType(value) {
  const text = String(value || 'text/plain');
  const [main, ...rest] = text.split(';');
  const params = {};
  for (const chunk of rest) {
    const m = /^\s*([\w-]+)\s*=\s*"?([^";]*)"?\s*$/.exec(chunk);
    if (m) params[m[1].toLowerCase()] = m[2];
  }
  return { type: main.trim().toLowerCase() || 'text/plain', params };
}

/** 按 boundary 拆分 multipart 正文 */
function splitMultipart(bodyText, boundary) {
  if (!boundary) return [];
  const marker = `--${boundary}`;
  const lines = bodyText.split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      if (current) parts.push(current.join('\r\n'));
      current = line.startsWith(`${marker}--`) ? null : [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join('\r\n'));
  return parts;
}

/**
 * 递归解析一封邮件
 * @param {Buffer|string} raw
 * @returns {{ headers: object, get: Function, all: Function, contentType: object, text: string, parts: object[] }}
 */
function parseMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'binary');
  const { headBuffer, bodyBuffer } = splitHeadBody(buffer);
  const headers = parseHeaders(headBuffer);
  const contentType = parseContentType(headers.get('content-type'));
  const transferEncoding = headers.get('content-transfer-encoding');
  const charset = contentType.params.charset || 'utf-8';

  const node = { headers, get: headers.get, all: headers.all, contentType, parts: [], text: '' };

  if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
    const bodyText = bodyBuffer.toString('binary');
    for (const part of splitMultipart(bodyText, contentType.params.boundary)) {
      if (!part.trim()) continue;
      node.parts.push(parseMessage(Buffer.from(part, 'binary')));
    }
    return node;
  }

  if (contentType.type === 'message/rfc822' || contentType.type === 'message/delivery-status') {
    // 交付状态报告：本身是若干 field 段落，按文本保留
    node.text = decodeBody(bodyBuffer.toString('binary'), transferEncoding, charset);
    return node;
  }

  node.text = decodeBody(bodyBuffer.toString('binary'), transferEncoding, charset);
  return node;
}

/** 递归收集文本（text/* 与 message/delivery-status 均收集） */
function collectText(node) {
  if (!node) return '';
  const chunks = [];
  const walk = (n) => {
    if (n.text) chunks.push(n.text);
    for (const p of n.parts) walk(p);
  };
  walk(node);
  return chunks.join('\n');
}

/** 递归查找指定 MIME 类型的节点 */
function findParts(node, type) {
  const out = [];
  const walk = (n) => {
    if (n.contentType && n.contentType.type === type) out.push(n);
    for (const p of n.parts) walk(p);
  };
  walk(node);
  return out;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 解析 delivery-status 段落文本为字段表 */
function parseStatusBlock(text) {
  const out = {};
  // DSN 里可能出现多个收件人块，取第一个含 Final-Recipient 的块
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Za-z-]+)\s*:\s*([\s\S]*)$/.exec(line.trim());
      if (!m) continue;
      fields[m[1].toLowerCase()] = m[2].trim();
    }
    if (fields['final-recipient'] || fields.action) {
      Object.assign(out, fields);
      if (fields['final-recipient']) break;
    }
  }
  return out;
}

const BOUNCE_SUBJECT_PATTERNS = [
  /undeliverable/i,
  /delivery\s+(status\s+)?(failure|notification)/i,
  /returned\s+mail/i,
  /failure\s+notice/i,
  /mail\s+delivery\s+failed/i,
  /delivery\s+has\s+failed/i,
  /undelivered\s+mail/i,
  /退信/,
  /投递失败/,
  /无法投递/,
  /发送失败/,
  /邮件退回/,
];

const HARD_BOUNCE_PATTERNS = [
  /user unknown/i,
  /unknown user/i,
  /no such user/i,
  /mailbox (not found|unavailable|full|disabled)/i,
  /recipient (address )?(rejected|not found|does not exist)/i,
  /address (rejected|not found)/i,
  /invalid recipient/i,
  /account (has been )?(disabled|closed|deactivated|suspended)/i,
  /domain (not found|does not exist)/i,
  /does not exist/i,
  /5\.1\.[01]\b/,
  /5\.4\.4\b/,
  /5\.7\.1\b/,
  /5\.2\.2\b/,
];

const BLOCK_PATTERNS = [/spam/i, /blacklist/i, /blocked/i, /5\.7\.[0-9]+\b/, /拒收/];

/**
 * 从解析后的邮件中提取退信信息
 * @returns {{
 *   isBounce: boolean, type: 'hard'|'soft'|'blocked'|null, recipients: string[],
 *   status: string, diagnostic: string, originalMessageId: string,
 *   subject: string, from: string, date: string, reason: string
 * }}
 */
function extractBounce(node) {
  const subject = node.get('subject') || '';
  const from = node.get('from') || '';
  const date = node.get('date') || '';
  const contentType = node.contentType.type;
  const reportType = (node.contentType.params['report-type'] || '').toLowerCase();
  const statusNodes = findParts(node, 'message/delivery-status');
  const text = collectText(node);

  const dash = parseStatusBlock(statusNodes.map((n) => n.text).join('\n\n'));
  const action = String(dash.action || '').toLowerCase();
  const status = String(dash.status || '');
  const diagnostic = String(dash['diagnostic-code'] || dash['remote-mta'] || '');

  const recipients = [];
  const finalRecipient = String(dash['final-recipient'] || dash['original-recipient'] || '');
  if (finalRecipient) {
    const m = finalRecipient.match(EMAIL_PATTERN);
    if (m) recipients.push(...m);
  }
  if (!recipients.length) {
    // 无 DSN 字段时，从正文里找「收件人地址」附近的邮箱
    const tail = text.slice(0, 4000);
    const hits = tail.match(EMAIL_PATTERN) || [];
    for (const hit of hits) {
      const lower = hit.toLowerCase();
      if (/^(mailer-daemon|postmaster|no-?reply|noreply)@/.test(lower)) continue;
      recipients.push(hit);
    }
  }

  const originalMessageId = String(dash['original-message-id'] || '').replace(/^<|>$/g, '');

  const isDsn = reportType === 'delivery-status' || contentType === 'multipart/report' || statusNodes.length > 0;
  const fromLooksAuto = /(mailer-daemon|postmaster|no-?reply|mail-daemon)/i.test(from) || /(mailer-daemon|postmaster)/i.test(node.get('return-path') || '');
  const subjectLooksBounce = BOUNCE_SUBJECT_PATTERNS.some((re) => re.test(subject));
  const bodyLooksBounce = /(delivery\s+status\s+notification|undeliverable|final-recipient|diagnostic-code)/i.test(text.slice(0, 3000));
  const isBounce = (isDsn && (action === 'failed' || status)) || subjectLooksBounce || (fromLooksAuto && bodyLooksBounce);

  let type = null;
  if (isBounce) {
    const probe = `${status} ${diagnostic} ${text.slice(0, 3000)}`;
    if (/^4\./.test(status) || action === 'delayed' || /delayed/i.test(diagnostic)) type = 'soft';
    else if (BLOCK_PATTERNS.some((re) => re.test(probe))) type = 'blocked';
    else if (/^5\./.test(status) || HARD_BOUNCE_PATTERNS.some((re) => re.test(probe)) || action === 'failed') type = 'hard';
    else type = 'hard';
  }

  const reason = [
    status ? `状态码 ${status}` : '',
    action ? `动作 ${action}` : '',
    diagnostic ? diagnostic.replace(/\s+/g, ' ').slice(0, 240) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    isBounce,
    type: isBounce ? type || 'hard' : null,
    recipients: Array.from(new Set(recipients.map((r) => r.trim().toLowerCase()))).filter(Boolean),
    status,
    diagnostic: diagnostic.replace(/\s+/g, ' ').slice(0, 500),
    originalMessageId,
    subject,
    from,
    date,
    reason,
    text,
  };
}

module.exports = {
  parseMessage,
  collectText,
  findParts,
  extractBounce,
  decodeEncodedWords,
  decodeBody,
  parseContentType,
  parseHeaders,
  EMAIL_PATTERN,
  BOUNCE_SUBJECT_PATTERNS,
};
