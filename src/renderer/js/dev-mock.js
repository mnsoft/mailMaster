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

  /* ---------------- Spintax（与主进程 src/main/spintax.js 行为一致的轻量实现） ---------------- */
  const MAX_SPIN_DEPTH = 12;
  const GUARD_OPEN = '\u0001';
  const GUARD_CLOSE = '\u0002';
  const GUARD_RE = new RegExp(`${GUARD_OPEN}(\\d+)${GUARD_CLOSE}`, 'g');

  function splitSpinOptions(nodes) {
    const options = [[]];
    nodes.forEach((node) => {
      if (node.type === 'text' && node.value.includes('|')) {
        node.value.split('|').forEach((part, i) => {
          if (i > 0) options.push([]);
          if (part) options[options.length - 1].push({ type: 'text', value: part });
        });
        return;
      }
      options[options.length - 1].push(node);
    });
    return options;
  }

  function parseSpinNodes(src, start, depth) {
    const nodes = [];
    let buf = '';
    let pos = start;
    const flush = () => {
      if (buf) {
        nodes.push({ type: 'text', value: buf });
        buf = '';
      }
    };
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\' && (src[pos + 1] === '{' || src[pos + 1] === '}')) {
        buf += src[pos + 1];
        pos += 2;
        continue;
      }
      if (ch === '}') {
        flush();
        return { nodes, pos, closed: true };
      }
      if (ch === '{') {
        if (depth >= MAX_SPIN_DEPTH) {
          buf += ch;
          pos += 1;
          continue;
        }
        const inner = parseSpinNodes(src, pos + 1, depth + 1);
        if (!inner.closed) {
          buf += ch;
          pos += 1;
          continue;
        }
        flush();
        nodes.push({ type: 'group', options: splitSpinOptions(inner.nodes) });
        pos = inner.pos + 1;
        continue;
      }
      buf += ch;
      pos += 1;
    }
    flush();
    return { nodes, pos, closed: false };
  }

  const isSpin = (node) => node.type === 'group' && node.options.length > 1;
  const parseSpin = (src) => parseSpinNodes(String(src == null ? '' : src), 0, 0).nodes;

  function countSpinNodes(nodes) {
    let total = 1;
    nodes.forEach((node) => {
      if (node.type === 'text') return;
      total *= isSpin(node) ? node.options.reduce((sum, option) => sum + countSpinNodes(option), 0) : countSpinNodes(node.options[0] || []);
    });
    return total;
  }

  /** 模板可产生的不同内容组合数（无 Spintax 时为 1） */
  const spinVariants = (src) => Math.max(1, countSpinNodes(parseSpin(src)));

  function renderSpinByIndex(nodes, index) {
    let rest = index;
    let out = '';
    nodes.forEach((node) => {
      if (node.type === 'text') {
        out += node.value;
        return;
      }
      if (!isSpin(node)) {
        out += `{${renderSpinByIndex(node.options[0] || [], rest)}}`;
        return;
      }
      const sizes = node.options.map((option) => countSpinNodes(option));
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      let local = ((rest % total) + total) % total;
      let picked = 0;
      for (let i = 0; i < sizes.length; i += 1) {
        if (local < sizes[i]) {
          picked = i;
          break;
        }
        local -= sizes[i];
      }
      rest = Math.floor(rest / total);
      out += renderSpinByIndex(node.options[picked], local);
    });
    return out;
  }

  /** 展开 Spintax；index 为 null 时随机取一组 */
  function expandSpin(src, index) {
    const nodes = parseSpin(src);
    const variants = Math.max(1, countSpinNodes(nodes));
    const idx = index == null ? Math.floor(Math.random() * variants) % variants : Number(index);
    return { text: renderSpinByIndex(nodes, idx), variants, index: idx };
  }

  /**
   * 渲染模板：先保护 {{变量}}，再按序号展开 Spintax，最后替换变量
   * （顺序必须与主进程 template.js 一致，否则 {{公司名}} 会被误判成 Spintax 组）
   */
  function render(text, contact, g, spinIndex) {
    const missing = [];
    const source = String(text == null ? '' : text);
    const store = [];
    const guarded = source.replace(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g, (full) => {
      store.push(full);
      return `${GUARD_OPEN}${store.length - 1}${GUARD_CLOSE}`;
    });
    const spun = expandSpin(guarded, spinIndex);
    const restored = spun.text.replace(GUARD_RE, (matched, i) => (store[Number(i)] == null ? matched : store[Number(i)]));
    const out = restored.replace(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g, (_m, raw) => {
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
    return { text: out, missing, variants: spun.variants, index: spun.index };
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

  /* ---------------- 发送节奏（与主进程 src/main/pacing.js 一致的轻量实现） ---------------- */
  const PACING_DEFAULTS = {
    mode: 'fixed',
    intervalSeconds: 10,
    delayMinSeconds: 20,
    delayMaxSeconds: 90,
    burstEvery: 0,
    burstMinSeconds: 180,
    burstMaxSeconds: 420,
    hourlyLimit: 0,
    dailyLimit: 200,
    maxRetries: 1,
  };
  const PACING_PRESETS = [
    { key: 'steady', label: '稳健匀速', hint: '固定 10 秒/封，适合自建 SMTP 通道', config: { mode: 'fixed', intervalSeconds: 10, burstEvery: 0, hourlyLimit: 0, dailyLimit: 200, maxRetries: 1 } },
    {
      key: 'human',
      label: '拟人节奏（推荐）',
      hint: '20–90 秒随机 + 每 10 封长休息，最接近人工发送',
      config: { mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, burstMinSeconds: 180, burstMaxSeconds: 420, hourlyLimit: 60, dailyLimit: 200, maxRetries: 1 },
    },
    {
      key: 'conservative',
      label: '保守低频',
      hint: '1–3 分钟随机 + 每小时 20 封上限，适合普通邮箱 SMTP',
      config: { mode: 'random', delayMinSeconds: 60, delayMaxSeconds: 180, burstEvery: 8, burstMinSeconds: 600, burstMaxSeconds: 1200, hourlyLimit: 20, dailyLimit: 80, maxRetries: 1 },
    },
    { key: 'fast', label: '快速通道', hint: '5 秒/封，配合腾讯云邮件推送等专业通道使用', config: { mode: 'fixed', intervalSeconds: 5, burstEvery: 0, hourlyLimit: 0, dailyLimit: 1000, maxRetries: 2 } },
  ];
  const ACCOUNT_STRATEGIES = [
    { key: 'roundRobin', label: '轮询（推荐）', hint: '按顺序依次使用每个账号，用量最均衡' },
    { key: 'random', label: '随机', hint: '每封在可用账号中随机挑选，分布更不规律' },
  ];

  function normPace(input) {
    const raw = Object.assign({}, PACING_DEFAULTS, input || {});
    const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
    const clampMin = (v, d) => Math.max(0, num(v, d));
    const delayMin = clampMin(raw.delayMinSeconds, PACING_DEFAULTS.delayMinSeconds);
    const burstMin = clampMin(raw.burstMinSeconds, PACING_DEFAULTS.burstMinSeconds);
    return {
      mode: raw.mode === 'random' ? 'random' : 'fixed',
      intervalSeconds: clampMin(raw.intervalSeconds, PACING_DEFAULTS.intervalSeconds),
      delayMinSeconds: delayMin,
      delayMaxSeconds: Math.max(delayMin, clampMin(raw.delayMaxSeconds, PACING_DEFAULTS.delayMaxSeconds)),
      burstEvery: clampMin(raw.burstEvery, 0),
      burstMinSeconds: burstMin,
      burstMaxSeconds: Math.max(burstMin, clampMin(raw.burstMaxSeconds, PACING_DEFAULTS.burstMaxSeconds)),
      hourlyLimit: clampMin(raw.hourlyLimit, 0),
      dailyLimit: clampMin(raw.dailyLimit, PACING_DEFAULTS.dailyLimit),
      maxRetries: clampMin(raw.maxRetries, PACING_DEFAULTS.maxRetries),
    };
  }

  function describePace(input) {
    const cfg = normPace(input);
    const parts = [cfg.mode === 'random' ? `随机延迟 ${cfg.delayMinSeconds}–${cfg.delayMaxSeconds} 秒/封` : `固定间隔 ${cfg.intervalSeconds} 秒/封`];
    if (cfg.burstEvery > 0) parts.push(`每 ${cfg.burstEvery} 封后休息 ${cfg.burstMinSeconds}–${cfg.burstMaxSeconds} 秒`);
    if (cfg.hourlyLimit > 0) parts.push(`每小时最多 ${cfg.hourlyLimit} 封`);
    if (cfg.dailyLimit > 0) parts.push(`每日最多 ${cfg.dailyLimit} 封`);
    return parts.join(' · ');
  }

  function humanizeMs(ms) {
    if (!ms || ms < 1000) return '几乎瞬时';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `约 ${h} 小时 ${m} 分`;
    if (m > 0) return `约 ${m} 分 ${s} 秒`;
    return `约 ${s} 秒`;
  }

  function estimatePaceMs(input, total) {
    const cfg = normPace(input);
    const count = Math.max(0, Math.round(Number(total) || 0));
    if (count <= 0) return 0;
    const average = cfg.mode === 'random' ? (cfg.delayMinSeconds + cfg.delayMaxSeconds) / 2 : cfg.intervalSeconds;
    let ms = average * 1000 * Math.max(0, count - 1);
    if (cfg.burstEvery > 0) {
      const bursts = Math.floor(Math.max(0, count - 1) / cfg.burstEvery);
      ms += bursts * ((cfg.burstMinSeconds + cfg.burstMaxSeconds) / 2 - average) * 1000;
    }
    if (cfg.hourlyLimit > 0 && count > cfg.hourlyLimit) ms += (Math.ceil(count / cfg.hourlyLimit) - 1) * 3600 * 1000;
    return Math.max(0, Math.round(ms));
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
    // 退信标记：被标记的地址会从所有推广的发送列表中剔除，直到手动解除
    bounceMarked: false,
    bounceInfo: null,
    stats: { attempts: 0, success: 0, failed: 0, bounced: 0 },
    lastStatus: null,
    lastSentAt: null,
  }));

  const templates = [
    {
      id: uid('tpl'),
      name: '标准产品推广（中文）',
      subject: '{{公司名}} · {关于|聊聊}{智能采集|数据采集}方案的{沟通|交流}（{{联系人}}）',
      body:
        '{尊敬的|您好，}{{称呼}}{{联系人}}：\n\n' +
        '{我是|我们是}{{发件方公司}}的{{发件人}}。\n\n' +
        '了解到{{公司名}}在{{城市}}的业务发展，我们近期为同行业客户落地的「{智能数据采集|自动化数据采集}与自动化处理方案」{或许|可能}对您有帮助：\n\n' +
        '· 采集效率提升 3 倍以上，人工成本下降约 40%\n' +
        '· 支持与现有系统无缝对接，7 天即可完成部署\n' +
        '· 提供 30 天免费试用与专属技术支持\n\n' +
        '{如果方便|方便的话}，我可以在本周内为您安排一次 20 分钟的线上演示。\n\n' +
        '期待与{{公司名}}的{合作|进一步交流}。\n\n{{发件人}}\n{{发件方公司}}\n{{日期}}',
      createdAt: iso(),
      updatedAt: iso(),
    },
    {
      id: uid('tpl'),
      name: '简短跟进（老客户）',
      subject: '{{联系人}}您好，{{公司名}}的{方案|项目}跟进',
      body:
        '{{称呼}}{{联系人}}，您好：\n\n' +
        '上次与您{沟通|交流}的方案{已更新|已经更新}到最新版本，其中针对{{公司名}}关注的成本问题做了{优化|调整}。\n' +
        '{方便的话|如果方便}我给您发一份最新资料，您电话{{电话}}是否仍可联系？\n\n' +
        '顺祝商祺！\n{{发件人}} · {{发件方公司}}\n{{日期时间}}',
      createdAt: iso(),
      updatedAt: iso(),
    },
  ];

  const settings = {
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'marketing@example.com', pass: '', fromName: '市场部 · 王小明', fromEmail: 'marketing@example.com' },
    senderCompany: '示例智能科技有限公司',
    sendMode: 'dryRun',
    defaultThrottle: { mode: 'random', intervalSeconds: 10, delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, burstMinSeconds: 180, burstMaxSeconds: 420, hourlyLimit: 60, dailyLimit: 200, maxRetries: 1 },
    bounceAutoPause: true,
    bouncePauseThreshold: 5,
    // IMAP 退信监听（全局）
    imapAutoCheck: true,
    imapPollMinutes: 5,
    imapAutoMarkBounce: true,
    imapBounceType: 'hard',
    imapLastCheckAt: null,
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
      // IMAP 退信监听（浏览器预览里不真正连接，仅用于界面演示）
      imap: {
        enabled: true,
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'marketing@example.com',
        // 预览演示用的占位授权码：让「退信监听」页展示一个配置完整、状态正常的账号
        pass: 'demo-imap-auth-code',
        mailbox: 'INBOX',
        searchDays: 30,
        markSeen: true,
        allowInsecure: false,
        lastCheckAt: new Date(Date.now() - 26 * 60e3).toISOString(),
        lastFound: 0,
        lastError: '',
      },
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
        throttle: { mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, burstMinSeconds: 180, burstMaxSeconds: 420, hourlyLimit: 60, dailyLimit: 200, maxRetries: 1 },
        accountMode: 'single',
        accountIds: [],
        accountStrategy: 'roundRobin',
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

  /* ---------------- 退信事件（IMAP 监听结果） ---------------- */
  /** 最近一次检查摘要（供「退信监听」页展示） */
  let lastImapSummary = null;

  // 由历史日志里的退信记录派生，模拟「IMAP 扫描收件箱识别到 DSN 后登记事件」的效果
  const bounceEvents = logs
    .filter((l) => l.status === 'bounced')
    .map((l, i) => ({
      id: uid('bn'),
      accountId: l.accountId,
      accountEmail: l.accountEmail,
      uid: 101 + i,
      type: 'hard',
      status: '5.1.1',
      diagnostic: '550 5.1.1 收件人地址不存在（用户不存在）',
      reason: '收件人地址不存在',
      subject: l.subject,
      from: 'MAILER-DAEMON@example.com（邮件系统投递失败通知）',
      date: l.createdAt,
      originalMessageId: `<demo-${i}@mailmaster.local>`,
      recipients: [l.email],
      contactId: l.contactId,
      email: l.email,
      company: l.company,
      contactName: l.contact,
      campaignId: l.campaignId,
      campaignName: l.campaignName,
      logId: l.id,
      source: 'imap',
      matched: true,
      createdAt: l.createdAt,
    }));

  // 演示：退信事件对应的地址已带上退信标记（与主进程的种子数据行为保持一致）
  bounceEvents.forEach((e) => {
    const target = contacts.find((c) => c.id === e.contactId);
    if (!target || target.bounceMarked) return;
    target.bounceMarked = true;
    target.bounceInfo = {
      at: e.createdAt,
      type: e.type,
      status: e.status,
      reason: e.reason,
      diagnostic: e.diagnostic,
      subject: e.subject,
      accountEmail: e.accountEmail,
      source: 'imap',
      eventId: e.id,
    };
  });

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
    // 退订与「已标记退信」的地址都不会进入发送列表
    const all = contacts.filter((c) => c.subscribed !== false && !c.bounceMarked);
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
      activeContactCount: contacts.filter((c) => c.subscribed !== false && !c.bounceMarked).length,
      bouncedContactCount: contacts.filter((c) => c.stats.bounced > 0).length,
      bounceMarkedCount: contacts.filter((c) => c.bounceMarked).length,
      bounceEventCount: bounceEvents.length,
      lastImapCheckAt: settings.imapLastCheckAt || null,
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
    // 多账号轮询：按顺序把每封邮件分配给不同的发信账号
    const poolAccounts = (c.accountIds || []).map((id) => accounts.find((x) => x.id === id)).filter((a) => a && a.enabled !== false);
    const pool = c.accountMode === 'pool' && poolAccounts.length > 1 ? poolAccounts : null;
    const account = pool ? pool[0] : resolveAccount(c.accountId);
    const accountLabel = pool
      ? `账号池 ${pool.length} 个（${pool.map((a) => a.email).join('、')}）`
      : account
        ? `${account.provider === 'tencent-ses' ? '腾讯云邮件推送 · ' : ''}${account.email}`
        : '（未配置发信账号）';
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
        const use = pool ? pool[(i - 1) % pool.length] : account;
        const g = globals(settings, { index: i, total: recipients.length, account: use });
        const subj = render(tpl.subject, ct, g).text;
        let body = render(tpl.body, ct, g).text;
        if (settings.appendFooter) body += `\n\n————————————\n${settings.footerText}`;
        const sim = dry ? simulate(ct.email) : { status: 'success', error: '' };
        const log = {
          id: uid('lg'),
          campaignId: c.id,
          campaignName: c.name,
          accountId: use ? use.id : null,
          accountEmail: use ? use.email : '',
          accountName: use ? use.name : '',
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
    info: () => ok({ name: 'MailMaster', version: '1.0.2', platform: 'browser-preview', electron: '—', dataFile: '（浏览器预览模式：数据保存在内存中，不写入磁盘）', isDev: true }),
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
      if (q.status === 'bounceMarked') list = list.filter((c) => c.bounceMarked);
      if (q.status === 'unsubscribed') list = list.filter((c) => c.subscribed === false);
      if (q.status === 'active') list = list.filter((c) => c.subscribed !== false && !c.bounceMarked);
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
      c.bounceMarked = true;
      c.bounceInfo = {
        at: iso(),
        type: 'hard',
        status: '',
        reason: note || '人工标记为退信',
        diagnostic: '',
        subject: '',
        accountEmail: '',
        source: 'manual',
        eventId: null,
      };
      c.remark = note ? `${c.remark ? `${c.remark} / ` : ''}手动标记退信：${note}` : c.remark;
      c.updatedAt = iso();
      return ok(c);
    },
    /** 解除退信标记：该地址重新进入发送列表 */
    releaseContactBounce: ({ id }) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return Promise.resolve({ ok: false, error: '联系人不存在' });
      const previous = c.bounceInfo || {};
      c.bounceMarked = false;
      c.bounceInfo = null;
      c.subscribed = true;
      if (previous.at) {
        const stamp = String(previous.at).slice(0, 19).replace('T', ' ');
        c.remark = `${c.remark ? `${c.remark} / ` : ''}于 ${stamp} 解除退信标记`;
      }
      c.updatedAt = iso();
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
    previewTemplate: ({ subject, body, contactId, accountId, spinIndex }) => {
      const contact = contacts.find((c) => c.id === contactId) || contacts[0];
      const g = globals(settings, { index: 1, total: 1 });
      const account = resolveAccount(accountId);
      const subjectSource = String(subject || '');
      const bodySource = String(body || '');
      const subjectVariants = spinVariants(subjectSource);
      const bodyVariants = spinVariants(bodySource);
      const totalVariants = subjectVariants * bodyVariants;
      // 与主进程一致：主题变体 × 正文变体统一编号，序号由界面指定（「换一组措辞」）
      const composite = spinIndex == null ? Math.floor(Math.random() * totalVariants) % totalVariants : Number(spinIndex);
      const subjectIndex = Math.floor(composite / bodyVariants) % subjectVariants;
      const bodyIndex = composite % bodyVariants;
      const s = render(subjectSource, contact, g, subjectIndex);
      const b = render(bodySource, contact, g, bodyIndex);
      return ok({
        contact,
        rendered: {
          subject: s.text,
          body: b.text,
          missing: Array.from(new Set([...s.missing, ...b.missing])),
          spintax: { subjectVariants, bodyVariants, totalVariants, subjectIndex, bodyIndex },
        },
        account,
        spintax: { hasSpintax: totalVariants > 1, subjectVariants, bodyVariants, totalVariants, subjectGroups: [], bodyGroups: [] },
      });
    },

    /** Spintax 概览：可产生多少种不同内容 + 随机抽样 */
    spintaxInfo: ({ subject, body }) => {
      const subjectSource = String(subject || '');
      const bodySource = String(body || '');
      const subjectVariants = spinVariants(subjectSource);
      const bodyVariants = spinVariants(bodySource);
      const totalVariants = subjectVariants * bodyVariants;
      const demoContact = { company: '示例公司', contact: '张三', salutation: '张总', city: '深圳' };
      const samples = [];
      for (let i = 0; i < 5; i += 1) {
        const composite = Math.floor(Math.random() * totalVariants) % totalVariants;
        const g = globals(settings, { index: i + 1, total: 5 });
        samples.push({
          subject: render(subjectSource, demoContact, g, Math.floor(composite / bodyVariants) % subjectVariants).text,
          body: render(bodySource, demoContact, g, composite % bodyVariants).text.slice(0, 120),
        });
      }
      return ok({
        hasSpintax: totalVariants > 1,
        subjectVariants,
        bodyVariants,
        totalVariants,
        subjectGroups: [],
        bodyGroups: [],
        samples,
        sampleCount: samples.length,
        sampleUniqueSubjects: new Set(samples.map((x) => x.subject)).size,
      });
    },

    listCampaigns: () =>
      ok(
        campaigns.map((c) => {
          const a = resolveAccount(c.accountId);
          const poolAccounts = (c.accountIds || []).map((id) => accounts.find((x) => x.id === id)).filter(Boolean);
          return Object.assign({}, c, {
            accountEmail: a ? a.email : '',
            accountName: a ? a.name : '',
            poolEmails: poolAccounts.map((x) => x.email),
            paceText: describePace(c.throttle && Object.keys(c.throttle).length ? c.throttle : settings.defaultThrottle),
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

    /** 节奏 / 账号池元信息 */
    pacingMeta: () => ok({ presets: PACING_PRESETS, strategies: ACCOUNT_STRATEGIES }),

    /** 按当前节奏估算整批耗时 */
    paceEstimate: ({ throttle, total }) => {
      const pace = normPace(throttle || {});
      const count = Math.max(0, Math.round(Number(total) || 0));
      const ms = estimatePaceMs(pace, count);
      return ok({ pace, total: count, ms, text: humanizeMs(ms), describe: describePace(pace) });
    },

    // ---------------- 退信监听（IMAP） ----------------
    bounceState: () => {
      const list = accounts.map((a) => {
        const imap = a.imap || {};
        const readiness = !imap.enabled
          ? '未启用 IMAP 退信监听'
          : !imap.host
            ? '未配置 IMAP 服务器地址'
            : !(imap.user || a.user || a.email)
              ? '未配置 IMAP 登录名'
              : !(imap.pass || a.pass)
                ? 'IMAP 密码与发信密码都为空，无法登录（两者至少填一个）'
                : null;
        return {
          id: a.id,
          name: a.name,
          email: a.email,
          enabled: imap.enabled === true,
          host: imap.host || '',
          mailbox: imap.mailbox || 'INBOX',
          readiness,
          lastCheckAt: imap.lastCheckAt || null,
          lastError: imap.lastError || '',
          lastFound: imap.lastFound || 0,
        };
      });
      const enabledCount = list.filter((a) => a.enabled && !a.readiness).length;
      return ok({
        running: false,
        lastCheckAt: settings.imapLastCheckAt || null,
        lastSummary: lastImapSummary,
        lastErrors: [],
        pollMinutes: settings.imapPollMinutes || 5,
        autoCheck: settings.imapAutoCheck !== false,
        autoMarkBounce: settings.imapAutoMarkBounce !== false,
        minType: settings.imapBounceType === 'all' ? 'all' : 'hard',
        enabledAccountCount: enabledCount,
        markedCount: contacts.filter((c) => c.bounceMarked).length,
        eventCount: bounceEvents.length,
        accounts: list,
      });
    },

    checkBounces: () => {
      const enabled = accounts.filter((a) => a.imap && a.imap.enabled && a.imap.host);
      const summary = {
        checkedAt: iso(),
        reason: 'manual',
        accounts: enabled.length,
        scanned: 0,
        bounced: 0,
        marked: 0,
        skipped: 0,
        errors: [],
        details: [],
      };
      if (!enabled.length) {
        summary.message = '没有启用 IMAP 监听且配置完整的发信账号，请在「发信邮箱配置」中打开退信监听';
        lastImapSummary = summary;
        return ok(summary);
      }
      // 浏览器预览无法真正连接 IMAP：只刷新「上次检查时间」，不凭空造退信
      settings.imapLastCheckAt = summary.checkedAt;
      enabled.forEach((a) => {
        a.imap.lastCheckAt = summary.checkedAt;
        a.imap.lastFound = 0;
        a.imap.lastError = '';
      });
      lastImapSummary = summary;
      push({ type: 'bounce-state' });
      return ok(summary);
    },

    listBounces: (q = {}) => {
      let list = [...bounceEvents];
      if (q.accountId) list = list.filter((e) => e.accountId === q.accountId);
      if (q.type && q.type !== 'all') list = list.filter((e) => e.type === q.type);
      if (q.matched === 'unmatched') list = list.filter((e) => !e.matched);
      if (q.matched === 'matched') list = list.filter((e) => e.matched);
      const kw = String(q.keyword || '').trim().toLowerCase();
      if (kw) list = list.filter((e) => [e.email, e.company, e.contactName, e.subject, e.status, e.diagnostic, e.accountEmail].join(' ').toLowerCase().includes(kw));
      return ok({ total: list.length, items: list.slice(0, q.limit || 200) });
    },

    /** 解除某个联系人的退信标记（与 contacts:releaseBounce 等价，退信页使用） */
    releaseBounce: ({ id }) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return Promise.resolve({ ok: false, error: '联系人不存在' });
      return window.api.releaseContactBounce({ id });
    },

    testImap: ({ id, draft }) => {
      const acc = id ? accounts.find((a) => a.id === id) : null;
      const imap = (draft && draft.imap) || (acc && acc.imap) || {};
      const email = (draft && draft.email) || (acc && acc.email) || '';
      const smtpPass = (draft && draft.pass) || (acc && acc.pass) || '';
      if (!imap.enabled) return ok({ ok: false, message: '请先勾选「启用 IMAP 退信监听」', durationMs: 5 });
      if (!imap.host) return ok({ ok: false, message: '请先填写 IMAP 服务器地址', durationMs: 5 });
      if (!(imap.user || email)) return ok({ ok: false, message: '未配置 IMAP 登录名', durationMs: 5 });
      if (!(imap.pass || smtpPass)) return ok({ ok: false, message: 'IMAP 密码与发信密码都为空，无法登录（两者至少填一个）', durationMs: 5 });
      return ok({
        ok: true,
        message: `（浏览器预览为模拟结果）IMAP 连接成功 · ${imap.host}:${imap.port || 993} · 邮箱 ${imap.mailbox || 'INBOX'}（当前 128 封）`,
        durationMs: 63,
      });
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
