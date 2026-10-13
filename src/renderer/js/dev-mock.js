/* 浏览器预览模式：当没有 Electron 主进程时，用内存数据实现同一套 api 接口，
   使 src/renderer 下的真实页面可以在浏览器中直接查看与操作（数据不落盘）。 */
(function () {
  if (window.api && window.api.getSettings) return; // 已在 Electron 环境中

  const pad = (v) => String(v).padStart(2, '0');
  const iso = () => new Date().toISOString();
  const uid = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}`;

  const FIELDS = {
    company: '公司名',
    contact: '联系人',
    salutation: '称呼',
    email: '邮件地址',
    phone: '电话',
    position: '职位',
    city: '城市',
    tags: '标签',
    remark: '备注',
  };
  const FIELD_ALIAS = {
    公司: 'company',
    公司名称: 'company',
    单位: 'company',
    姓名: 'contact',
    名字: 'contact',
    尊称: 'salutation',
    称谓: 'salutation',
    邮箱: 'email',
    邮件: 'email',
    电子邮箱: 'email',
    手机: 'phone',
    手机号: 'phone',
    电话: 'phone',
    联系方式: 'phone',
    职务: 'position',
    岗位: 'position',
    地区: 'city',
    所在城市: 'city',
    分组: 'tags',
    标签: 'tags',
    说明: 'remark',
    备注: 'remark',
  };
  const GLOBALS = { 日期: '__date', 时间: '__time', 年份: '__year', 月份: '__month', 日期时间: '__datetime', 发件人: '__sender', 发件方公司: '__senderCompany', 序号: '__index', 总数: '__total' };

  function resolveVar(raw) {
    const key = String(raw).trim().toLowerCase();
    if (FIELDS[key]) return key;
    if (GLOBALS[key]) return GLOBALS[key];
    if (FIELD_ALIAS[key]) return FIELD_ALIAS[key];
    const hit = Object.keys(FIELDS).find((k) => FIELDS[k] === String(raw).trim());
    if (hit) return hit;
    return null;
  }

  function globals(settings, extra = {}) {
    const d = new Date();
    return {
      __date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      __time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      __year: String(d.getFullYear()),
      __month: `${d.getMonth() + 1}月`,
      __datetime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      __sender: (extra.account && extra.account.fromName) || settings.smtp.fromName,
      __senderCompany: settings.senderCompany,
      __index: extra.index ? String(extra.index) : '',
      __total: extra.total ? String(extra.total) : '',
    };
  }

  function render(text, contact, g) {
    const missing = [];
    const out = String(text || '').replace(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g, (_m, raw) => {
      const key = resolveVar(raw);
      if (!key) {
        missing.push(String(raw).trim());
        return '';
      }
      const value = key.startsWith('__') ? g[key] : contact[key];
      if (value == null || value === '') {
        missing.push(FIELDS[key] || key);
        return '';
      }
      return String(Array.isArray(value) ? value.join('、') : value);
    });
    return { text: out, missing };
  }

  function scan(text) {
    const set = new Map();
    for (const m of String(text || '').matchAll(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g)) {
      const raw = m[1].trim();
      const key = resolveVar(raw);
      if (set.has(raw)) continue;
      set.set(raw, { raw, varName: key || raw, known: Boolean(key), label: key || raw });
    }
    return Array.from(set.values());
  }

  // ---------------- 种子数据 ----------------
  const seedCompanies = [
    ['深圳市云图智能科技有限公司', '张明远', '张总', 'zhangmingyuan@yuntu-ai.com', '13802345678', '采购总监', '深圳', ['重点客户']],
    ['上海恒信贸易有限公司', '李婉如', '李经理', 'liwanru@hengxin-trade.cn', '13901234567', '外贸部经理', '上海', ['重点客户', '华东']],
    ['杭州蓝湖软件股份有限公司', '王海涛', '王工', 'wanghaitao@lanhu-soft.com', '13600998877', '技术负责人', '杭州', ['技术型']],
    ['北京博远医疗器械有限公司', '陈静', '陈主任', 'chenjing@boyuan-med.cn', '13511223344', '院方采购', '北京', ['医疗行业']],
    ['广州南方物流集团', '刘建国', '刘总', 'liujianguo@nf-logistics.com', '13722334455', '运营副总', '广州', ['物流']],
    ['成都天府教育科技有限公司', '赵雪', '赵老师', 'zhaoxue@tianfu-edu.cn', '13833445566', '市场主管', '成都', ['教育行业']],
    ['苏州精工机械制造有限公司', '孙立成', '孙厂长', 'sunlicheng@jinggong-mc.com', '13944556677', '厂长', '苏州', ['制造业']],
    ['武汉长江数据服务有限公司', '周雨薇', '周经理', 'zhouyuwei@cjdata.com.cn', '13655667788', '商务经理', '武汉', ['待跟进']],
  ];

  const contacts = seedCompanies.map(([company, contact, salutation, email, phone, position, city, tags]) => ({
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
    subscribedAt: iso(),
    createdAt: iso(),
    updatedAt: iso(),
    stats: { attempts: 0, success: 0, failed: 0, bounced: 0 },
    lastStatus: null,
    lastSentAt: null,
  }));

  const templates = [
    {
      id: uid('tpl'),
      name: '标准产品推广（中文）',
      subject: '{{公司名}} · 关于智能采集方案的沟通（{{联系人}}）',
      body: '尊敬的{{称呼}}{{联系人}}：\n\n您好！我是{{发件方公司}}的{{发件人}}。\n\n了解到{{公司名}}在{{城市}}的业务发展，我们近期为同行业客户落地的「智能数据采集与自动化处理方案」或许对您有帮助：\n\n· 采集效率提升 3 倍以上，人工成本下降约 40%\n· 支持与现有系统无缝对接，7 天即可完成部署\n· 提供 30 天免费试用与专属技术支持\n\n如果方便，我可以在本周内为您安排一次 20 分钟的线上演示。\n\n期待与{{公司名}}的合作。\n\n{{发件人}}\n{{发件方公司}}\n{{日期}}',
      createdAt: iso(),
      updatedAt: iso(),
    },
    {
      id: uid('tpl'),
      name: '简短跟进（老客户）',
      subject: '{{联系人}}您好，{{公司名}}的方案跟进',
      body: '{{称呼}}{{联系人}}，您好：\n\n上次与您沟通的方案已更新到最新版本，其中针对{{公司名}}关注的成本问题做了优化。\n方便的话我给您发一份最新资料，您电话{{电话}}是否仍可联系？\n\n顺祝商祺！\n{{发件人}} · {{发件方公司}}\n{{日期时间}}',
      createdAt: iso(),
      updatedAt: iso(),
    },
  ];

  const settings = {
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'marketing@example.com', pass: '', fromName: '市场部 · 王小明', fromEmail: 'marketing@example.com' },
    senderCompany: '示例智能科技有限公司',
    sendMode: 'dryRun',
    defaultThrottle: { intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 },
    bounceAutoPause: true,
    bouncePauseThreshold: 5,
    appendFooter: true,
    footerText: '如不希望再收到此类邮件，请回复「退订」，我们将立即为您移除。',
    logRetentionDays: 180,
  };

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
      createdAt: iso(),
      updatedAt: iso(),
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
      createdAt: iso(),
      updatedAt: iso(),
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
      },
      createdAt: iso(),
      updatedAt: iso(),
    },
  ];

  function accountUsage(email) {
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const mine = logs.filter((l) => l.accountEmail && l.accountEmail.toLowerCase() === String(email).toLowerCase() && !l.dryRun);
    return {
      totalUsed: mine.length,
      todayUsed: mine.filter((l) => String(l.createdAt).slice(0, 10) === today).length,
      monthUsed: mine.filter((l) => String(l.createdAt).slice(0, 7) === month).length,
      success: mine.filter((l) => l.status === 'success').length,
      failed: mine.filter((l) => l.status === 'failed').length,
      bounced: mine.filter((l) => l.status === 'bounced').length,
    };
  }

  function accountsWithStats() {
    return accounts.map((a) => {
      const u = accountUsage(a.email);
      const freeTotal = a.provider === 'tencent-ses' ? Number(a.ses && a.ses.freeQuotaTotal) || 1000 : 0;
      return Object.assign({}, a, u, {
        total: u.totalUsed,
        freeQuotaTotal: freeTotal,
        freeQuotaRemaining: freeTotal ? Math.max(0, freeTotal - u.totalUsed) : null,
      });
    });
  }

  function resolveAccount(accountId) {
    if (!accounts.length) return null;
    if (accountId) {
      const hit = accounts.find((a) => a.id === accountId);
      if (hit) return hit;
    }
    return accounts.find((a) => a.isDefault && a.enabled !== false) || accounts.find((a) => a.enabled !== false) || accounts[0];
  }

  function mkCampaign(over) {
    return Object.assign(
      {
        id: uid('cp'),
        name: '未命名任务',
        description: '',
        templateId: templates[0].id,
        accountId: accounts[0].id,
        kind: 'manual',
        schedule: { type: 'manual' },
        audience: { mode: 'all', tags: [], ids: [] },
        throttle: { intervalSeconds: 5, dailyLimit: 200, maxRetries: 1 },
        dryRun: true,
        status: 'draft',
        runCount: 0,
        lastRunAt: null,
        nextRunAt: null,
        running: false,
        progress: { total: 0, done: 0, success: 0, failed: 0, bounced: 0, startedAt: null, finishedAt: null },
        createdAt: iso(),
        updatedAt: iso(),
      },
      over,
    );
  }

  const campaigns = [
    mkCampaign({
      name: '10月常规推广（每月 1 / 15 日）',
      description: '每月固定两次向全部有效客户发送标准产品推广',
      accountId: accounts[0].id,
      kind: 'scheduled',
      schedule: { type: 'monthly', days: [1, 15], time: '09:30' },
      status: 'active',
      runCount: 2,
      lastRunAt: new Date(Date.now() - 3 * 24 * 3600e3).toISOString(),
    }),
    mkCampaign({
      name: '每周三客户关怀（每周三 10:00）',
      description: '每周三上午向重点客户发送关怀与新产品简报',
      templateId: templates[1].id,
      accountId: accounts[1].id,
      kind: 'scheduled',
      schedule: { type: 'weekly', weekdays: [3], time: '10:00' },
      status: 'active',
      runCount: 5,
      lastRunAt: new Date(Date.now() - 2 * 24 * 3600e3).toISOString(),
    }),
    mkCampaign({
      name: '临时任务：医疗行业定向触达',
      description: '手动触发的临时推广，仅发送给「医疗行业」标签客户',
      templateId: templates[1].id,
      accountId: accounts[1].id,
      kind: 'manual',
      schedule: { type: 'manual' },
      audience: { mode: 'tags', tags: ['医疗行业'], ids: [] },
      status: 'active',
      runCount: 1,
    }),
  ];

  // 历史日志
  const logs = [];
  let cursor = Date.now() - 9 * 24 * 3600e3;
  contacts.forEach((c, i) => {
    const roll = i % 8;
    const status = roll === 5 ? 'failed' : roll === 7 ? 'bounced' : 'success';
    cursor += 37 * 60e3;
    const ts = new Date(cursor).toISOString();
    logs.push({
      id: uid('lg'),
      campaignId: campaigns[0].id,
      campaignName: campaigns[0].name,
      accountId: accounts[0].id,
      accountEmail: accounts[0].email,
      accountName: accounts[0].name,
      contactId: c.id,
      company: c.company,
      contact: c.contact,
      salutation: c.salutation,
      email: c.email,
      subject: `【历史记录】致 ${c.company} 的产品方案`,
      status,
      error: status === 'failed' ? 'SMTP 超时：连接 smtp.example.com:465 超时' : status === 'bounced' ? '550 5.1.1 收件人地址不存在（用户不存在）' : '',
      attempts: status === 'success' ? 1 : 2,
      createdAt: ts,
      finishedAt: ts,
      durationMs: 480 + i * 23,
      dryRun: false,
    });
    c.stats.attempts += 1;
    if (status === 'success') c.stats.success += 1;
    else if (status === 'failed') c.stats.failed += 1;
    else c.stats.bounced += 1;
    c.lastStatus = status;
    c.lastSentAt = ts;
  });
  logs.reverse();

  const counters = {
    totalRuns: 8,
    totalAttempts: logs.length,
    success: logs.filter((l) => l.status === 'success').length,
    failed: logs.filter((l) => l.status === 'failed').length,
    bounced: logs.filter((l) => l.status === 'bounced').length,
  };

  // ---------------- 调度计算 ----------------
  function nextRun(schedule, from = new Date()) {
    if (!schedule || !schedule.type || schedule.type === 'manual') return null;
    const at = (base, time) => {
      const [h, m] = String(time || '09:00').split(':').map(Number);
      return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0, 0, 0);
    };
    if (schedule.type === 'once') {
      const d = new Date(schedule.at);
      return !schedule.at || Number.isNaN(d.getTime()) || d <= from ? null : d;
    }
    if (schedule.type === 'interval') {
      const mins = Math.max(1, Number(schedule.everyMinutes) || 60);
      return new Date(from.getTime() + mins * 60000);
    }
    if (schedule.type === 'daily') {
      const c = at(from, schedule.time);
      if (c <= from) c.setDate(c.getDate() + 1);
      return c;
    }
    if (schedule.type === 'weekly') {
      const days = schedule.weekdays && schedule.weekdays.length ? schedule.weekdays : [1];
      for (let off = 0; off <= 8; off += 1) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + off);
        if (!days.includes(day.getDay())) continue;
        const c = at(day, schedule.time);
        if (c > from) return c;
      }
      return null;
    }
    if (schedule.type === 'monthly') {
      const days = schedule.days && schedule.days.length ? [...schedule.days].sort((a, b) => a - b) : [1];
      for (let off = 0; off <= 24; off += 1) {
        const probe = new Date(from.getFullYear(), from.getMonth() + off, 1);
        const maxDay = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
        for (const d of days) {
          const c = at(new Date(probe.getFullYear(), probe.getMonth(), Math.min(d, maxDay)), schedule.time);
          if (c > from) return c;
        }
      }
      return null;
    }
    return null;
  }

  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function describe(schedule) {
    if (!schedule || !schedule.type) return '未设置';
    switch (schedule.type) {
      case 'manual':
        return '仅手动触发';
      case 'once':
        return `单次：${new Date(schedule.at).toLocaleString('zh-CN')}`;
      case 'interval':
        return `每 ${schedule.everyMinutes || 60} 分钟自动执行一次`;
      case 'daily':
        return `每天 ${schedule.time || '09:00'} 执行`;
      case 'weekly':
        return `每周 ${(schedule.weekdays || []).map((d) => WD[d]).join('、')} ${schedule.time || '09:00'} 执行`;
      case 'monthly':
        return `每月 ${(schedule.days || []).map((d) => `${d} 日`).join('、')} ${schedule.time || '09:00'} 执行`;
      default:
        return '未设置';
    }
  }
  function fmtDT(input) {
    if (!input) return '—';
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function computeNext(c) {
    return c.schedule && c.schedule.type !== 'manual' && c.status === 'active'
      ? (nextRun(c.schedule) || new Date()).toISOString()
      : null;
  }
  campaigns.forEach((c) => {
    c.scheduleText = describe(c.schedule);
    c.nextRunAt = computeNext(c);
  });

  // ---------------- 事件总线 ----------------
  const listeners = [];
  function push(payload) {
    listeners.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        /* ignore */
      }
    });
  }

  const resolveAudience = (audience = {}) => {
    const all = contacts.filter((c) => c.subscribed !== false);
    if (audience.mode === 'tags' && audience.tags && audience.tags.length) return all.filter((c) => (c.tags || []).some((t) => audience.tags.includes(t)));
    if (audience.mode === 'ids' && audience.ids && audience.ids.length) {
      const set = new Set(audience.ids);
      return all.filter((c) => set.has(c.id));
    }
    return all;
  };

  function overviewData() {
    const emails = new Set(contacts.map((c) => c.email.toLowerCase()));
    const active = campaigns.filter((c) => c.status === 'active' && c.schedule.type !== 'manual');
    const nexts = campaigns
      .filter((c) => c.status === 'active' && c.nextRunAt)
      .map((c) => ({ id: c.id, name: c.name, nextRunAt: c.nextRunAt }))
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
    const trend = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const dayLogs = logs.filter((l) => String(l.createdAt).slice(0, 10) === key);
      trend.push({
        date: key,
        success: dayLogs.filter((l) => l.status === 'success').length,
        failed: dayLogs.filter((l) => l.status === 'failed').length,
        bounced: dayLogs.filter((l) => l.status === 'bounced').length,
      });
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter((l) => String(l.createdAt).slice(0, 10) === todayKey);
    return {
      userCount: contacts.length,
      uniqueEmailCount: emails.size,
      activeContactCount: contacts.filter((c) => c.subscribed !== false).length,
      bouncedContactCount: contacts.filter((c) => c.stats.bounced > 0).length,
      totalAttempts: counters.totalAttempts,
      successCount: counters.success,
      failedCount: counters.failed,
      bouncedCount: counters.bounced,
      campaignCount: campaigns.length,
      activeCampaignCount: active.length,
      runningCampaignCount: campaigns.filter((c) => c.running).length,
      totalRuns: counters.totalRuns,
      templateCount: templates.length,
      nextRunAt: nexts.length ? nexts[0].nextRunAt : null,
      nextRunName: nexts.length ? nexts[0].name : null,
      nextRuns: nexts.slice(0, 5),
      sendMode: settings.sendMode,
      recentLogs: logs.slice(0, 8),
      trend,
      todayStats: {
        date: todayKey,
        total: todayLogs.length,
        success: todayLogs.filter((l) => l.status === 'success').length,
        failed: todayLogs.filter((l) => l.status === 'failed').length,
        bounced: todayLogs.filter((l) => l.status === 'bounced').length,
      },
    };
  }

  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < String(s).length; i += 1) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
    return h;
  };
  function simulate(email) {
    const n = hash(email) % 100;
    if (n < 4) return { status: 'bounced', error: '550 5.1.1 收件人地址不存在（试运行模拟）' };
    if (n < 12) return { status: 'failed', error: '421 4.7.0 服务端临时限流（试运行模拟）' };
    return { status: 'success', error: '' };
  }

  const controls = new Map();

  async function runCampaign(id, onlyFailed) {
    const c = campaigns.find((x) => x.id === id);
    if (!c) throw new Error('任务不存在');
    if (c.running) throw new Error('该任务正在执行中');
    const tpl = templates.find((t) => t.id === c.templateId);
    if (!tpl) throw new Error('任务未关联有效模板');
    let recipients = onlyFailed
      ? contacts.filter((ct) => logs.some((l) => l.campaignId === id && l.contactId === ct.id && (l.status === 'failed' || l.status === 'bounced')))
      : resolveAudience(c.audience);
    if (!recipients.length) {
      push({ type: 'toast', level: 'warn', message: '没有命中任何收件人' });
      return { total: 0 };
    }
    const control = { cancelled: false, paused: false };
    controls.set(id, control);
    const dry = settings.sendMode !== 'live' || c.dryRun !== false;
    const account = resolveAccount(c.accountId);
    const accountLabel = account ? `${account.provider === 'tencent-ses' ? '腾讯云邮件推送 · ' : ''}${account.email}` : '（未配置发信账号）';
    c.running = true;
    c.lastRunAt = iso();
    c.progress = { total: recipients.length, done: 0, success: 0, failed: 0, bounced: 0, startedAt: iso(), finishedAt: null };
    push({ type: 'campaign', campaign: c, message: `开始执行「${c.name}」：共 ${recipients.length} 位收件人 · 发信账号 ${accountLabel}${dry ? '（试运行模式）' : ''}` });

    let i = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (control.cancelled || i >= recipients.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (control.paused) return;
        const ct = recipients[i];
        i += 1;
        const g = globals(settings, { index: i, total: recipients.length, account });
        const subj = render(tpl.subject, ct, g).text;
        let body = render(tpl.body, ct, g).text;
        if (settings.appendFooter) body += `\n\n————————————\n${settings.footerText}`;
        const sim = dry ? simulate(ct.email) : { status: 'success', error: '' };
        const log = {
          id: uid('lg'),
          campaignId: c.id,
          campaignName: c.name,
          accountId: account ? account.id : null,
          accountEmail: account ? account.email : '',
          accountName: account ? account.name : '',
          contactId: ct.id,
          company: ct.company,
          contact: ct.contact,
          salutation: ct.salutation,
          email: ct.email,
          subject: subj,
          status: sim.status,
          error: sim.error,
          attempts: 1,
          createdAt: iso(),
          finishedAt: iso(),
          durationMs: 200 + (hash(ct.email) % 400),
          dryRun: dry,
        };
        logs.unshift(log);
        ct.stats.attempts += 1;
        ct.stats[sim.status] += 1;
        ct.lastStatus = sim.status;
        ct.lastSentAt = log.createdAt;
        counters.totalAttempts += 1;
        counters[sim.status] += 1;
        c.progress.done += 1;
        c.progress[sim.status] += 1;
        push({ type: 'log', log });
        push({ type: 'campaign', campaign: c });
      }, 420);
    });

    c.running = false;
    c.runCount += 1;
    c.progress.finishedAt = iso();
    counters.totalRuns += 1;
    if (c.schedule.type === 'manual') c.status = 'finished';
    else c.nextRunAt = (nextRun(c.schedule) || new Date()).toISOString();
    controls.delete(id);
    push({ type: 'campaign', campaign: c });
    push({ type: 'toast', level: 'info', message: `「${c.name}」执行结束：成功 ${c.progress.success} / 失败 ${c.progress.failed} / 退信 ${c.progress.bounced}` });
    return c.progress;
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const ok = (data) => Promise.resolve({ ok: true, data });

  window.api = {
    // 版本号需与 package.json 的 version 保持一致（浏览器预览模式没有 app.getVersion()）
    info: () => ok({ name: 'MailMaster', version: '1.0.1', platform: 'browser-preview', electron: '—', dataFile: '（浏览器预览模式：数据保存在内存中，不写入磁盘）', isDev: true }),
    openDataDir: () => ok(true),
    minimize: () => ok(true),
    toggleMaximize: () => ok(true),
    close: () => ok(true),
    overview: () => ok(overviewData()),
    getSettings: () => ok(JSON.parse(JSON.stringify(settings))),
    saveSettings: (patch) => {
      Object.assign(settings, patch);
      return ok(JSON.parse(JSON.stringify(settings)));
    },
    testSmtp: () => ok({ ok: false, message: '浏览器预览模式无法连接真实 SMTP，请在 Electron 应用中测试', durationMs: 12 }),

    // ---------------- 发信邮箱账号 ----------------
    listAccounts: () => ok(accountsWithStats()),
    saveAccount: (input) => {
      const email = String(input.email || '').trim();
      if (!email) return Promise.resolve({ ok: false, error: '发信邮箱地址不能为空' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Promise.resolve({ ok: false, error: `发信邮箱地址格式不正确：${email}` });
      const provider = input.provider === 'tencent-ses' ? 'tencent-ses' : 'smtp';
      if (provider === 'smtp' && !String(input.host || '').trim()) return Promise.resolve({ ok: false, error: 'SMTP 服务器地址不能为空' });
      if (provider === 'tencent-ses') {
        if (!input.ses || !input.ses.secretId || !input.ses.secretKey) return Promise.resolve({ ok: false, error: '腾讯云邮件推送需要填写 SecretId 与 SecretKey' });
        if ((input.ses.sendMode || 'template') === 'template' && !input.ses.templateId) {
          return Promise.resolve({ ok: false, error: '腾讯云 SES 默认使用模板发送，请填写已审核通过的发信模板 ID' });
        }
      }
      const payload = Object.assign({}, input, { provider, email, ses: provider === 'tencent-ses' ? Object.assign({ freeQuotaTotal: 1000, unsubscribe: '2', region: 'ap-guangzhou', site: 'cn', sendMode: 'template' }, input.ses) : undefined });
      if (provider === 'smtp') delete payload.ses;
      // 表单在新增时会把 id 收集为 undefined，若原样带入 Object.assign 会覆盖掉新生成的 id
      delete payload.id;
      if (input.id) {
        const t = accounts.find((a) => a.id === input.id);
        Object.assign(t, payload, { updatedAt: iso() });
        return ok(t);
      }
      const created = Object.assign({ id: uid('acc'), isDefault: accounts.length === 0, createdAt: iso(), updatedAt: iso(), enabled: true, dailyLimit: 0 }, payload);
      accounts.push(created);
      return ok(created);
    },
    removeAccount: (id) => {
      const used = campaigns.filter((c) => c.accountId === id);
      if (used.length) return Promise.resolve({ ok: false, error: `该发信账号正被 ${used.length} 个推广任务使用，请先为这些任务更换发信账号` });
      const i = accounts.findIndex((a) => a.id === id);
      if (i >= 0) accounts.splice(i, 1);
      if (accounts.length && !accounts.some((a) => a.isDefault)) accounts[0].isDefault = true;
      return ok(true);
    },
    setDefaultAccount: (id) => {
      const acc = accounts.find((a) => a.id === id);
      if (!acc) return Promise.resolve({ ok: false, error: '发信账号不存在' });
      if (acc.enabled === false) return Promise.resolve({ ok: false, error: '该账号已停用，启用后才能设为默认' });
      accounts.forEach((a) => {
        a.isDefault = a.id === id;
      });
      return ok(acc);
    },
    testAccount: (payload) => {
      const acc = payload && payload.id ? Object.assign({}, accounts.find((a) => a.id === payload.id) || {}, payload) : payload;
      if (!acc) return Promise.resolve({ ok: false, error: '请先填写发信账号信息' });
      if (acc.provider === 'tencent-ses') {
        if (!acc.ses || !acc.ses.secretId || !acc.ses.secretKey) return Promise.resolve({ ok: false, error: '请先填写腾讯云 SecretId 与 SecretKey' });
        return ok({
          ok: true,
          message: `（浏览器预览为模拟结果）腾讯云密钥格式校验通过，发信地址 ${acc.email} 示意可正常调用接口`,
          senders: [{ email: acc.email, name: acc.fromName }],
          durationMs: 86,
        });
      }
      if (!acc.host) return Promise.resolve({ ok: false, error: '请先填写 SMTP 服务器地址' });
      return ok({ ok: true, message: `（浏览器预览为模拟结果）SMTP 连接与认证成功（${acc.email || acc.user || acc.host}）`, durationMs: 42 });
    },
    querySesQuota: (payload) => {
      const acc = (payload && payload.id ? accounts.find((a) => a.id === payload.id) : null) || accounts.find((a) => a.provider === 'tencent-ses');
      if (!acc) return Promise.resolve({ ok: false, error: '尚未配置腾讯云邮件推送账号' });
      const u = accountUsage(acc.email);
      const freeTotal = Number(acc.ses && acc.ses.freeQuotaTotal) || 1000;
      const local = {
        todayUsed: u.todayUsed,
        monthUsed: u.monthUsed,
        totalUsed: u.totalUsed,
        freeQuotaTotal: freeTotal,
        freeQuotaRemainingLocal: Math.max(0, freeTotal - u.totalUsed),
      };
      if (!acc.ses || !acc.ses.secretId || !acc.ses.secretKey) {
        return ok({ ok: false, remote: false, local, message: '未配置 SecretId / SecretKey，无法查询腾讯云端额度，以下为本应用记录的本地用量（预览模式为示例数据）' });
      }
      return ok({
        ok: true,
        remote: true,
        local,
        message: '（浏览器预览为模拟数据，真实额度以腾讯云控制台为准）已从腾讯云获取套餐包额度',
        quota: { total: freeTotal, used: u.totalUsed, remaining: Math.max(0, freeTotal - u.totalUsed), expireTime: '不限有效期', fieldNames: { total: 'TotalAmount', used: 'UsedAmount', remaining: 'RemainingAmount' } },
        packages: [{ PackageId: 'pkg-demo', PackageName: '免费额度包', TotalAmount: freeTotal, UsedAmount: u.totalUsed, RemainingAmount: Math.max(0, freeTotal - u.totalUsed), ExpireTime: '不限有效期' }],
      });
    },

    listContacts: (q = {}) => {
      let list = [...contacts];
      const kw = (q.keyword || '').trim().toLowerCase();
      if (kw) list = list.filter((c) => [c.company, c.contact, c.salutation, c.email, c.phone, c.position, c.city, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(kw));
      if (q.tag) list = list.filter((c) => (c.tags || []).includes(q.tag));
      if (q.status === 'hasBounce') list = list.filter((c) => c.stats.bounced > 0);
      if (q.status === 'unsubscribed') list = list.filter((c) => c.subscribed === false);
      if (q.status === 'active') list = list.filter((c) => c.subscribed !== false);
      return ok({ items: list, tags: Array.from(new Set(contacts.flatMap((c) => c.tags || []))), total: contacts.length });
    },
    saveContact: (input) => {
      const email = String(input.email || '').trim();
      if (!email) return Promise.resolve({ ok: false, error: '邮件地址不能为空' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Promise.resolve({ ok: false, error: `邮件地址格式不正确：${email}` });
      const dup = contacts.find((c) => c.email.toLowerCase() === email.toLowerCase() && c.id !== input.id);
      if (dup) return Promise.resolve({ ok: false, error: `邮件地址已存在：${email}` });
      if (input.id) {
        const t = contacts.find((c) => c.id === input.id);
        Object.assign(t, input, { tags: input.tags || [], updatedAt: iso() });
        return ok(t);
      }
      const created = Object.assign({ id: uid('ct'), subscribed: true, createdAt: iso(), updatedAt: iso(), stats: { attempts: 0, success: 0, failed: 0, bounced: 0 }, lastStatus: null, lastSentAt: null }, input);
      contacts.push(created);
      return ok(created);
    },
    removeContacts: (ids) => {
      ids.forEach((id) => {
        const i = contacts.findIndex((c) => c.id === id);
        if (i >= 0) contacts.splice(i, 1);
      });
      return ok({ removed: ids.length });
    },
    markContactBounced: ({ id, note }) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return Promise.resolve({ ok: false, error: '联系人不存在' });
      c.stats.bounced += 1;
      c.lastStatus = 'bounced';
      c.subscribed = false;
      c.remark = note ? `${c.remark ? `${c.remark} / ` : ''}手动标记退信：${note}` : c.remark;
      counters.bounced += 1;
      return ok(c);
    },
    exportContactsCsv: () => ok({ canceled: false, filePath: '（浏览器预览：文件已下载到默认下载目录）' }),
    importContactsFile: () =>
      new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.txt,.tsv';
        input.onchange = () => {
          const file = input.files[0];
          if (!file) return resolve(ok({ canceled: true }));
          const reader = new FileReader();
          reader.onload = () => resolve(window.api.importContactsText({ text: String(reader.result) }));
          reader.readAsText(file, 'utf8');
        };
        input.click();
      }),
    importContactsText: ({ text }) => {
      const lines = String(text || '')
        .split(/\r?\n/)
        .filter((l) => l.trim());
      const result = { added: 0, updated: 0, skipped: 0, errors: [] };
      lines.slice(1).forEach((line, idx) => {
        const cols = line.split(',').map((v) => v.replace(/^"|"$/g, '').trim());
        const [company, contact, salutation, email, phone, position, city, tags, remark] = cols;
        if (!email || !email.includes('@')) {
          result.skipped += 1;
          result.errors.push(`第 ${idx + 2} 行：邮件地址无效`);
          return;
        }
        if (contacts.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
          result.skipped += 1;
          return;
        }
        contacts.push({
          id: uid('ct'),
          company: company || '',
          contact: contact || '',
          salutation: salutation || '',
          email,
          phone: phone || '',
          position: position || '',
          city: city || '',
          tags: tags ? tags.split(/[|、]/).filter(Boolean) : [],
          remark: remark || '',
          subscribed: true,
          createdAt: iso(),
          updatedAt: iso(),
          stats: { attempts: 0, success: 0, failed: 0, bounced: 0 },
          lastStatus: null,
          lastSentAt: null,
        });
        result.added += 1;
      });
      return ok(result);
    },

    listTemplates: () => ok(templates),
    saveTemplate: (input) => {
      if (input.id) {
        const t = templates.find((x) => x.id === input.id);
        Object.assign(t, { name: input.name, subject: input.subject, body: input.body, updatedAt: iso() });
        return ok(t);
      }
      const created = { id: uid('tpl'), name: input.name, subject: input.subject || '', body: input.body || '', createdAt: iso(), updatedAt: iso() };
      templates.push(created);
      return ok(created);
    },
    removeTemplate: (id) => {
      const i = templates.findIndex((t) => t.id === id);
      if (i >= 0) templates.splice(i, 1);
      return ok(true);
    },
    templateFields: () =>
      ok({
        contact: Object.keys(FIELDS).map((k) => ({ key: k, label: FIELDS[k], aliases: [] })),
        global: Object.keys(GLOBALS).map((k) => ({ key: GLOBALS[k], label: k, hint: '' })),
      }),
    scanTemplate: ({ subject, body }) => ok(scan(`${subject || ''}\n${body || ''}`)),
    previewTemplate: ({ subject, body, contactId, accountId }) => {
      const contact = contacts.find((c) => c.id === contactId) || contacts[0];
      const g = globals(settings, { index: 1, total: 1 });
      const account = resolveAccount(accountId);
      return ok({
        contact,
        rendered: {
          subject: render(subject, contact, g).text,
          body: render(body, contact, g).text,
          missing: render(`${subject}\n${body}`, contact, g).missing,
        },
        account,
      });
    },

    listCampaigns: () =>
      ok(
        campaigns.map((c) => {
          const a = resolveAccount(c.accountId);
          return Object.assign({}, c, {
            accountEmail: a ? a.email : '',
            accountName: a ? a.name : '',
            scheduleText: describe(c.schedule),
            nextRunText: fmtDT(c.nextRunAt),
            effectiveDryRun: settings.sendMode !== 'live' || c.dryRun !== false,
          });
        }),
      ),
    saveCampaign: (input) => {
      if (input.id) {
        const c = campaigns.find((x) => x.id === input.id);
        Object.assign(c, input, { updatedAt: iso() });
        c.nextRunAt = c.schedule.type === 'manual' ? null : (nextRun(c.schedule) || new Date()).toISOString();
        return ok(c);
      }
      const created = mkCampaign(Object.assign({}, input, { status: 'active' }));
      created.nextRunAt = created.schedule.type === 'manual' ? null : (nextRun(created.schedule) || new Date()).toISOString();
      campaigns.push(created);
      return ok(created);
    },
    removeCampaign: (id) => {
      const i = campaigns.findIndex((c) => c.id === id);
      if (i >= 0) campaigns.splice(i, 1);
      return ok(true);
    },
    previewCampaignAudience: (audience) => {
      const list = resolveAudience(audience);
      return ok({ total: list.length, sample: list.slice(0, 30) });
    },
    runCampaign: ({ id, onlyFailed }) => {
      runCampaign(id, onlyFailed).catch((err) => push({ type: 'toast', level: 'error', message: err.message }));
      return ok({ started: true });
    },
    pauseCampaign: ({ id, paused }) => {
      const c = campaigns.find((x) => x.id === id);
      const ctl = controls.get(id);
      if (ctl) ctl.paused = paused;
      c.status = paused ? 'paused' : 'active';
      return ok({ status: c.status, running: c.running });
    },
    cancelCampaign: (id) => {
      const ctl = controls.get(id);
      if (ctl) ctl.cancelled = true;
      push({ type: 'toast', level: 'warn', message: '已请求中止当前发送' });
      return ok(true);
    },
    campaignNextRuns: (id) => {
      const c = campaigns.find((x) => x.id === id);
      const out = [];
      let cursor = new Date();
      for (let i = 0; i < 5; i += 1) {
        const n = nextRun(c.schedule, cursor);
        if (!n) break;
        out.push(n.toISOString());
        cursor = new Date(n.getTime() + 1000);
      }
      return ok(out);
    },

    listLogs: (q = {}) => {
      let list = [...logs];
      if (q.campaignId) list = list.filter((l) => l.campaignId === q.campaignId);
      if (q.status && q.status !== 'all') list = list.filter((l) => l.status === q.status);
      const kw = (q.keyword || '').trim().toLowerCase();
      if (kw) list = list.filter((l) => [l.company, l.contact, l.email, l.subject, l.error].join(' ').toLowerCase().includes(kw));
      const offset = q.offset || 0;
      const limit = q.limit || 50;
      return ok({ total: list.length, items: list.slice(offset, offset + limit) });
    },
    exportLogsCsv: () => {
      download('投递记录.csv', logs.map((l) => [l.createdAt, l.company, l.contact, l.email, l.status, l.error].join(',')).join('\n'));
      return ok({ canceled: false, filePath: '（浏览器预览：文件已下载）' });
    },
    logMailPreview: ({ id }) => {
      const log = logs.find((l) => l.id === id);
      const c = campaigns.find((x) => x.id === log.campaignId);
      const tpl = templates.find((t) => t.id === (c ? c.templateId : '')) || templates[0];
      const ct = contacts.find((x) => x.id === log.contactId) || { email: log.email, contact: log.contact, company: log.company };
      const g = globals(settings, { index: 1, total: 1 });
      const account = resolveAccount(log.accountId);
      const body = render(tpl.body, ct, g);
      return ok({
        to: log.email,
        subject: render(tpl.subject, ct, g).text,
        text: body.text,
        missing: body.missing,
        contact: { company: ct.company, contact: ct.contact, salutation: ct.salutation, email: ct.email || log.email },
        account: account ? { email: account.email, name: account.name, fromName: account.fromName } : null,
      });
    },
    resendLog: async ({ id }) => {
      const log = logs.find((l) => l.id === id);
      const ct = contacts.find((x) => x.id === log.contactId);
      const sim = simulate(ct.email);
      const nlog = Object.assign({}, log, { id: uid('lg'), status: sim.status, error: sim.error, createdAt: iso(), attempts: 1 });
      logs.unshift(nlog);
      ct.stats[sim.status] += 1;
      counters[sim.status] += 1;
      push({ type: 'log', log: nlog });
      return ok({ status: sim.status, error: sim.error });
    },

    recomputeStats: () => {
      counters.success = logs.filter((l) => l.status === 'success' && !l.dryRun).length;
      counters.failed = logs.filter((l) => l.status === 'failed' && !l.dryRun).length;
      counters.bounced = logs.filter((l) => l.status === 'bounced' && !l.dryRun).length;
      counters.totalAttempts = logs.filter((l) => !l.dryRun).length;
      return ok(counters);
    },
    pruneLogs: (days) => {
      const cutoff = Date.now() - (days || 180) * 86400e3;
      const before = logs.length;
      for (let i = logs.length - 1; i >= 0; i -= 1) if (new Date(logs[i].createdAt).getTime() < cutoff) logs.splice(i, 1);
      return ok({ removed: before - logs.length });
    },
    recalcSchedule: () => {
      campaigns.forEach((c) => {
        c.nextRunAt = c.schedule.type === 'manual' ? null : (nextRun(c.schedule) || new Date()).toISOString();
      });
      return ok(true);
    },
    onEvent: (handler) => {
      listeners.push(handler);
      return () => {
        const i = listeners.indexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  window.appEnv = { isElectron: false, platform: 'browser-preview', versions: {} };
})();
