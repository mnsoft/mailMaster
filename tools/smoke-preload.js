'use strict';

/**
 * 冒烟测试专用 preload（配合 tools/smoke-ui.js 使用，contextIsolation: false）。
 *
 * 目的：在真实页面上下文里收集未捕获异常 / 未处理的 Promise 拒绝 / console.error，
 * 供主进程在断言结束后一次性读取。
 *
 * 注意：本文件**不能**定义 window.api —— 预览站点依赖 window.api 缺失来判断
 * 「当前是浏览器预览模式」，从而加载 dev-mock.js 的内存模拟层。
 */

window.__smokeErrors = [];

window.addEventListener('error', (event) => {
  const where = `${String(event.filename || '').split('/').pop()}:${event.lineno}:${event.colno}`;
  window.__smokeErrors.push(`[未捕获异常] ${event.message} @ ${where}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const text = (reason && (reason.message || reason.toString())) || String(reason);
  window.__smokeErrors.push(`[未处理的 Promise 拒绝] ${text}`);
});

const originalError = console.error.bind(console);
console.error = function patchedConsoleError(...args) {
  try {
    window.__smokeErrors.push(`[console.error] ${args.map((a) => (a && a.message) || String(a)).join(' ')}`);
  } catch (_) {
    /* 忽略收集过程中的任何异常，不能影响原日志 */
  }
  originalError(...args);
};
