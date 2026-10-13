/* MailMaster 渲染层核心：状态、路由、通用组件 */
(function () {
  const MM = (window.MM = window.MM || {});
  MM.api = window.api;
  if (!MM.api) console.error('[MailMaster] 未检测到 API 桥（Electron preload 或浏览器预览 mock 均未加载）');
  MM.pages = {};
  MM.state = {
    route: 'dashboard',
    settings: null,
    overview: null,
    campaigns: [],
    contacts: [],
    templates: [],
    tags: [],
    dirty: { overview: true },
  };

  /* ------------------------- 基础工具 ------------------------- */
  MM.esc = function (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  MM.attr = function (value) {
    return MM.esc(value == null ? '' : value);
  };

  MM.pad = (v) => String(v).padStart(2, '0');

  MM.fmtDate = function (input, withTime) {
    if (!input) return '—';
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return '—';
    const base = `${d.getFullYear()}-${MM.pad(d.getMonth() + 1)}-${MM.pad(d.getDate())}`;
    if (!withTime) return base;
    return `${base} ${MM.pad(d.getHours())}:${MM.pad(d.getMinutes())}:${MM.pad(d.getSeconds())}`;
  };

  MM.fmtTimeShort = function (input) {
    if (!input) return '—';
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return '—';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `${MM.pad(d.getHours())}:${MM.pad(d.getMinutes())}`;
    return MM.fmtDate(input, true).slice(5, 16);
  };

  MM.fmtRelative = function (input) {
    if (!input) return '—';
    const diff = Date.now() - new Date(input).getTime();
    if (Number.isNaN(diff)) return '—';
    const abs = Math.abs(diff);
    if (abs < 60000) return diff >= 0 ? '刚刚' : '即将';
    if (abs < 3600000) return `${Math.floor(abs / 60000)} 分钟${diff >= 0 ? '前' : '后'}`;
    if (abs < 86400000) return `${Math.floor(abs / 3600000)} 小时${diff >= 0 ? '前' : '后'}`;
    return `${Math.floor(abs / 86400000)} 天${diff >= 0 ? '前' : '后'}`;
  };

  MM.fmtCountdown = function (target) {
    if (!target) return { text: '--:--:--', idle: true };
    const diff = new Date(target).getTime() - Date.now();
    if (Number.isNaN(diff)) return { text: '--:--:--', idle: true };
    if (diff <= 0) return { text: '00:00:00', idle: false, due: true };
    const total = Math.floor(diff / 1000);
    const days = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const text = days > 0 ? `${days}天 ${MM.pad(h)}:${MM.pad(m)}:${MM.pad(s)}` : `${MM.pad(h)}:${MM.pad(m)}:${MM.pad(s)}`;
    return { text, idle: false, days };
  };

  MM.fmtDuration = function (ms) {
    if (!ms) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  };

  MM.fmtNumber = (n) => Number(n || 0).toLocaleString('zh-CN');

  MM.fmtPercent = function (part, total) {
    if (!total) return '0%';
    return `${((part / total) * 100).toFixed(1)}%`;
  };

  MM.STATUS_TEXT = {
    success: '成功',
    failed: '失败',
    bounced: '退信',
    pending: '待发送',
    sending: '发送中',
    skipped: '已跳过',
    draft: '草稿',
    active: '已启用',
    paused: '已暂停',
    finished: '已完成',
    running: '执行中',
  };

  MM.statusBadge = function (status) {
    const text = MM.STATUS_TEXT[status] || status || '未知';
    const cls = MM.STATUS_TEXT[status] ? `badge-${status}` : 'badge-pending';
    return `<span class="badge ${cls}">${MM.esc(text)}</span>`;
  };

  MM.tagList = function (tags) {
    if (!tags || !tags.length) return '<span style="color:var(--text-faint)">—</span>';
    return tags.map((t) => `<span class="tag">${MM.esc(t)}</span>`).join('');
  };

  MM.spinBtn = (btn, label) => {
    if (!btn) return () => {};
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${MM.esc(label || '处理中')}`;
    return () => {
      btn.disabled = false;
      btn.innerHTML = original;
    };
  };

  /* ------------------------- 提示条 ------------------------- */
  MM.toast = function (message, level = 'info', timeout = 4200) {
    const layer = document.getElementById('toast-layer');
    if (!layer || !message) return;
    const node = document.createElement('div');
    node.className = `toast ${level}`;
    node.textContent = message;
    layer.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s ease, transform .25s ease';
      node.style.opacity = '0';
      node.style.transform = 'translateX(16px)';
      setTimeout(() => node.remove(), 260);
    }, timeout);
  };

  /* ------------------------- 模态框 ------------------------- */
  MM.modal = function ({ title, body, footer, size = '', onMount }) {
    const layer = document.getElementById('modal-layer');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal ${size}">
        <div class="modal-head">
          <div class="modal-title">${MM.esc(title || '')}</div>
          <button class="x-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">${body || ''}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    layer.appendChild(mask);

    const close = () => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.hasAttribute('data-modal-close')) close();
    });

    const ctx = { root: mask, close, $: (sel) => mask.querySelector(sel), $$: (sel) => Array.from(mask.querySelectorAll(sel)) };
    if (typeof onMount === 'function') onMount(ctx);
    return ctx;
  };

  MM.confirm = function ({ title = '请确认', message = '', confirmText = '确认', danger = false }) {
    return new Promise((resolve) => {
      const ctx = MM.modal({
        title,
        size: 'narrow',
        body: `<div style="font-size:13px;line-height:1.8;">${message}</div>`,
        footer: `<button class="btn" data-cancel>取消</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${MM.esc(confirmText)}</button>`,
      });
      ctx.$('[data-cancel]').onclick = () => {
        ctx.close();
        resolve(false);
      };
      ctx.$('[data-ok]').onclick = () => {
        ctx.close();
        resolve(true);
      };
    });
  };

  /** 关闭当前所有弹窗（切换页面时调用，避免弹窗残留） */
  MM.clearModals = function () {
    document.querySelectorAll('#modal-layer .modal-mask').forEach((node) => node.remove());
  };

  /* ------------------------- 独立窗口邮件预览 ------------------------- */
  /**
   * 在独立窗口中按完整尺寸预览邮件（模拟邮箱客户端阅读视图）。
   *
   * payload: { subject, body, missing, contact:{company,contact,salutation,email}, from:{name,email}, templateName, at }
   *
   * 与预览窗口通过 postMessage 握手：窗口加载完成后主动发 ready 索要内容（带随机 nonce），
   * 本函数收到匹配的 ready 才投递内容 —— 不用定时盲发，避免时序丢失。
   * 同时把内容写入 localStorage，窗口被刷新或 opener 已关闭时仍能显示最近一次结果。
   */
  MM.openMailPreviewWindow = function (payload, options) {
    const opts = options || {};
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);

    try {
      localStorage.setItem('mm-mail-preview-last', JSON.stringify(payload));
    } catch (_) {
      /* localStorage 不可用时忽略：握手投递仍可正常工作 */
    }

    // 每次打开都是独立窗口（窗口名带 nonce），避免复用窗口时握手串号
    const features = [
      `width=${opts.width || 1040}`,
      `height=${opts.height || 940}`,
      'menubar=no',
      'toolbar=no',
      'location=no',
      'status=no',
      'scrollbars=yes',
      'resizable=yes',
    ].join(',');

    let win = null;
    try {
      win = window.open(`preview.html?k=${nonce}`, `mm-mail-preview-${nonce}`, features);
    } catch (_) {
      win = null;
    }
    if (!win) {
      MM.toast('独立预览窗口被拦截：请在浏览器中允许本页弹出窗口后重试', 'warn', 7000);
      return null;
    }

    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'mm-mail-preview-ready' || data.nonce !== nonce) return;
      if (win.closed) return;
      try {
        win.postMessage({ type: 'mm-mail-preview-data', nonce, payload }, '*');
      } catch (_) {
        /* ignore */
      }
    };
    window.addEventListener('message', onMessage);

    // 窗口关闭后解除监听
    const watcher = setInterval(() => {
      if (win.closed) {
        clearInterval(watcher);
        window.removeEventListener('message', onMessage);
      }
    }, 1000);

    return win;
  };

  /* ------------------------- 数据加载 ------------------------- */
  MM.loadSettings = async function (force) {
    if (MM.state.settings && !force) return MM.state.settings;
    const res = await MM.api.getSettings();
    if (res.ok) MM.state.settings = res.data;
    return MM.state.settings;
  };

  MM.loadOverview = async function () {
    const res = await MM.api.overview();
    if (res.ok) {
      MM.state.overview = res.data;
      MM.state.dirty.overview = false;
    }
    return MM.state.overview;
  };

  MM.loadCampaigns = async function () {
    const res = await MM.api.listCampaigns();
    MM.state.campaigns = res.ok ? res.data : [];
    return MM.state.campaigns;
  };

  MM.loadTemplates = async function () {
    const res = await MM.api.listTemplates();
    MM.state.templates = res.ok ? res.data : [];
    return MM.state.templates;
  };

  MM.loadAccounts = async function () {
    const res = await MM.api.listAccounts();
    MM.state.accounts = res.ok ? res.data : [];
    return MM.state.accounts;
  };

  MM.sendMode = function (settings) {
    const s = settings || MM.state.settings || {};
    return s.sendMode === 'live' ? 'live' : 'dry';
  };

  MM.effectiveDryRun = function (campaign) {
    return MM.sendMode() !== 'live' || campaign.dryRun !== false;
  };

  /* ------------------------- 页面级定时器（切换页面自动清理） ------------------------- */
  MM.pageTimers = [];
  MM.addTimer = function (fn, ms) {
    const id = setInterval(fn, ms);
    MM.pageTimers.push(id);
    return id;
  };
  MM.clearTimers = function () {
    MM.pageTimers.forEach((id) => clearInterval(id));
    MM.pageTimers = [];
  };

  /* ------------------------- 路由 ------------------------- */
  MM.navigate = function (route) {
    if (window.location.hash !== `#/${route}`) window.location.hash = `#/${route}`;
    else MM.renderRoute(route);
  };

  MM.renderRoute = async function (route) {
    const page = MM.pages[route] || MM.pages.dashboard;
    MM.state.route = route;
    MM.clearTimers();
    MM.clearModals();
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.route === route);
    });
    document.getElementById('page-title').textContent = page.title || '';
    const view = document.getElementById('view');
    view.scrollTop = 0;
    view.innerHTML = '<div class="empty">正在加载…</div>';
    try {
      await page.render(view);
    } catch (err) {
      view.innerHTML = `<div class="empty"><strong>页面加载失败</strong>${MM.esc(err.message)}</div>`;
    }
  };

  MM.refreshCurrent = function () {
    return MM.renderRoute(MM.state.route);
  };

  /* 汇总表头统计（各页面复用）；文本型数值过长时自动缩小字号，避免溢出 */
  MM.statCard = function ({ label, value, sub, tone = '' }) {
    const isText = typeof value === 'string';
    const isLongText = isText && value.replace(/<[^>]+>/g, '').length > 14;
    const body = typeof value === 'number' ? MM.fmtNumber(value) : value;
    return `<div class="stat-card ${tone}">
      <div class="stat-label">${MM.esc(label)}</div>
      <div class="stat-value ${isLongText ? 'sm' : ''}">${body}</div>
      <div class="stat-sub">${sub || ''}</div>
    </div>`;
  };
})();
