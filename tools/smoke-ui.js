'use strict';

/**
 * 无头 UI 冒烟测试：用 Electron 隐藏窗口加载「浏览器预览」站点，
 * 逐页真实渲染并模拟关键交互，捕获任何未捕获异常 / console.error / 页面加载失败。
 *
 * 与 test/run-tests.js 的分工：
 *   - run-tests.js 校验主进程模块与预览模拟层的数据契约（纯 Node，无 DOM）
 *   - 本脚本校验真实 DOM 渲染与交互不会报错（需要 Electron）
 *
 * 用法：
 *   npm run preview        # 另开一个终端启动预览服务
 *   npm run smoke          # 等价于 electron tools/smoke-ui.js
 *
 * 端口可用环境变量 MM_PREVIEW_URL 覆盖。
 */

const path = require('path');
const electron = require('electron');

if (!electron.app) {
  console.error(
    [
      '本脚本必须在 Electron 主进程里运行（不能直接用 node 执行）。',
      '若环境里存在 ELECTRON_RUN_AS_NODE=1，Electron 会退化为纯 Node，请先清除该变量：',
      '  env -u ELECTRON_RUN_AS_NODE npm run smoke        # macOS / Linux',
      '  set ELECTRON_RUN_AS_NODE= && npm run smoke       # Windows CMD',
      '  $env:ELECTRON_RUN_AS_NODE="" ; npm run smoke      # Windows PowerShell',
    ].join('\n'),
  );
  process.exit(1);
}

const { app, BrowserWindow } = electron;

const BASE = process.env.MM_PREVIEW_URL || 'http://127.0.0.1:4173/';
const EXPECT_VERSION = '1.0.2';

const ROUTES = [
  ['dashboard', '总览看板'],
  ['contacts', '推广邮件列表'],
  ['accounts', '发信邮箱配置'],
  ['templates', '推广内容模板'],
  ['campaigns', '推广任务'],
  ['tasks', '定时任务管理'],
  ['bounce', '退信监听'],
  ['delivery', '投递状态跟踪'],
  ['settings', '系统设置'],
];

const results = [];
const runtimeErrors = [];

let finished = false;

function trace(msg) {
  process.stderr.write(`· ${msg}\n`);
}

function check(label, ok, detail) {
  results.push({ label, ok: !!ok, detail: ok ? '' : detail || '' });
}

function recordRuntime(kind, text) {
  runtimeErrors.push(`[${kind}] ${text}`);
}

app.disableHardwareAcceleration();
// CI / 受限环境下 Chromium 自身的沙箱可能无法引导渲染进程（MachPortRendezvous 权限拒绝），
// 导致 loadURL 永远挂起。冒烟窗口只加载本机预览站点、不执行任何外部代码，关掉沙箱是安全的。
app.commandLine.appendSwitch('no-sandbox');

const win = { ref: null };

function runJs(code) {
  return win.ref.webContents.executeJavaScript(`(async () => {\n${code}\n})()`, true);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等页面启动完成（MM.pages 注册齐全 + 首屏渲染结束） */
async function waitBoot(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try {
      ready = await runJs(`
        return !!(window.MM && MM.pages && Object.keys(MM.pages).length >= 9
          && document.getElementById('view') && !/正在加载/.test(document.getElementById('view').innerHTML));
      `);
    } catch (_) {
      ready = false;
    }
    if (ready) return true;
    if (Date.now() > deadline) return false;
    await sleep(180);
  }
}

/** 点击左侧导航切页（走真实的 hashchange 路由） */
async function goto(route) {
  return runJs(`
    const el = document.querySelector('#nav [data-route="${route}"]');
    if (!el) return { navMissing: true };
    el.click();
    await new Promise((r) => setTimeout(r, 750));
    const view = document.getElementById('view');
    return {
      title: (document.getElementById('page-title').textContent || '').trim(),
      active: ((document.querySelector('.nav-item.active') || {}).dataset || {}).route || '',
      hash: location.hash,
      failed: /页面加载失败/.test(view.innerHTML),
      emptyStrong: ((view.querySelector('.empty strong') || {}).textContent || '').trim(),
      panels: view.querySelectorAll('.panel').length,
      cards: view.querySelectorAll('.stat-card').length,
      buttons: view.querySelectorAll('button').length,
    };
  `);
}

async function toastTexts() {
  return runJs(`
    return Array.from(document.querySelectorAll('#toast-layer .toast')).map((n) => n.textContent.trim());
  `);
}

async function clearToasts() {
  await runJs(`document.getElementById('toast-layer').innerHTML = ''; return true;`);
}

/* ------------------------------------------------------------------ *
 * 各页面专项探针
 * ------------------------------------------------------------------ */

async function probeDashboard() {
  return runJs(`
    const view = document.getElementById('view');
    const t = view.textContent;
    const labels = Array.from(view.querySelectorAll('.stat-card .stat-label')).map((n) => n.textContent.trim());
    const quick = Array.from(view.querySelectorAll('.pill-row button')).map((b) => b.textContent.trim());
    return {
      cards: view.querySelectorAll('.stat-card').length,
      labels,
      quick,
      hasBounceCard: labels.includes('退信剔除地址'),
      descHasBounce: /退信监听已剔除|退信剔除/.test(t),
      trendCols: view.querySelectorAll('.trend-col').length,
    };
  `);
}

async function probeContacts() {
  return runJs(`
    const view = document.getElementById('view');
    const heads = Array.from(view.querySelectorAll('table thead th')).map((n) => n.textContent.trim());
    const statusOpts = Array.from(view.querySelectorAll('[data-role="status"] option')).map((o) => o.value);
    // 默认筛选是「仅可发送」，先切到「全部」才能同时看到退信标记行
    const sel = view.querySelector('[data-role="status"]');
    sel.value = 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 650));
    const v = document.getElementById('view');
    return {
      heads,
      hasBounceCol: heads.includes('退信标记'),
      statusOpts,
      hasBulkRelease: !!v.querySelector('[data-act="bulk-release"]'),
      releaseBtns: v.querySelectorAll('[data-role="table"] [data-action="release"]').length,
      markBtns: v.querySelectorAll('[data-role="table"] [data-action="bounce"]').length,
      rows: v.querySelectorAll('[data-role="table"] tbody tr').length,
      rowBadges: v.querySelectorAll('[data-role="table"] tbody .badge').length,
    };
  `);
}

/** 联系人页：切到「已标记退信」筛选并断言列表被收敛 */
async function contactsBounceFilter() {
  return runJs(`
    const view = document.getElementById('view');
    const sel = view.querySelector('[data-role="status"]');
    const before = view.querySelectorAll('[data-role="table"] tbody tr').length;
    sel.value = 'bounceMarked';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const rows = Array.from(view.querySelectorAll('[data-role="table"] tbody tr'));
    return {
      before,
      after: rows.length,
      allHaveRelease: rows.length > 0 && rows.every((r) => !!r.querySelector('[data-action="release"]')),
    };
  `);
}

/** 联系人页：解除一条退信标记（确认弹窗 → 断言标记消失） */
async function contactsReleaseOne() {
  return runJs(`
    const view = document.getElementById('view');
    // 明确切到「已标记退信」筛选，断言不依赖进入本页时残留的筛选状态
    const sel = view.querySelector('[data-role="status"]');
    sel.value = 'bounceMarked';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 650));
    const v = document.getElementById('view');
    const btn = v.querySelector('[data-role="table"] [data-action="release"]');
    if (!btn) return { skipped: '没有任何可解除的退信标记' };
    const rowsBefore = v.querySelectorAll('[data-role="table"] tbody tr').length;
    btn.click();
    await new Promise((r) => setTimeout(r, 320));
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '未弹出确认框' };
    const title = mask.querySelector('.modal-title').textContent.trim();
    const okBtn = mask.querySelector('[data-ok]');
    if (!okBtn) return { error: '确认框缺少确认按钮' };
    okBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      title,
      rowsBefore,
      rowsAfter: document.querySelectorAll('#view [data-role="table"] tbody tr').length,
    };
  `);
}

/** 账号页：打开新增账号弹窗，验证 IMAP 面板显隐与「测试 IMAP 收信」的失败路径可读 */
async function accountsImapPanel() {
  return runJs(`
    const view = document.getElementById('view');
    view.querySelector('[data-act="create"]').click();
    await new Promise((r) => setTimeout(r, 350));
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '新增账号弹窗未打开' };
    const sw = mask.querySelector('[data-role="imap-enabled"]');
    const box = mask.querySelector('[data-role="imap-fields"]');
    const initialHidden = box.classList.contains('hidden');
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    const shownAfterToggle = !box.classList.contains('hidden');
    const hasHost = !!mask.querySelector('[data-role="imap-host"]');
    const hasPass = !!mask.querySelector('[data-role="imap-pass"]');
    const hasMailbox = !!mask.querySelector('[data-role="imap-mailbox"]');
    return { initialHidden, shownAfterToggle, hasHost, hasPass, hasMailbox };
  `);
}

async function accountsTestImapEmpty() {
  return runJs(`
    document.getElementById('toast-layer').innerHTML = '';
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '弹窗已关闭' };
    mask.querySelector('[data-test-imap]').click();
    await new Promise((r) => setTimeout(r, 600));
    const toasts = Array.from(document.querySelectorAll('#toast-layer .toast')).map((n) => n.textContent.trim());
    const stillOpen = !!document.querySelector('#modal-layer .modal-mask');
    return { toasts, stillOpen };
  `);
}

async function closeModal() {
  return runJs(`
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (mask) {
      const cancel = mask.querySelector('[data-cancel]') || mask.querySelector('[data-modal-close]');
      if (cancel) cancel.click();
      else mask.remove();
    }
    await new Promise((r) => setTimeout(r, 260));
    return { remaining: document.querySelectorAll('#modal-layer .modal-mask').length };
  `);
}

/** 模板页：Spintax 统计 + 预览 + 「换一组措辞」 */
async function probeTemplates() {
  return runJs(`
    const view = document.getElementById('view');
    return {
      hasReroll: !!view.querySelector('[data-act="reroll"]'),
      hasSpinInsert: !!view.querySelector('[data-act="insert-spin"]'),
      spinStat: (view.querySelector('[data-role="spintax-stat"]') || {}).textContent || '',
      spinSamples: view.querySelectorAll('[data-role="spintax-samples"] .spin-sample').length,
      previewLabel: (view.querySelector('[data-role="preview-label"]') || {}).textContent || '',
      previewSubject: (view.querySelector('.mail-preview .mail-subject') || {}).textContent || '',
      previewBody: (view.querySelector('.mail-preview') || {}).textContent || '',
      residualVars: /{{/.test((view.querySelector('.mail-preview') || {}).textContent || ''),
    };
  `);
}

async function templatesReroll() {
  return runJs(`
    const view = document.getElementById('view');
    const label = view.querySelector('[data-role="preview-label"]');
    const first = {
      label: label.textContent,
      subject: (view.querySelector('.mail-preview .mail-subject') || {}).textContent || '',
      body: (view.querySelector('.mail-preview') || {}).textContent || '',
    };
    const seen = new Set([first.subject + '||' + first.body]);
    let changed = 0;
    for (let i = 0; i < 6; i += 1) {
      view.querySelector('[data-act="reroll"]').click();
      await new Promise((r) => setTimeout(r, 260));
      const key = ((view.querySelector('.mail-preview .mail-subject') || {}).textContent || '') + '||' +
                  ((view.querySelector('.mail-preview') || {}).textContent || '');
      if (!seen.has(key)) { changed += 1; seen.add(key); }
    }
    return {
      firstLabel: first.label,
      lastLabel: (view.querySelector('[data-role="preview-label"]') || {}).textContent || '',
      distinct: seen.size,
      changed,
    };
  `);
}

/** 推广任务页：打开编辑器，验证账号池 + 发送节奏面板 */
async function campaignsEditor() {
  return runJs(`
    const view = document.getElementById('view');
    const heads = Array.from(view.querySelectorAll('table thead th')).map((n) => n.textContent.trim());
    const pills = Array.from(view.querySelectorAll('.card .pill')).map((n) => n.textContent.trim());
    view.querySelector('[data-act="create"]').click();
    await new Promise((r) => setTimeout(r, 450));
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '任务编辑器未打开', heads };
    const q = (s) => mask.querySelector(s);
    const pacePresets = Array.from(mask.querySelectorAll('[data-role="pace-presets"] [data-preset]')).map((b) => b.dataset.preset);
    const accModeBtns = Array.from(mask.querySelectorAll('[data-role="acc-modes"] button')).map((b) => b.dataset.mode);
    // 切到「多账号轮询」
    const poolBtn = mask.querySelector('[data-role="acc-modes"] button[data-mode="pool"]');
    poolBtn.click();
    await new Promise((r) => setTimeout(r, 160));
    const poolShown = !q('[data-role="acc-pool"]').classList.contains('hidden');
    const singleHidden = q('[data-role="acc-single"]').classList.contains('hidden');
    const poolAccs = mask.querySelectorAll('[data-pool-acc]').length;
    const hasStrategy = !!q('[data-role="accountStrategy"]');
    // 切到「随机延迟」
    const randBtn = mask.querySelector('[data-role="pace-mode"] button[data-mode="random"]');
    randBtn.click();
    await new Promise((r) => setTimeout(r, 160));
    const randShown = !q('[data-role="pace-random-min"]').classList.contains('hidden')
                   && !q('[data-role="pace-random-max"]').classList.contains('hidden');
    const fixedHidden = q('[data-role="pace-fixed"]').classList.contains('hidden');
    return {
      heads, pills, pacePresets, accModeBtns, poolShown, singleHidden, poolAccs, hasStrategy,
      randShown, fixedHidden,
      hasHourly: !!q('[data-role="hourlyLimit"]'),
      hasDaily: !!q('[data-role="dailyLimit"]'),
      hasBurst: !!q('[data-role="burstEvery"]'),
      estimate: (q('[data-role="pace-estimate"]') || {}).textContent || '',
    };
  `);
}

async function campaignsApplyPreset() {
  return runJs(`
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '任务编辑器未打开' };
    const btn = mask.querySelector('[data-role="pace-presets"] [data-preset]');
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const box = mask.querySelector('[data-role="pace-estimate"]');
    return {
      preset: btn.dataset.preset,
      estimate: box.textContent,
      min: mask.querySelector('[data-role="delayMinSeconds"]').value,
      max: mask.querySelector('[data-role="delayMaxSeconds"]').value,
      toasts: Array.from(document.querySelectorAll('#toast-layer .toast')).map((n) => n.textContent.trim()),
    };
  `);
}

/** 池模式下不勾选任何账号直接保存 → 应给出可读校验提示而不是崩 */
async function campaignsPoolValidation() {
  return runJs(`
    document.getElementById('toast-layer').innerHTML = '';
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '任务编辑器未打开' };
    // 名称校验排在账号校验之前，先填名称才能走到账号池校验分支
    const nameEl = mask.querySelector('[data-role="name"]');
    if (nameEl && !nameEl.value.trim()) nameEl.value = '冒烟测试任务';
    mask.querySelectorAll('[data-pool-acc]').forEach((el) => { el.checked = false; });
    const save = mask.querySelector('[data-save]') || mask.querySelector('[data-act="save"]') || mask.querySelector('.btn-primary');
    if (!save) return { error: '未找到保存按钮' };
    save.click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      toasts: Array.from(document.querySelectorAll('#toast-layer .toast')).map((n) => n.textContent.trim()),
      modalAlive: !!document.querySelector('#modal-layer .modal-mask'),
    };
  `);
}

/** 退信监听页 */
async function probeBounce() {
  return runJs(`
    const view = document.getElementById('view');
    const labels = Array.from(view.querySelectorAll('.stat-card .stat-label')).map((n) => n.textContent.trim());
    const accRows = view.querySelectorAll('[data-role="accounts"] tbody tr').length;
    const markedRows = view.querySelectorAll('[data-role="marked"] tbody tr').length;
    const evRows = view.querySelectorAll('[data-role="events"] tbody tr').length;
    const accActs = Array.from(view.querySelectorAll('[data-role="accounts"] [data-act]')).map((b) => b.dataset.act);
    return {
      cards: view.querySelectorAll('.stat-card').length,
      labels,
      accRows,
      markedRows,
      evRows,
      accActs: Array.from(new Set(accActs)),
      hasCheck: !!view.querySelector('[data-act="check"]'),
      hasSaveOptions: !!view.querySelector('[data-act="save-options"]'),
      hasFilters: ['f-account', 'f-type', 'f-matched', 'f-keyword'].every((r) => !!view.querySelector('[data-role="' + r + '"]')),
      optionRoles: ['autoCheck', 'pollMinutes', 'autoMark', 'bounceType'].filter((r) => !!view.querySelector('[data-role="' + r + '"]')),
    };
  `);
}

async function bounceFilters() {
  return runJs(`
    const view = document.getElementById('view');
    const total = view.querySelectorAll('[data-role="events"] tbody tr').length;
    const kindSel = view.querySelector('[data-role="f-type"]');
    kindSel.value = 'hard';
    kindSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 550));
    const hard = view.querySelectorAll('[data-role="events"] tbody tr').length;
    const countText = view.querySelector('[data-role="event-count"]').textContent;
    kindSel.value = 'all';
    kindSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 550));
    const back = view.querySelectorAll('[data-role="events"] tbody tr').length;
    return { total, hard, back, countText };
  `);
}

async function bounceEventDetail() {
  return runJs(`
    const view = document.getElementById('view');
    const btn = view.querySelector('[data-role="events"] [data-act="view-event"]');
    if (!btn) return { skipped: '没有退信事件明细' };
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const mask = document.querySelector('#modal-layer .modal-mask');
    if (!mask) return { error: '详情弹窗未打开' };
    const rows = mask.querySelectorAll('dl.kv dt').length;
    const keys = Array.from(mask.querySelectorAll('dl.kv dt')).map((n) => n.textContent.trim());
    const title = mask.querySelector('.modal-title').textContent.trim();
    return { title, rows, keys };
  `);
}

async function bounceSaveOptions() {
  return runJs(`
    document.getElementById('toast-layer').innerHTML = '';
    const view = document.getElementById('view');
    const box = view.querySelector('[data-role="pollMinutes"]');
    const old = box.value;
    box.value = '17';
    view.querySelector('[data-act="save-options"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const toasts = Array.from(document.querySelectorAll('#toast-layer .toast')).map((n) => n.textContent.trim());
    const after = (document.querySelector('#view [data-role="pollMinutes"]') || {}).value;
    return { old, after, toasts, saved: after === '17' };
  `);
}

/** 设置页：默认节奏预览 + IMAP 全局开关 */
async function probeSettings() {
  const first = await runJs(`
    const view = document.getElementById('view');
    return {
      pacePreview: (view.querySelector('[data-role="pace-preview"]') || {}).textContent || '',
      presets: Array.from(view.querySelectorAll('[data-role="pace-presets"] [data-preset]')).map((b) => b.dataset.preset),
      hasImapPanel: /IMAP 退信监听/.test(view.textContent),
      hasImapAutoCheck: !!view.querySelector('[data-role="imapAutoCheck"]'),
      hasImapPoll: !!view.querySelector('[data-role="imapPollMinutes"]'),
      hasImapType: !!view.querySelector('[data-role="imapBounceType"]'),
      hasImapAutoMark: !!view.querySelector('[data-role="imapAutoMarkBounce"]'),
      versionLine: '',
      gotoBounce: !!view.querySelector('[data-act="goto-bounce"]'),
    };
  `);
  const pace = await runJs(`
    const view = document.getElementById('view');
    // 切到随机模式 → 预览文案应随主进程 pacing.describe 变化
    const before = (view.querySelector('[data-role="pace-preview"]') || {}).textContent || '';
    view.querySelector('[data-role="pace-mode"] button[data-mode="fixed"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const fixed = (view.querySelector('[data-role="pace-preview"]') || {}).textContent || '';
    view.querySelector('[data-role="pace-mode"] button[data-mode="random"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const random = (view.querySelector('[data-role="pace-preview"]') || {}).textContent || '';
    return { before, fixed, random };
  `);
  return Object.assign(first, pace);
}

async function probeDelivery() {
  return runJs(`
    const view = document.getElementById('view');
    const t = view.textContent;
    const heads = Array.from(view.querySelectorAll('table thead th')).map((n) => n.textContent.trim());
    return {
      heads,
      hasGotoBounce: !!view.querySelector('[data-act="goto-bounce"]'),
      mentionsImap: /IMAP/.test(t),
      hasResend: !!view.querySelector('[data-act="resend"]'),
      cards: view.querySelectorAll('.stat-card').length,
    };
  `);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  win.ref = new BrowserWindow({
    show: false,
    width: 1500,
    height: 1000,
    webPreferences: {
      // 冒烟窗口需要真实页面上下文里的错误钩子，因此关闭上下文隔离并挂载专用 preload
      preload: path.join(__dirname, 'smoke-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const wc = win.ref.webContents;

  let loadFailed = null;
  wc.on('did-fail-load', (_e, code, desc, url) => {
    loadFailed = `did-fail-load ${code} ${desc} ${url}`;
  });
  wc.on('render-process-gone', (_e, details) => {
    loadFailed = `渲染进程异常退出：${details && details.reason}（exitCode=${details && details.exitCode}）`;
    recordRuntime('渲染进程崩溃', loadFailed);
  });

  trace(`加载预览站点 ${BASE}`);
  await wc.loadURL(BASE);
  trace('页面已加载，等待启动完成');

  // ---- 启动 ----
  const booted = await waitBoot();
  trace(`启动完成=${booted}`);
  check('预览站点可加载并完成启动', !loadFailed && booted, loadFailed || '15 秒内未完成启动（MM.pages 未注册齐全）');
  if (loadFailed) {
    finish();
    return;
  }

  const shell = await runJs(`
    return {
      pages: Object.keys(window.MM.pages),
      ver: (document.getElementById('app-ver').textContent || '').trim(),
      modeText: (document.querySelector('#mode-chip .mode-text') || {}).textContent || '',
      navItems: Array.from(document.querySelectorAll('#nav .nav-item')).map((n) => n.dataset.route),
      windowControlsHidden: document.querySelector('.window-controls').classList.contains('hidden'),
    };
  `);
  check('九个页面模块全部注册', ROUTES.every(([r]) => shell.pages.includes(r)), `实际：${shell.pages.join(',')}`);
  check('导航项与路由一一对应', ROUTES.every(([r]) => shell.navItems.includes(r)), `实际：${shell.navItems.join(',')}`);
  check(`版本号显示为 v${EXPECT_VERSION}`, shell.ver.includes(EXPECT_VERSION), `实际：${shell.ver}`);
  check('浏览器预览模式隐藏无边框窗口按钮', shell.windowControlsHidden === true);

  // ---- 逐页渲染 ----
  for (const [route, expectedTitle] of ROUTES) {
    const r = await goto(route);
    check(`[${route}] 页面可渲染（标题「${expectedTitle}」）`, !r.failed && r.title === expectedTitle && r.active === route,
      r.failed ? `渲染抛错：${r.emptyStrong || '页面加载失败'}` : `标题=${r.title} active=${r.active} hash=${r.hash}`);
    check(`[${route}] 渲染出实质内容`, r.panels > 0 && r.buttons > 0, `panel=${r.panels} button=${r.buttons}`);
  }

  // ---- 总览看板 ----
  await goto('dashboard');
  const dash = await probeDashboard();
  check('总览看板：含「退信剔除地址」统计卡', dash.hasBounceCard, `实际卡片：${dash.labels.join(' / ')}`);
  check('总览看板：统计卡数量充足', dash.cards >= 10, `实际 ${dash.cards} 张`);
  check('总览看板：快捷操作含「退信监听」', dash.quick.includes('退信监听'), `实际：${dash.quick.join(' / ')}`);
  check('总览看板：近 14 天趋势图渲染完成', dash.trendCols === 14, `实际 ${dash.trendCols} 列`);

  // ---- 联系人页 ----
  await goto('contacts');
  const ct = await probeContacts();
  check('联系人页：表格含「退信标记」列', ct.hasBounceCol, `实际表头：${ct.heads.join(' / ')}`);
  check('联系人页：状态筛选含 bounceMarked', ct.statusOpts.includes('bounceMarked'), `实际：${ct.statusOpts.join(',')}`);
  check('联系人页：存在「批量解除退信标记」入口', ct.hasBulkRelease);
  check('联系人页：行内提供解除 / 标记退信按钮', ct.releaseBtns > 0 && ct.markBtns > 0,
    `解除 ${ct.releaseBtns} 个 · 标记 ${ct.markBtns} 个 · 共 ${ct.rows} 行`);

  const cf = await contactsBounceFilter();
  check('联系人页：筛选「已标记退信」后列表收敛且都带解除按钮', cf.after > 0 && cf.after <= cf.before && cf.allHaveRelease,
    `筛选前 ${cf.before} 行 → 筛选后 ${cf.after} 行，全带解除按钮=${cf.allHaveRelease}`);

  // ---- 账号页 ----
  await goto('accounts');
  const accPanel = await accountsImapPanel();
  check('账号页：新增账号弹窗含 IMAP 面板且默认折叠', !accPanel.error && accPanel.initialHidden === true && accPanel.hasHost && accPanel.hasPass && accPanel.hasMailbox,
    accPanel.error || JSON.stringify(accPanel));
  check('账号页：打开 IMAP 开关后字段区展开', accPanel.shownAfterToggle === true, JSON.stringify(accPanel));

  await clearToasts();
  const imapEmpty = await accountsTestImapEmpty();
  check('账号页：IMAP 未填时测试收信给出可读提示且不崩', !imapEmpty.error && imapEmpty.toasts.length > 0 && imapEmpty.stillOpen,
    imapEmpty.error || `toast：${imapEmpty.toasts.join(' | ')}`);
  const closed = await closeModal();
  check('账号页：弹窗可正常关闭', closed.remaining === 0, `残留 ${closed.remaining} 个弹窗`);

  // ---- 模板页 ----
  await goto('templates');
  const tpl = await probeTemplates();
  check('模板页：「换一组措辞」与「插入 Spintax」按钮存在', tpl.hasReroll && tpl.hasSpinInsert);
  check('模板页：Spintax 变体统计已生成', /种不同内容/.test(tpl.spinStat), `实际：${tpl.spinStat.slice(0, 120)}`);
  check('模板页：随机抽样样例渲染完成', tpl.spinSamples > 0, `样例 ${tpl.spinSamples} 条`);
  check('模板页：实时预览已填充且变量全部替换', tpl.previewSubject.length > 0 && tpl.previewBody.length > 0 && !tpl.residualVars,
    `主题=${tpl.previewSubject.slice(0, 40)} 残留变量=${tpl.residualVars}`);
  check('模板页：预览标签显示「第 N / M 种措辞」', /第 \d+ \/ \d+ 种措辞/.test(tpl.previewLabel), `实际：${tpl.previewLabel}`);

  const reroll = await templatesReroll();
  check('模板页：「换一组措辞」连续点击产生多个不同版本', reroll.distinct >= 3,
    `点击 6 次共出现 ${reroll.distinct} 种内容（首标签：${reroll.firstLabel.slice(0, 60)}）`);

  // ---- 推广任务页 ----
  await goto('campaigns');
  const camp = await campaignsEditor();
  check('推广任务页：任务编辑器可打开', !camp.error, camp.error || '');
  check('推广任务页：四个节奏预设齐全', (camp.pacePresets || []).length === 4, `实际：${(camp.pacePresets || []).join(',')}`);
  check('推广任务页：账号模式可在「单个 / 多账号轮询」间切换', (camp.accModeBtns || []).includes('pool') && (camp.accModeBtns || []).includes('single'),
    `实际：${(camp.accModeBtns || []).join(',')}`);
  check('推广任务页：切到轮询后展示账号勾选与轮询策略', camp.poolShown && camp.singleHidden && camp.poolAccs > 0 && camp.hasStrategy,
    `池区显示=${camp.poolShown} 单账号隐藏=${camp.singleHidden} 可选账号=${camp.poolAccs} 有策略选择=${camp.hasStrategy}`);
  check('推广任务页：切到随机延迟后字段区正确切换', camp.randShown && camp.fixedHidden,
    `随机字段显示=${camp.randShown} 固定字段隐藏=${camp.fixedHidden}`);
  check('推广任务页：速率控制字段齐全（每小时 / 每日 / 长停顿）', camp.hasHourly && camp.hasDaily && camp.hasBurst);
  check('推广任务页：节奏说明文案非空', (camp.estimate || '').length > 0, `实际：${(camp.estimate || '').slice(0, 80)}`);

  const preset = await campaignsApplyPreset();
  check('推广任务页：套用节奏预设后最小/最大延迟被写入', Number(preset.max) >= Number(preset.min) && Number(preset.min) > 0,
    `min=${preset.min} max=${preset.max}`);
  check('推广任务页：套用预设后给出提示', (preset.toasts || []).some((t) => /已套用节奏预设/.test(t)), `toast：${(preset.toasts || []).join(' | ')}`);

  await clearToasts();
  const poolVal = await campaignsPoolValidation();
  check('推广任务页：轮询未勾选账号时保存给出可读校验', (poolVal.toasts || []).some((t) => /至少需要勾选 2 个/.test(t)),
    poolVal.error || `toast：${(poolVal.toasts || []).join(' | ')}`);
  const campClosed = await closeModal();
  check('推广任务页：编辑器可关闭', campClosed.remaining === 0, `残留 ${campClosed.remaining} 个弹窗`);

  // ---- 退信监听页 ----
  await goto('bounce');
  const bo = await probeBounce();
  check('退信监听页：四张统计卡齐全', bo.cards === 4 && bo.labels.includes('已标记退信地址') && bo.labels.includes('退信事件总数'),
    `实际 ${bo.cards} 张：${bo.labels.join(' / ')}`);
  check('退信监听页：各账号监听状态表渲染完成', bo.accRows > 0, `实际 ${bo.accRows} 行`);
  check('退信监听页：已标记退信地址表渲染完成', bo.markedRows > 0, `实际 ${bo.markedRows} 行`);
  check('退信监听页：退信事件明细渲染完成', bo.evRows > 0, `实际 ${bo.evRows} 行`);
  check('退信监听页：账号行提供检查 / 测试 / 去配置三个动作',
    ['check-one', 'test', 'goto-account'].every((a) => bo.accActs.includes(a)), `实际：${bo.accActs.join(',')}`);
  check('退信监听页：监听总开关四项设置齐全', (bo.optionRoles || []).length === 4, `实际：${(bo.optionRoles || []).join(',')}`);
  check('退信监听页：事件筛选器齐全', bo.hasFilters && bo.hasCheck && bo.hasSaveOptions);

  const bf = await bounceFilters();
  check('退信监听页：按退信类型筛选生效', bf.hard > 0 && bf.hard <= bf.total && bf.back === bf.total,
    `全部 ${bf.total} → 硬退信 ${bf.hard} → 复原 ${bf.back}（${bf.countText}）`);

  const detail = await bounceEventDetail();
  check('退信监听页：退信事件详情弹窗字段完整', !detail.error && detail.rows >= 14 && detail.keys.includes('原邮件 Message-ID'),
    detail.error || `字段 ${detail.rows} 项：${(detail.keys || []).join('/')}`);
  await closeModal();

  await clearToasts();
  const sv = await bounceSaveOptions();
  check('退信监听页：保存监听设置后轮询间隔被持久化', sv.saved === true, `${sv.old} → ${sv.after}`);
  check('退信监听页：保存后给出成功提示', (sv.toasts || []).some((t) => /退信监听设置已保存/.test(t)), `toast：${(sv.toasts || []).join(' | ')}`);

  // ---- 解除退信标记（放在退信监听页之后：解除会减少「已标记地址」，先跑完计数类断言） ----
  await goto('contacts');
  await clearToasts();
  const rel = await contactsReleaseOne();
  check('联系人页：解除退信标记走确认框并生效', !rel.error && rel.title === '解除退信标记' && rel.rowsAfter === rel.rowsBefore - 1,
    rel.error || `确认框标题=${rel.title} ${rel.rowsBefore}→${rel.rowsAfter} 行`);
  const relToast = await toastTexts();
  check('联系人页：解除后给出成功提示', relToast.some((t) => /已解除退信标记/.test(t)), `toast：${relToast.join(' | ')}`);

  // 解除后回到退信监听页，确认「已标记退信地址」计数同步下降
  await goto('bounce');
  const markedAfter = await runJs(`
    const view = document.getElementById('view');
    return {
      rows: view.querySelectorAll('[data-role="marked"] tbody tr').length,
      value: (view.querySelector('.stat-card .stat-value') && view.querySelectorAll('.stat-card')[1].textContent) || '',
    };
  `);
  check('退信监听页：解除标记后已标记地址数量同步下降', markedAfter.rows === rel.rowsBefore - 1,
    `解除前 ${rel.rowsBefore} 行 → 解除后 ${markedAfter.rows} 行`);

  // ---- 投递状态页 ----
  await goto('delivery');
  const dv = await probeDelivery();
  check('投递状态页：提供「退信监听」跳转入口', dv.hasGotoBounce);
  check('投递状态页：页头区分 IMAP 事后退信回执', dv.mentionsImap, `页面文本未出现 IMAP`);

  // ---- 系统设置页 ----
  await goto('settings');
  const st = await probeSettings();
  check('系统设置页：默认发送节奏预览由主进程生成', /当前默认节奏/.test(st.pacePreview), `实际：${st.pacePreview.slice(0, 80)}`);
  check('系统设置页：节奏预设齐全', st.presets.length === 4, `实际：${st.presets.join(',')}`);
  check('系统设置页：切换间隔模式后预览文案随之变化', st.fixed.length > 0 && st.random.length > 0 && st.fixed !== st.random,
    `固定：「${st.fixed.slice(0, 60)}」 随机：「${st.random.slice(0, 60)}」`);
  check('系统设置页：含 IMAP 退信监听面板且四个全局字段齐全',
    st.hasImapPanel && st.hasImapAutoCheck && st.hasImapPoll && st.hasImapType && st.hasImapAutoMark,
    JSON.stringify({ panel: st.hasImapPanel, autoCheck: st.hasImapAutoCheck, poll: st.hasImapPoll, type: st.hasImapType, autoMark: st.hasImapAutoMark }));
  check('系统设置页：提供「退信监听」跳转入口', st.gotoBounce);

  // ---- 收尾：全量切页一遍，确认没有残留定时器 / 弹窗导致的报错 ----
  for (const [route] of ROUTES) {
    await goto(route);
  }
  await sleep(600);
  const leftovers = await runJs(`
    return {
      modals: document.querySelectorAll('#modal-layer .modal-mask').length,
      toasts: document.querySelectorAll('#toast-layer .toast').length,
      route: window.MM.state.route,
    };
  `);
  check('反复切换全部页面后无弹窗残留', leftovers.modals === 0, `残留 ${leftovers.modals} 个弹窗`);

  // ---- 收集页面内捕获到的运行时报错 ----
  const captured = await runJs(`return window.__smokeErrors || [];`);
  captured.forEach((m) => recordRuntime('页面内', m));
  trace(`页面内捕获到的报错 ${captured.length} 条`);

  finish();
}

function finish() {
  if (finished) return;
  finished = true;
  const failed = results.filter((r) => !r.ok);
  const width = 62;

  console.log('\n================= 无头 UI 冒烟测试 =================');
  results.forEach((r) => {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.label}${r.detail ? `\n      ↳ ${r.detail}` : ''}`);
  });

  console.log('\n----------------- 运行时报错 ----------------');
  if (runtimeErrors.length) {
    Array.from(new Set(runtimeErrors)).forEach((e) => console.log(`  ✗ ${e}`));
  } else {
    console.log('  无未捕获异常 / 无 console.error');
  }

  console.log('\n' + '='.repeat(width));
  console.log(`冒烟结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项，运行时报错 ${new Set(runtimeErrors).size} 条`);
  console.log('='.repeat(width) + '\n');

  const code = failed.length || runtimeErrors.length ? 1 : 0;
  if (win.ref && !win.ref.isDestroyed()) win.ref.destroy();
  app.exit(code);
}

app.whenReady().then(() => {
  // 看门狗：任何环节卡住（渲染进程无响应 / CDP 无回应）都能拿到半成品报告而不是静默挂死
  setTimeout(() => {
    if (finished) return;
    check('整体流程在 120 秒内跑完', false, '超时：脚本被看门狗强制结束');
    recordRuntime('超时', '冒烟流程超过 120 秒未结束');
    finish();
  }, 120000).unref();

  trace('Electron 就绪，开始冒烟');
  main().catch((err) => {
    check('冒烟流程未抛出异常', false, err && err.message ? err.message : String(err));
    console.error('冒烟测试异常终止：', err);
    finish();
  });
});
