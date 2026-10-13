'use strict';

/**
 * 推广内容模板编译引擎
 * 语法：{{变量}}  —— 支持中文标签、英文键名与常见别名，均不区分大小写与首尾空格。
 * 例：尊敬的{{称呼}}{{联系人}}，您好！{{公司名}} —— 我们注意到...
 */

const VAR_PATTERN = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;

/** 联系人可用字段（同时也是 CSV 导入列名） */
const CONTACT_FIELDS = [
  { key: 'company', label: '公司名', aliases: ['公司', '公司名称', '单位', '单位名称', 'company', 'companyname', 'org'] },
  { key: 'contact', label: '联系人', aliases: ['姓名', '名字', '全名', 'contact', 'name', 'contactname'] },
  { key: 'salutation', label: '称呼', aliases: ['尊称', '称谓', '敬称', 'salutation', 'title', 'greeting'] },
  { key: 'email', label: '邮件地址', aliases: ['邮箱', '邮件', '电子邮箱', 'email', 'mail', 'e-mail'] },
  { key: 'phone', label: '电话', aliases: ['手机', '手机号', '联系方式', '座机', 'phone', 'mobile', 'tel'] },
  { key: 'position', label: '职位', aliases: ['职务', '岗位', 'position', 'job'] },
  { key: 'city', label: '城市', aliases: ['所在城市', '地区', 'city', 'region'] },
  { key: 'tags', label: '标签', aliases: ['分组', 'tag', 'group'] },
  { key: 'remark', label: '备注', aliases: ['说明', 'remark', 'note'] },
];

/** 发送时动态生成的全局变量 */
const GLOBAL_FIELDS = [
  { key: '__date', label: '日期', hint: '如 2026-10-12' },
  { key: '__time', label: '时间', hint: '如 10:08' },
  { key: '__year', label: '年份', hint: '如 2026' },
  { key: '__month', label: '月份', hint: '如 10月' },
  { key: '__datetime', label: '日期时间', hint: '如 2026-10-12 10:08' },
  { key: '__sender', label: '发件人', hint: '设置中的发件人姓名' },
  { key: '__senderCompany', label: '发件方公司', hint: '设置中的发件方公司名' },
  { key: '__index', label: '序号', hint: '本批第几封' },
  { key: '__total', label: '总数', hint: '本批总封数' },
];

const ALL_FIELDS = [...CONTACT_FIELDS, ...GLOBAL_FIELDS];

/** 建立 别名(小写去空格) -> 规范 key 的查找表 */
const LOOKUP = (() => {
  const map = new Map();
  for (const field of ALL_FIELDS) {
    map.set(field.key.toLowerCase(), field.key);
    map.set(field.label.toLowerCase(), field.key);
    for (const alias of field.aliases || []) map.set(String(alias).toLowerCase(), field.key);
  }
  return map;
})();

/** 解析模板中出现的变量名，返回规范 key 数组（去重，保留出现顺序） */
function resolveVarName(raw) {
  const cleaned = String(raw).trim().toLowerCase();
  return LOOKUP.get(cleaned) || null;
}

/**
 * 列出模板中使用的变量
 * @returns {{ varName: string, raw: string, known: boolean, label: string }[]}
 */
function listVariables(text) {
  const out = [];
  const seen = new Set();
  if (!text) return out;
  for (const match of String(text).matchAll(VAR_PATTERN)) {
    const raw = match[1].trim();
    const key = resolveVarName(raw);
    const dedupKey = key || `?${raw.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const field = ALL_FIELDS.find((f) => f.key === key);
    out.push({
      raw,
      varName: key || raw,
      known: Boolean(key),
      label: field ? field.label : raw,
      global: key ? key.startsWith('__') : false,
    });
  }
  return out;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 生成发送时刻的全局变量表 */
function buildGlobalContext(extra = {}) {
  const now = extra.now instanceof Date ? extra.now : new Date();
  return {
    __date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    __time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    __year: String(now.getFullYear()),
    __month: `${now.getMonth() + 1}月`,
    __datetime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    __sender: extra.sender || '',
    __senderCompany: extra.senderCompany || '',
    __index: extra.index != null ? String(extra.index) : '',
    __total: extra.total != null ? String(extra.total) : '',
  };
}

/**
 * 渲染模板：把 {{变量}} 替换成收件人对应的真实内容
 * @param {string} text 模板文本
 * @param {object} contact 联系人记录
 * @param {object} options { globals, fallback, strict }
 * @returns {{ text: string, resolved: string[], missing: string[] }}
 */
function render(text, contact = {}, options = {}) {
  const globals = options.globals || buildGlobalContext();
  const fallback = options.fallback != null ? options.fallback : '';
  const resolved = [];
  const missing = [];

  const out = String(text == null ? '' : text).replace(VAR_PATTERN, (full, raw) => {
    const rawName = String(raw).trim();
    const key = resolveVarName(rawName);
    if (!key) {
      missing.push(rawName);
      return fallback;
    }
    let value;
    if (key.startsWith('__')) {
      value = globals[key];
    } else {
      value = contact[key];
      if (key === 'tags' && Array.isArray(value)) value = value.join('、');
    }
    if (value == null || value === '') {
      missing.push(ALL_FIELDS.find((f) => f.key === key)?.label || key);
      return fallback;
    }
    resolved.push(key);
    return String(value);
  });

  return {
    text: out,
    resolved: Array.from(new Set(resolved)),
    missing: Array.from(new Set(missing)),
  };
}

/** 批量渲染主题 + 正文，返回缺失变量概览 */
function renderMessage(template, contact, globals) {
  const subject = render(template.subject || '', contact, { globals });
  const body = render(template.body || '', contact, { globals });
  const variables = Array.from(
    new Set([
      ...listVariables(template.subject || '').map((v) => v.raw),
      ...listVariables(template.body || '').map((v) => v.raw),
    ]),
  );
  const missing = Array.from(new Set([...subject.missing, ...body.missing]));
  return {
    subject: subject.text,
    body: body.text,
    variables,
    missing,
    missingText: missing.length ? `模板变量缺失：${missing.join('、')}` : '',
  };
}

module.exports = {
  CONTACT_FIELDS,
  GLOBAL_FIELDS,
  ALL_FIELDS,
  VAR_PATTERN,
  listVariables,
  render,
  renderMessage,
  buildGlobalContext,
  resolveVarName,
};
