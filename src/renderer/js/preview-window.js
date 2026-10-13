/* MailMaster 独立邮件预览窗口
 *
 * 该窗口由主界面的「独立窗口预览」按钮通过 window.open('preview.html?k=<nonce>') 打开，
 * 打开后主动向 opener 请求内容（非一次性握手，带重试），收到后按完整尺寸渲染。
 *
 * 三处兜底，保证窗口即使被刷新/opener 已关闭也能看到内容：
 *   1) opener 首次应答即渲染；
 *   2) 最多轮询 3 秒索要内容；
 *   3) 仍未收到则读取 localStorage 中最近一次的预览内容。
 */
(function () {
  'use strict';

  var LAST_KEY = 'mm-mail-preview-last';
  var REQUEST_INTERVAL = 250;
  var MAX_REQUESTS = 12;

  var stage = document.getElementById('pv-stage');
  var subtitle = document.getElementById('pv-subtitle');
  var widthSel = document.getElementById('pv-width');
  var fontSel = document.getElementById('pv-font');

  var nonce = '';
  try {
    nonce = new URLSearchParams(window.location.search).get('k') || '';
  } catch (_) {
    nonce = '';
  }

  /* ------------------------- 偏好设置 ------------------------- */
  var PREF_KEY = 'mm-mail-preview-prefs';

  function readPrefs() {
    try {
      var raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (raw.width != null) widthSel.value = String(raw.width);
      if (raw.font != null) fontSel.value = String(raw.font);
    } catch (_) {
      /* ignore */
    }
  }

  function applyPrefs() {
    var w = Number(widthSel.value) || 0;
    stage.style.maxWidth = w ? w + 'px' : '100%';
    stage.style.fontSize = (Number(fontSel.value) || 15) + 'px';
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ width: widthSel.value, font: fontSel.value }));
    } catch (_) {
      /* ignore */
    }
  }

  readPrefs();
  applyPrefs();
  widthSel.onchange = applyPrefs;
  fontSel.onchange = applyPrefs;

  document.getElementById('pv-print').onclick = function () {
    window.print();
  };
  document.getElementById('pv-close').onclick = function () {
    window.close();
  };

  /* ------------------------- 工具 ------------------------- */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(input) {
    var d = input ? new Date(input) : new Date();
    if (isNaN(d.getTime())) return '—';
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    );
  }

  /* ------------------------- 渲染 ------------------------- */
  function render(payload) {
    var d = payload || {};
    var c = d.contact || {};
    var from = d.from || {};
    var subject = d.subject || '（无主题）';
    var recipient = c.contact || d.to || '—';
    var salutation = c.salutation ? '（' + c.salutation + '）' : '';
    var senderEmail = from.email || '';
    var recipientEmail = c.email || d.to || '';

    document.title = '邮件预览 · ' + subject;
    subtitle.textContent = [d.templateName, c.company].filter(Boolean).join(' · ') || '完整尺寸预览';

    var missing = d.missing && d.missing.length ? d.missing : [];

    stage.innerHTML =
      '<article class="pv-mail">' +
      '<div class="pv-head">' +
      '<h1 class="pv-subject">' +
      esc(subject) +
      '</h1>' +
      '<div class="pv-meta">' +
      '<div class="pv-meta-row"><span class="k">发件人</span><span class="v">' +
      (from.name ? esc(from.name) + ' ' : '') +
      '<span class="mono">' +
      esc(senderEmail || '（未配置发信邮箱）') +
      '</span></span></div>' +
      '<div class="pv-meta-row"><span class="k">收件人</span><span class="v">' +
      esc(recipient) +
      esc(salutation) +
      (recipientEmail ? ' <span class="mono">' + esc(recipientEmail) + '</span>' : '') +
      '</span></div>' +
      (c.company ? '<div class="pv-meta-row"><span class="k">公司</span><span class="v">' + esc(c.company) + '</span></div>' : '') +
      '<div class="pv-meta-row"><span class="k">时间</span><span class="v">' +
      esc(fmtTime(d.at)) +
      '</span></div>' +
      '</div>' +
      '</div>' +
      (missing.length ? '<div class="pv-warn">以下变量在样例联系人中没有值，实际发送时会被替换为空：' + esc(missing.join('、')) + '</div>' : '') +
      '<div class="pv-body">' +
      esc(d.body || '（正文为空）') +
      '</div>' +
      '<div class="pv-foot">本预览用于检查邮件排版与变量替换结果，实际显示效果取决于收件人所用的邮箱客户端。</div>' +
      '</article>';
  }

  function loadFallback() {
    var raw = null;
    try {
      raw = localStorage.getItem(LAST_KEY);
    } catch (_) {
      raw = null;
    }
    if (raw) {
      try {
        render(JSON.parse(raw));
        return true;
      } catch (_) {
        /* ignore */
      }
    }
    stage.innerHTML =
      '<div class="pv-empty"><strong>没有收到邮件内容</strong>请回到 MailMaster 主窗口，在预览区点击「独立窗口预览」重新打开。</div>';
    return false;
  }

  /* ------------------------- 与 opener 握手 ------------------------- */
  var received = false;
  var tries = 0;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onMessage(event) {
    var d = event.data;
    if (!d || d.type !== 'mm-mail-preview-data') return;
    if (nonce && d.nonce !== nonce) return;
    if (received) return;
    received = true;
    stopPolling();
    render(d.payload);
  }

  var pollTimer = setInterval(function () {
    if (received) {
      stopPolling();
      return;
    }
    try {
      if (window.opener) window.opener.postMessage({ type: 'mm-mail-preview-ready', nonce: nonce }, '*');
    } catch (_) {
      /* ignore */
    }
    tries += 1;
    if (tries >= MAX_REQUESTS) {
      stopPolling();
      if (!received) loadFallback();
    }
  }, REQUEST_INTERVAL);

  window.addEventListener('message', onMessage);
})();
