/* MailMaster 渲染层启动入口 */
(function () {
  const MM = window.MM;

  /* ---------------- 窗口控制（无边框窗口） ---------------- */
  const min = document.getElementById('wc-min');
  const max = document.getElementById('wc-max');
  const close = document.getElementById('wc-close');
  if (MM.api && MM.api.minimize && window.appEnv && window.appEnv.isElectron) {
    min.onclick = () => MM.api.minimize();
    max.onclick = () => MM.api.toggleMaximize();
    close.onclick = () => MM.api.close();
  } else {
    // 浏览器预览模式：隐藏无边框窗口按钮
    document.querySelector('.window-controls').classList.add('hidden');
  }

  /* ---------------- 导航与路由 ---------------- */
  document.getElementById('nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    MM.navigate(item.dataset.route);
  });

  window.addEventListener('hashchange', () => {
    const route = (window.location.hash || '#/dashboard').replace('#/', '');
    MM.renderRoute(route);
  });

  /* ---------------- 顶栏倒计时 ---------------- */
  const cdValue = document.getElementById('cd-value');
  const cdName = document.getElementById('cd-name');
  const cdBox = document.getElementById('countdown');

  function paintCountdown() {
    let target = null;
    let name = null;
    const overview = MM.state.overview;
    if (overview && overview.nextRunAt) {
      target = overview.nextRunAt;
      name = overview.nextRunName;
    } else {
      const next = (MM.state.campaigns || [])
        .filter((c) => c.status === 'active' && c.nextRunAt)
        .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
      if (next) {
        target = next.nextRunAt;
        name = next.name;
      }
    }
    const c = MM.fmtCountdown(target);
    cdValue.textContent = c.text;
    cdName.textContent = name ? `· ${name}` : '';
    cdBox.classList.toggle('idle', c.idle);
  }

  /* ---------------- 模式标记 & 版本 ---------------- */
  async function paintShell() {
    const [settings, infoRes] = await Promise.all([MM.loadSettings(), MM.api.info()]);
    // 注意：IPC 统一返回 { ok, data } 信封，必须拆开再取值，否则版本永远落到兜底值
    const info = (infoRes && infoRes.ok && infoRes.data) || {};
    const live = settings && settings.sendMode === 'live';
    const chip = document.getElementById('mode-chip');
    chip.className = `mode-chip ${live ? 'live' : 'dry'}`;
    chip.querySelector('.mode-text').textContent = live ? '真实发送模式' : '试运行模式（不真实发出）';
    const env = window.appEnv || {};
    const version = info.version || '?';
    const platform = info.platform || env.platform || 'web';
    document.getElementById('app-ver').textContent = `v${version} · ${platform}${env.isElectron ? '' : '（浏览器预览）'}`;
  }

  /* ---------------- 主进程事件订阅 ---------------- */
  function subscribe() {
    if (!MM.api || !MM.api.onEvent) return;
    MM.api.onEvent((payload) => {
      if (!payload) return;
      switch (payload.type) {
        case 'toast':
          MM.toast(payload.message, payload.level === 'error' ? 'error' : payload.level === 'warn' ? 'warn' : 'success', 6500);
          break;
        case 'campaign':
          if (payload.message) MM.toast(payload.message, 'info', 5200);
          MM.loadCampaigns();
          MM.state.dirty.overview = true;
          break;
        case 'log':
          MM.state.dirty.overview = true;
          break;
        case 'overview-dirty':
          MM.state.dirty.overview = true;
          break;
        case 'error':
          MM.toast(payload.message, 'error', 7000);
          break;
        default:
          break;
      }
      const page = MM.pages[MM.state.route];
      if (page && typeof page.onEvent === 'function') page.onEvent(payload);
      paintCountdown();
    });
  }

  /* ---------------- 全局心跳：刷新总览与倒计时 ---------------- */
  function startHeartbeat() {
    setInterval(async () => {
      if (MM.state.dirty.overview || MM.state.route === 'dashboard') {
        await MM.loadOverview();
        MM.state.dirty.overview = false;
        if (MM.state.route === 'dashboard') {
          // 看板的卡片数据由本页定时器读取 MM.state，无需整页重绘
        }
      }
      if (!MM.state.campaigns.length) await MM.loadCampaigns();
    }, 8000);
    setInterval(paintCountdown, 1000);
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await paintShell();
    await Promise.all([MM.loadCampaigns(), MM.loadOverview()]);
    paintCountdown();
    const route = (window.location.hash || '#/dashboard').replace('#/', '');
    await MM.renderRoute(route && MM.pages[route] ? route : 'dashboard');
    subscribe();
    startHeartbeat();

    // 看板的进度/统计需要随事件刷新
    setInterval(() => {
      if (MM.state.route === 'dashboard' && MM.state.dirty.overview) {
        MM.loadOverview().then(() => {
          MM.state.dirty.overview = false;
          MM.renderRoute('dashboard');
        });
      }
    }, 6000);
  })();
})();
