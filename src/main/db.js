'use strict';

/**
 * 数据层：联系人 / 模板 / 推广任务 / 投递日志 / 设置 / 统计
 * 全部落在单个 JSON 文件，避免 Windows 上的原生模块编译问题。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JsonStore } = require('./store');
const { scheduleNextRun } = require('./scheduler');

const LOG_STATUS = {
  PENDING: 'pending',
  SENDING: 'sending',
  SUCCESS: 'success',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  SKIPPED: 'skipped',
};

const LOG_STATUS_TEXT = {
  pending: '待发送',
  sending: '发送中',
  success: '成功',
  failed: '失败',
  bounced: '退信',
  skipped: '已跳过',
};

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_HEADER = ['公司名', '联系人', '称呼', '邮件地址', '电话', '职位', '城市', '标签', '备注'];

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(contacts) {
  const lines = [CSV_HEADER.join(',')];
  for (const c of contacts) {
    lines.push(
      [
        c.company,
        c.contact,
        c.salutation,
        c.email,
        c.phone,
        c.position,
        c.city,
        Array.isArray(c.tags) ? c.tags.join('|') : c.tags,
        c.remark,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `\ufeff${lines.join('\r\n')}`;
}

/** 支持逗号/制表符分隔、双引号包裹、BOM 头 */
function parseCsv(text) {
  const content = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let delimiter = ',';

  const firstLine = content.split(/\r?\n/)[0] || '';
  if (firstLine.includes('\t') && !firstLine.includes(',')) delimiter = '\t';

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

const HEADER_ALIASES = {
  company: ['公司名', '公司', '公司名称', '单位', '单位名称', 'company'],
  contact: ['联系人', '姓名', '名字', 'contact', 'name'],
  salutation: ['称呼', '尊称', '称谓', 'salutation'],
  email: ['邮件地址', '邮箱', '邮件', '电子邮箱', 'email', 'mail'],
  phone: ['电话', '手机', '手机号', '座机', 'phone', 'mobile', 'tel'],
  position: ['职位', '职务', '岗位', 'position'],
  city: ['城市', '地区', 'city'],
  tags: ['标签', '分组', 'tag', 'group', 'tags'],
  remark: ['备注', '说明', 'remark', 'note'],
};

function mapHeader(headerCell) {
  const cleaned = String(headerCell || '').trim().toLowerCase();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === cleaned)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

function seedData() {
  const companies = [
    ['深圳市云图智能科技有限公司', '张明远', '张总', 'zhangmingyuan@yuntu-ai.com', '13802345678', '采购总监', '深圳', ['重点客户']],
    ['上海恒信贸易有限公司', '李婉如', '李经理', 'liwanru@hengxin-trade.cn', '13901234567', '外贸部经理', '上海', ['重点客户', '华东']],
    ['杭州蓝湖软件股份有限公司', '王海涛', '王工', 'wanghaitao@lanhu-soft.com', '13600998877', '技术负责人', '杭州', ['技术型']],
    ['北京博远医疗器械有限公司', '陈静', '陈主任', 'chenjing@boyuan-med.cn', '13511223344', '院方采购', '北京', ['医疗行业']],
    ['广州南方物流集团', '刘建国', '刘总', 'liujianguo@nf-logistics.com', '13722334455', '运营副总', '广州', ['物流']],
    ['成都天府教育科技有限公司', '赵雪', '赵老师', 'zhaoxue@tianfu-edu.cn', '13833445566', '市场主管', '成都', ['教育行业']],
    ['苏州精工机械制造有限公司', '孙立成', '孙厂长', 'sunlicheng@jinggong-mc.com', '13944556677', '厂长', '苏州', ['制造业']],
    ['武汉长江数据服务有限公司', '周雨薇', '周经理', 'zhouyuwei@cjdata.com.cn', '13655667788', '商务经理', '武汉', ['待跟进']],
  ];

  const contacts = companies.map(([company, contact, salutation, email, phone, position, city, tags], i) => {
    const stats = { attempts: 0, success: 0, failed: 0, bounced: 0 };
    return {
      id: uid('ct'),
      company,
      contact,
      salutation,
      email,
      phone,
      position,
      city,
      tags,
      remark: '',
      subscribed: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stats,
      lastStatus: null,
      lastSentAt: null,
      sortIndex: i,
    };
  });

  const templates = [
    {
      id: uid('tpl'),
      name: '标准产品推广（中文）',
      subject: '{{公司名}} · 关于智能采集方案的沟通（{{联系人}}）',
      body: [
        '尊敬的{{称呼}}{{联系人}}：',
        '',
        '您好！我是{{发件方公司}}的{{发件人}}。',
        '',
        '了解到{{公司名}}在{{城市}}的业务发展，我们近期为同行业客户落地的「智能数据采集与自动化处理方案」或许对您有帮助：',
        '',
        '· 采集效率提升 3 倍以上，人工成本下降约 40%',
        '· 支持与现有系统无缝对接，7 天即可完成部署',
        '· 提供 30 天免费试用与专属技术支持',
        '',
        '如果方便，我可以在本周内为您安排一次 20 分钟的线上演示。您看什么时间合适？',
        '',
        '期待与{{公司名}}的合作。',
        '',
        '{{发件人}}',
        '{{发件方公司}}',
        '{{日期}}',
      ].join('\n'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: uid('tpl'),
      name: '简短跟进（老客户）',
      subject: '{{联系人}}您好，{{公司名}}的方案跟进',
      body: [
        '{{称呼}}{{联系人}}，您好：',
        '',
        '上次与您沟通的方案已更新到最新版本，其中针对{{公司名}}关注的成本问题做了优化。',
        '方便的话我给您发一份最新资料，您电话{{电话}}是否仍可联系？',
        '',
        '顺祝商祺！',
        '{{发件人}} · {{发件方公司}}',
        '{{日期时间}}',
      ].join('\n'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  const accounts = [
    {
      id: uid('acc'),
      name: '市场部主发信账号（普通邮箱 SMTP）',
      provider: 'smtp',
      email: 'marketing@example.com',
      user: 'marketing@example.com',
      pass: '',
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      fromName: '市场部 · 王小明',
      remark: '常规产品推广使用',
      enabled: true,
      isDefault: true,
      dailyLimit: 200,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: uid('acc'),
      name: '客户成功部（老客户跟进）',
      provider: 'smtp',
      email: 'service@example.com',
      user: 'service@example.com',
      pass: '',
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      fromName: '客户成功部 · 李静',
      remark: '老客户关怀与续约提醒使用',
      enabled: true,
      isDefault: false,
      dailyLimit: 100,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: uid('acc'),
      name: '腾讯云邮件推送（营销专用）',
      provider: 'tencent-ses',
      email: 'noreply@mail.example.com',
      user: '',
      pass: '',
      host: '',
      port: 465,
      secure: true,
      fromName: '示例智能科技',
      remark: '通过腾讯云 SES 发送，官方通道更稳定，自带免费额度',
      enabled: true,
      isDefault: false,
      dailyLimit: 1000,
      ses: {
        secretId: '',
        secretKey: '',
        region: 'ap-guangzhou',
        site: 'cn',
        host: '',
        templateId: '',
        replyTo: '',
        unsubscribe: '2',
        headerFrom: '',
        sendMode: 'template',
        allowSimple: false,
        freeQuotaTotal: 1000,
        templateMap: '',
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  const campaigns = [
    {
      id: uid('cp'),
      name: '10月常规推广（每月 1 / 15 日）',
      description: '每月固定两次向全部有效客户发送标准产品推广',
      templateId: templates[0].id,
      accountId: accounts[0].id,
      kind: 'scheduled',
      schedule: { type: 'monthly', days: [1, 15], time: '09:30' },
      audience: { mode: 'all', tags: [], ids: [] },
      throttle: { intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 },
      dryRun: true,
      status: 'paused',
      runCount: 0,
      lastRunAt: null,
      nextRunAt: null,
      progress: { total: 0, done: 0, success: 0, failed: 0, bounced: 0, startedAt: null, finishedAt: null },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: uid('cp'),
      name: '临时任务：医疗行业定向触达',
      description: '手动触发的临时推广，仅发送给「医疗行业」标签客户',
      templateId: templates[1].id,
      accountId: accounts[1].id,
      kind: 'manual',
      schedule: { type: 'manual' },
      audience: { mode: 'tags', tags: ['医疗行业'], ids: [] },
      throttle: { intervalSeconds: 5, dailyLimit: 100, maxRetries: 2 },
      dryRun: true,
      status: 'draft',
      runCount: 0,
      lastRunAt: null,
      nextRunAt: null,
      progress: { total: 0, done: 0, success: 0, failed: 0, bounced: 0, startedAt: null, finishedAt: null },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  const campaign = campaigns[1];
  const logs = [];
  let cursor = Date.now() - 9 * 24 * 3600 * 1000;
  for (let i = 0; i < contacts.length; i += 1) {
    const c = contacts[i];
    const roll = i % 8;
    const status = roll === 5 ? LOG_STATUS.FAILED : roll === 7 ? LOG_STATUS.BOUNCED : LOG_STATUS.SUCCESS;
    cursor += 37 * 60 * 1000;
    const ts = new Date(cursor).toISOString();
    logs.push({
      id: uid('lg'),
      campaignId: campaign.id,
      campaignName: campaign.name,
      accountId: campaign.accountId,
      accountEmail: accounts[1].email,
      accountName: accounts[1].name,
      contactId: c.id,
      company: c.company,
      contact: c.contact,
      salutation: c.salutation,
      email: c.email,
      subject: `【历史记录】致 ${c.company} 的产品方案`,
      status,
      error: status === LOG_STATUS.FAILED ? 'SMTP 超时：连接 smtp.example.com:465 超时' : status === LOG_STATUS.BOUNCED ? '550 5.1.1 收件人地址不存在（用户不存在）' : '',
      attempts: status === LOG_STATUS.SUCCESS ? 1 : 2,
      createdAt: ts,
      finishedAt: ts,
      durationMs: 480 + i * 23,
      dryRun: false,
    });
    c.stats.attempts += 1;
    if (status === LOG_STATUS.SUCCESS) c.stats.success += 1;
    else if (status === LOG_STATUS.FAILED) c.stats.failed += 1;
    else c.stats.bounced += 1;
    c.lastStatus = status;
    c.lastSentAt = ts;
  }

  const counters = {
    totalRuns: 3,
    totalAttempts: logs.length,
    success: logs.filter((l) => l.status === LOG_STATUS.SUCCESS).length,
    failed: logs.filter((l) => l.status === LOG_STATUS.FAILED).length,
    bounced: logs.filter((l) => l.status === LOG_STATUS.BOUNCED).length,
  };

  return {
    version: 1,
    seededAt: nowIso(),
    settings: {
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'marketing@example.com',
        pass: '',
        fromName: '市场部 · 王小明',
        fromEmail: 'marketing@example.com',
      },
      senderCompany: '示例智能科技有限公司',
      sendMode: 'dryRun',
      defaultThrottle: { intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 },
      bounceAutoPause: true,
      bouncePauseThreshold: 5,
      appendFooter: true,
      footerText: '如不希望再收到此类邮件，请回复「退订」，我们将立即为您移除。',
      logRetentionDays: 180,
    },
    contacts,
    templates,
    accounts,
    campaigns,
    logs,
    counters,
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class Database {
  constructor() {
    this.store = null;
  }

  init(userDataDir) {
    const file = path.join(userDataDir, 'mailmaster-data.json');
    this.store = new JsonStore(file, seedData);
    this.store.load();
    const data = this.store.get();
    // 结构兜底，兼容旧版本数据文件
    data.contacts = data.contacts || [];
    data.templates = data.templates || [];
    data.campaigns = data.campaigns || [];
    data.logs = data.logs || [];
    data.accounts = data.accounts || [];
    data.counters = data.counters || { totalRuns: 0, totalAttempts: 0, success: 0, failed: 0, bounced: 0 };
    data.settings = Object.assign(seedData().settings, data.settings || {});
    this.migrateLegacySmtp();
    return data;
  }

  /**
   * 兼容旧数据：早期版本只有单一 SMTP 配置（settings.smtp），
   * 这里自动把它迁移成一条「发信邮箱账号」，避免升级后配置丢失。
   */
  migrateLegacySmtp() {
    const data = this.data;
    if (data.accounts.length) return;
    const smtp = data.settings.smtp || {};
    if (!smtp.host) return;
    data.accounts.push({
      id: uid('acc'),
      name: '默认发信账号（由旧版配置迁移）',
      email: smtp.fromEmail || smtp.user || '',
      user: smtp.user || '',
      pass: smtp.pass || '',
      host: smtp.host,
      port: smtp.port || 465,
      secure: smtp.secure !== false,
      fromName: smtp.fromName || '',
      remark: '',
      enabled: true,
      isDefault: true,
      dailyLimit: (data.settings.defaultThrottle && data.settings.defaultThrottle.dailyLimit) || 200,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    console.log('[db] 已将旧版 SMTP 配置迁移为发信邮箱账号');
    this.store.saveThrottled(100);
  }

  get data() {
    return this.store.get();
  }

  flush() {
    if (this.store) this.store.flush();
  }

  // ---------------- settings ----------------
  getSettings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch || {});
    this.store.saveThrottled(200);
    return this.data.settings;
  }

  // ---------------- 发信邮箱账号 ----------------
  listAccounts() {
    return this.data.accounts;
  }

  getAccount(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  /** 解析某个任务实际使用的发信账号：指定账号 → 默认账号 → 第一个启用账号 → null */
  resolveSendingAccount(accountId) {
    const list = this.data.accounts;
    if (!list.length) return null;
    if (accountId) {
      const hit = list.find((a) => a.id === accountId);
      if (hit) return hit;
    }
    return list.find((a) => a.isDefault && a.enabled !== false) || list.find((a) => a.enabled !== false) || list[0];
  }

  saveAccount(input) {
    const email = String(input.email || '').trim();
    if (!email) throw new Error('发信邮箱地址不能为空');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`发信邮箱地址格式不正确：${email}`);

    const provider = input.provider === 'tencent-ses' ? 'tencent-ses' : 'smtp';

    if (provider === 'smtp') {
      if (!String(input.host || '').trim()) throw new Error('SMTP 服务器地址不能为空');
    } else {
      const ses = input.ses || {};
      if (!String(ses.secretId || '').trim() || !String(ses.secretKey || '').trim()) {
        throw new Error('腾讯云邮件推送需要填写 SecretId 与 SecretKey');
      }
      const usingTemplate = (ses.sendMode || 'template') === 'template';
      if (usingTemplate && !String(ses.templateId || '').trim()) {
        throw new Error('腾讯云 SES 默认使用模板发送，请填写已审核通过的发信模板 ID（或在控制台申请 HTML 直发权限后改用直发模式）');
      }
    }

    const duplicate = this.data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase() && a.id !== input.id);
    if (duplicate) throw new Error(`该发信邮箱已存在：${email}`);

    const payload = {
      name: String(input.name || '').trim() || `${email} 发信账号`,
      provider,
      email,
      user: input.user || email,
      pass: input.pass || '',
      host: String(input.host || '').trim(),
      port: Number(input.port) || 465,
      secure: input.secure !== false,
      fromName: input.fromName || '',
      remark: input.remark || '',
      enabled: input.enabled !== false,
      dailyLimit: Number(input.dailyLimit) || 0,
      ses:
        provider === 'tencent-ses'
          ? {
              secretId: String(input.ses?.secretId || '').trim(),
              secretKey: String(input.ses?.secretKey || '').trim(),
              region: input.ses?.region || 'ap-guangzhou',
              site: input.ses?.site === 'intl' ? 'intl' : 'cn',
              host: input.ses?.host || '',
              templateId: String(input.ses?.templateId || '').trim(),
              replyTo: input.ses?.replyTo || '',
              unsubscribe: input.ses?.unsubscribe != null ? String(input.ses.unsubscribe) : '2',
              headerFrom: input.ses?.headerFrom || '',
              sendMode: input.ses?.sendMode === 'html' ? 'html' : 'template',
              allowSimple: !!input.ses?.allowSimple,
              freeQuotaTotal: Number(input.ses?.freeQuotaTotal) || 1000,
              templateMap: input.ses?.templateMap || '',
            }
          : undefined,
    };
    if (provider === 'smtp') delete payload.ses;

    let account;
    if (input.id) {
      account = this.getAccount(input.id);
      if (!account) throw new Error('发信账号不存在');
      const wasDefault = account.isDefault;
      Object.assign(account, payload, { updatedAt: nowIso(), isDefault: wasDefault });
      if (wasDefault) this.ensureSingleDefault(account.id);
    } else {
      account = Object.assign({ id: uid('acc'), isDefault: false, createdAt: nowIso(), updatedAt: nowIso() }, payload);
      this.data.accounts.push(account);
      // 第一个账号自动设为默认
      if (this.data.accounts.filter((a) => a.isDefault).length === 0) this.ensureSingleDefault(account.id);
    }

    this.store.saveThrottled(200);
    return account;
  }

  ensureSingleDefault(id) {
    for (const a of this.data.accounts) a.isDefault = a.id === id;
    this.store.saveThrottled(200);
  }

  setDefaultAccount(id) {
    const account = this.getAccount(id);
    if (!account) throw new Error('发信账号不存在');
    if (account.enabled === false) throw new Error('该账号已停用，启用后才能设为默认');
    this.ensureSingleDefault(id);
    return account;
  }

  removeAccount(id) {
    const used = this.data.campaigns.filter((c) => c.accountId === id);
    if (used.length) throw new Error(`该发信账号正被 ${used.length} 个推广任务使用，请先为这些任务更换发信账号`);
    const account = this.getAccount(id);
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (account && account.isDefault && this.data.accounts.length) this.ensureSingleDefault(this.data.accounts[0].id);
    this.store.saveThrottled(200);
    return true;
  }

  /** 某账号今日已真实发送量（用于按账号控制日发送量） */
  accountUsageToday(email) {
    if (!email) return 0;
    const key = new Date().toISOString().slice(0, 10);
    return this.data.logs.filter(
      (l) =>
        l.accountEmail &&
        l.accountEmail.toLowerCase() === String(email).toLowerCase() &&
        String(l.createdAt || '').slice(0, 10) === key &&
        !l.dryRun &&
        l.status !== LOG_STATUS.PENDING &&
        l.status !== LOG_STATUS.SKIPPED,
    ).length;
  }

  /** 某账号本月已真实发送量 */
  accountUsageMonth(email) {
    if (!email) return 0;
    const month = new Date().toISOString().slice(0, 7);
    return this.data.logs.filter(
      (l) =>
        l.accountEmail &&
        l.accountEmail.toLowerCase() === String(email).toLowerCase() &&
        String(l.createdAt || '').slice(0, 7) === month &&
        !l.dryRun &&
        l.status !== LOG_STATUS.PENDING &&
        l.status !== LOG_STATUS.SKIPPED,
    ).length;
  }

  /** 某账号累计已真实发送量 */
  accountUsageTotal(email) {
    if (!email) return 0;
    return this.data.logs.filter(
      (l) =>
        l.accountEmail &&
        l.accountEmail.toLowerCase() === String(email).toLowerCase() &&
        !l.dryRun &&
        l.status !== LOG_STATUS.PENDING &&
        l.status !== LOG_STATUS.SKIPPED,
    ).length;
  }

  /** 各账号累计投递统计（含今日 / 本月用量与免费额度估算） */
  accountStats() {
    return this.data.accounts.map((a) => {
      const logs = this.data.logs.filter((l) => l.accountEmail && l.accountEmail.toLowerCase() === a.email.toLowerCase() && !l.dryRun);
      const totalUsed = this.accountUsageTotal(a.email);
      const freeTotal = a.provider === 'tencent-ses' ? Number(a.ses?.freeQuotaTotal) || 1000 : 0;
      return {
        id: a.id,
        email: a.email,
        provider: a.provider || 'smtp',
        total: logs.length,
        success: logs.filter((l) => l.status === LOG_STATUS.SUCCESS).length,
        failed: logs.filter((l) => l.status === LOG_STATUS.FAILED).length,
        bounced: logs.filter((l) => l.status === LOG_STATUS.BOUNCED).length,
        todayUsed: this.accountUsageToday(a.email),
        monthUsed: this.accountUsageMonth(a.email),
        totalUsed,
        freeQuotaTotal: freeTotal,
        // 本地估算的免费额度剩余（真实剩余以腾讯云控制台/套餐包接口为准）
        freeQuotaRemaining: freeTotal ? Math.max(0, freeTotal - totalUsed) : null,
      };
    });
  }

  // ---------------- contacts ----------------
  listContacts(filter = {}) {
    let list = [...this.data.contacts];
    const keyword = (filter.keyword || '').trim().toLowerCase();
    if (keyword) {
      list = list.filter((c) =>
        [c.company, c.contact, c.salutation, c.email, c.phone, c.position, c.city, (c.tags || []).join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(keyword),
      );
    }
    if (filter.tag) list = list.filter((c) => (c.tags || []).includes(filter.tag));
    if (filter.status === 'hasBounce') list = list.filter((c) => (c.stats?.bounced || 0) > 0);
    if (filter.status === 'unsubscribed') list = list.filter((c) => c.subscribed === false);
    if (filter.status === 'active') list = list.filter((c) => c.subscribed !== false);
    return list;
  }

  getContact(id) {
    return this.data.contacts.find((c) => c.id === id) || null;
  }

  saveContact(input) {
    const data = this.data;
    const email = String(input.email || '').trim();
    if (!email) throw new Error('邮件地址不能为空');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`邮件地址格式不正确：${email}`);

    const duplicate = data.contacts.find((c) => c.email.toLowerCase() === email.toLowerCase() && c.id !== input.id);
    if (duplicate) throw new Error(`邮件地址已存在于列表中：${email}（${duplicate.company} / ${duplicate.contact}）`);

    if (input.id) {
      const target = this.getContact(input.id);
      if (!target) throw new Error('联系人不存在');
      Object.assign(target, {
        company: input.company || '',
        contact: input.contact || '',
        salutation: input.salutation || '',
        email,
        phone: input.phone || '',
        position: input.position || '',
        city: input.city || '',
        tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[|,、]/).filter(Boolean),
        remark: input.remark || '',
        subscribed: input.subscribed !== false,
        updatedAt: nowIso(),
      });
      this.store.saveThrottled(200);
      return target;
    }

    const created = {
      id: uid('ct'),
      company: input.company || '',
      contact: input.contact || '',
      salutation: input.salutation || '',
      email,
      phone: input.phone || '',
      position: input.position || '',
      city: input.city || '',
      tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[|,、]/).filter(Boolean),
      remark: input.remark || '',
      subscribed: input.subscribed !== false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stats: { attempts: 0, success: 0, failed: 0, bounced: 0 },
      lastStatus: null,
      lastSentAt: null,
    };
    data.contacts.push(created);
    this.store.saveThrottled(200);
    return created;
  }

  removeContacts(ids) {
    const set = new Set(ids);
    const before = this.data.contacts.length;
    this.data.contacts = this.data.contacts.filter((c) => !set.has(c.id));
    this.store.saveThrottled(200);
    return before - this.data.contacts.length;
  }

  importContacts(rows, options = {}) {
    const result = { added: 0, updated: 0, skipped: 0, errors: [] };
    for (const row of rows) {
      const email = String(row.email || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        result.skipped += 1;
        if (result.errors.length < 20) result.errors.push(`第 ${row.__line || '?'} 行：邮件地址无效（${email || '空'}）`);
        continue;
      }
      const existing = this.data.contacts.find((c) => c.email.toLowerCase() === email.toLowerCase());
      if (existing) {
        if (options.mode === 'overwrite') {
          this.saveContact(Object.assign({}, existing, row, { id: existing.id, email }));
          result.updated += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }
      this.saveContact(row);
      result.added += 1;
    }
    this.store.saveThrottled(100);
    return result;
  }

  importContactsFromCsv(text, options) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0, updated: 0, skipped: 0, errors: ['文件内容为空'] };
    const hasHeader = rows[0].some((cell) => mapHeader(cell));
    const startIndex = hasHeader ? 1 : 0;
    const keys = hasHeader ? rows[0].map(mapHeader) : ['company', 'contact', 'salutation', 'email', 'phone', 'position', 'city', 'tags', 'remark'];
    const mapped = [];
    for (let i = startIndex; i < rows.length; i += 1) {
      const obj = { __line: i + 1 };
      keys.forEach((key, col) => {
        if (!key) return;
        const raw = String(rows[i][col] == null ? '' : rows[i][col]).trim();
        obj[key] = key === 'tags' ? raw.split(/[|,、]/).map((s) => s.trim()).filter(Boolean) : raw;
      });
      if (obj.email) mapped.push(obj);
    }
    return this.importContacts(mapped, options);
  }

  exportContactsCsv(filter) {
    return toCsv(this.listContacts(filter));
  }

  allTags() {
    const set = new Set();
    for (const c of this.data.contacts) (c.tags || []).forEach((t) => set.add(t));
    return Array.from(set);
  }

  // ---------------- templates ----------------
  listTemplates() {
    return this.data.templates;
  }

  getTemplate(id) {
    return this.data.templates.find((t) => t.id === id) || null;
  }

  saveTemplate(input) {
    if (!String(input.name || '').trim()) throw new Error('模板名称不能为空');
    if (input.id) {
      const tpl = this.getTemplate(input.id);
      if (!tpl) throw new Error('模板不存在');
      Object.assign(tpl, {
        name: input.name,
        subject: input.subject || '',
        body: input.body || '',
        updatedAt: nowIso(),
      });
      this.store.saveThrottled(200);
      return tpl;
    }
    const created = {
      id: uid('tpl'),
      name: input.name,
      subject: input.subject || '',
      body: input.body || '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.templates.push(created);
    this.store.saveThrottled(200);
    return created;
  }

  removeTemplate(id) {
    const used = this.data.campaigns.filter((c) => c.templateId === id);
    if (used.length) throw new Error(`该模板正被 ${used.length} 个推广任务使用，请先解除关联`);
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    this.store.saveThrottled(200);
    return true;
  }

  // ---------------- campaigns ----------------
  listCampaigns() {
    return this.data.campaigns;
  }

  getCampaign(id) {
    return this.data.campaigns.find((c) => c.id === id) || null;
  }

  saveCampaign(input) {
    if (!String(input.name || '').trim()) throw new Error('任务名称不能为空');
    const payload = {
      name: input.name,
      description: input.description || '',
      templateId: input.templateId || null,
      accountId: input.accountId || null,
      kind: input.kind === 'manual' ? 'manual' : 'scheduled',
      schedule: input.schedule || { type: 'manual' },
      audience: input.audience || { mode: 'all', tags: [], ids: [] },
      throttle: Object.assign({ intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 }, input.throttle || {}),
      dryRun: input.dryRun !== false,
      status: input.status || 'draft',
    };

    if (payload.id) delete payload.id;

    let campaign;
    if (input.id) {
      campaign = this.getCampaign(input.id);
      if (!campaign) throw new Error('任务不存在');
      Object.assign(campaign, payload, { updatedAt: nowIso() });
    } else {
      campaign = Object.assign(
        {
          id: uid('cp'),
          runCount: 0,
          lastRunAt: null,
          nextRunAt: null,
          progress: { total: 0, done: 0, success: 0, failed: 0, bounced: 0, startedAt: null, finishedAt: null },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        payload,
      );
      this.data.campaigns.push(campaign);
    }

    if (campaign.kind === 'manual' && campaign.schedule.type === 'manual') campaign.nextRunAt = null;
    else campaign.nextRunAt = scheduleNextRun(campaign.schedule, new Date())?.toISOString() || null;

    this.store.saveThrottled(200);
    return campaign;
  }

  removeCampaign(id) {
    this.data.campaigns = this.data.campaigns.filter((c) => c.id !== id);
    this.store.saveThrottled(200);
    return true;
  }

  /** 命中受众的联系人（自动排除已退订者） */
  resolveAudience(audience = {}) {
    const all = this.data.contacts.filter((c) => c.subscribed !== false);
    if (audience.mode === 'tags' && Array.isArray(audience.tags) && audience.tags.length) {
      return all.filter((c) => (c.tags || []).some((t) => audience.tags.includes(t)));
    }
    if (audience.mode === 'ids' && Array.isArray(audience.ids) && audience.ids.length) {
      const set = new Set(audience.ids);
      return all.filter((c) => set.has(c.id));
    }
    return all;
  }

  // ---------------- logs ----------------
  addLog(entry) {
    const log = Object.assign(
      {
        id: uid('lg'),
        status: LOG_STATUS.PENDING,
        error: '',
        attempts: 0,
        createdAt: nowIso(),
        finishedAt: null,
        durationMs: 0,
        dryRun: false,
      },
      entry,
    );
    this.data.logs.unshift(log);
    this.store.saveThrottled();
    return log;
  }

  updateLog(id, patch) {
    const log = this.data.logs.find((l) => l.id === id);
    if (!log) return null;
    Object.assign(log, patch);
    this.store.saveThrottled();
    return log;
  }

  getLog(id) {
    return this.data.logs.find((l) => l.id === id) || null;
  }

  listLogs(query = {}) {
    let list = this.data.logs;
    if (query.campaignId) list = list.filter((l) => l.campaignId === query.campaignId);
    if (query.status && query.status !== 'all') list = list.filter((l) => l.status === query.status);
    if (query.contactId) list = list.filter((l) => l.contactId === query.contactId);
    const keyword = (query.keyword || '').trim().toLowerCase();
    if (keyword) {
      list = list.filter((l) =>
        [l.company, l.contact, l.email, l.subject, l.error].join(' ').toLowerCase().includes(keyword),
      );
    }
    const total = list.length;
    const offset = query.offset || 0;
    const limit = query.limit || 100;
    return { total, items: list.slice(offset, offset + limit) };
  }

  exportLogsCsv(query) {
    const { items } = this.listLogs(Object.assign({ limit: 100000 }, query));
    const header = ['时间', '任务', '发信账号', '公司名', '联系人', '邮件地址', '主题', '状态', '失败原因', '尝试次数', '耗时(ms)', '模式'];
    const lines = [header.join(',')];
    for (const l of items) {
      lines.push(
        [
          l.createdAt,
          l.campaignName,
          l.accountEmail || '',
          l.company,
          l.contact,
          l.email,
          l.subject,
          LOG_STATUS_TEXT[l.status] || l.status,
          l.error,
          l.attempts,
          l.durationMs,
          l.dryRun ? '试运行' : '真实发送',
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    return `\ufeff${lines.join('\r\n')}`;
  }

  /** 依据投递结果更新联系人统计 */
  applyContactResult(contactId, status) {
    const c = this.getContact(contactId);
    if (!c) return;
    c.stats = c.stats || { attempts: 0, success: 0, failed: 0, bounced: 0 };
    c.stats.attempts += 1;
    if (status === LOG_STATUS.SUCCESS) c.stats.success += 1;
    else if (status === LOG_STATUS.BOUNCED) c.stats.bounced += 1;
    else if (status === LOG_STATUS.FAILED) c.stats.failed += 1;
    c.lastStatus = status;
    c.lastSentAt = nowIso();
    if (status === LOG_STATUS.BOUNCED) c.subscribed = false; // 硬退信自动移入黑名单
    this.store.saveThrottled();
  }

  markContactBounced(id, note) {
    const c = this.getContact(id);
    if (!c) throw new Error('联系人不存在');
    c.stats = c.stats || { attempts: 0, success: 0, failed: 0, bounced: 0 };
    c.stats.bounced += 1;
    c.lastStatus = LOG_STATUS.BOUNCED;
    c.subscribed = false;
    c.remark = note ? `${c.remark ? `${c.remark} / ` : ''}手动标记退信：${note}` : c.remark;
    this.bumpCounters({ bounced: 1 });
    this.store.saveThrottled(100);
    return c;
  }

  // ---------------- counters & stats ----------------
  bumpCounters(patch = {}) {
    const c = this.data.counters;
    c.totalAttempts = (c.totalAttempts || 0) + (patch.attempts || 0);
    c.success = (c.success || 0) + (patch.success || 0);
    c.failed = (c.failed || 0) + (patch.failed || 0);
    c.bounced = (c.bounced || 0) + (patch.bounced || 0);
    c.totalRuns = (c.totalRuns || 0) + (patch.runs || 0);
    this.store.saveThrottled();
    return c;
  }

  recomputeCounters() {
    const logs = this.data.logs.filter((l) => !l.dryRun);
    const counters = {
      totalRuns: this.data.counters.totalRuns || 0,
      totalAttempts: logs.length,
      success: logs.filter((l) => l.status === LOG_STATUS.SUCCESS).length,
      failed: logs.filter((l) => l.status === LOG_STATUS.FAILED).length,
      bounced: logs.filter((l) => l.status === LOG_STATUS.BOUNCED).length,
    };
    this.data.counters = counters;
    this.store.saveThrottled(100);
    return counters;
  }

  /** 总览页数据 */
  overview() {
    const data = this.data;
    const c = data.counters;
    const activeCampaigns = data.campaigns.filter((x) => x.status === 'active' && x.schedule.type !== 'manual');
    const runningCampaigns = data.campaigns.filter((x) => x.running);
    const nextTimes = data.campaigns
      .filter((x) => x.status === 'active' && x.nextRunAt)
      .map((x) => ({ id: x.id, name: x.name, nextRunAt: x.nextRunAt }))
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));

    const emails = new Set(data.contacts.map((x) => (x.email || '').toLowerCase()).filter(Boolean));
    return {
      userCount: data.contacts.length,
      uniqueEmailCount: emails.size,
      activeContactCount: data.contacts.filter((x) => x.subscribed !== false).length,
      bouncedContactCount: data.contacts.filter((x) => (x.stats?.bounced || 0) > 0).length,
      totalAttempts: c.totalAttempts || 0,
      successCount: c.success || 0,
      failedCount: c.failed || 0,
      bouncedCount: c.bounced || 0,
      campaignCount: data.campaigns.length,
      activeCampaignCount: activeCampaigns.length,
      runningCampaignCount: runningCampaigns.length,
      totalRuns: c.totalRuns || 0,
      templateCount: data.templates.length,
      accountCount: data.accounts.length,
      accountEnabledCount: data.accounts.filter((a) => a.enabled !== false).length,
      accounts: data.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        fromName: a.fromName,
        provider: a.provider || 'smtp',
        isDefault: a.isDefault,
        enabled: a.enabled !== false,
        todayUsed: this.accountUsageToday(a.email),
        dailyLimit: a.dailyLimit || 0,
        freeQuotaRemaining:
          a.provider === 'tencent-ses'
            ? Math.max(0, (Number(a.ses?.freeQuotaTotal) || 1000) - this.accountUsageTotal(a.email))
            : null,
      })),
      nextRunAt: nextTimes.length ? nextTimes[0].nextRunAt : null,
      nextRunName: nextTimes.length ? nextTimes[0].name : null,
      nextRuns: nextTimes.slice(0, 5),
      sendMode: data.settings.sendMode,
      recentLogs: data.logs.slice(0, 8),
      trend: this.trend(14),
      todayStats: this.todayStats(),
    };
  }

  trend(days = 14) {
    const buckets = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      buckets.push({ date: key, success: 0, failed: 0, bounced: 0 });
    }
    const index = new Map(buckets.map((b, i) => [b.date, i]));
    for (const log of this.data.logs) {
      if (!log.createdAt) continue;
      const key = String(log.createdAt).slice(0, 10);
      const i = index.get(key);
      if (i == null) continue;
      if (log.status === LOG_STATUS.SUCCESS) buckets[i].success += 1;
      else if (log.status === LOG_STATUS.FAILED) buckets[i].failed += 1;
      else if (log.status === LOG_STATUS.BOUNCED) buckets[i].bounced += 1;
    }
    return buckets;
  }

  todayStats() {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logs = this.data.logs.filter((l) => String(l.createdAt || '').slice(0, 10) === key);
    return {
      date: key,
      total: logs.length,
      success: logs.filter((l) => l.status === LOG_STATUS.SUCCESS).length,
      failed: logs.filter((l) => l.status === LOG_STATUS.FAILED).length,
      bounced: logs.filter((l) => l.status === LOG_STATUS.BOUNCED).length,
    };
  }

  /** 今日已真实发送量（用于配额控制） */
  sentTodayCount(campaignId) {
    const key = new Date().toISOString().slice(0, 10);
    return this.data.logs.filter(
      (l) =>
        String(l.createdAt || '').slice(0, 10) === key &&
        !l.dryRun &&
        l.status !== LOG_STATUS.PENDING &&
        l.status !== LOG_STATUS.SKIPPED &&
        (!campaignId || l.campaignId === campaignId),
    ).length;
  }

  /** 清理超期日志 */
  pruneLogs(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const before = this.data.logs.length;
    this.data.logs = this.data.logs.filter((l) => new Date(l.createdAt || 0).getTime() >= cutoff);
    this.store.saveThrottled(100);
    return before - this.data.logs.length;
  }
}

module.exports = { Database, LOG_STATUS, LOG_STATUS_TEXT, toCsv, parseCsv, uid, nowIso };
