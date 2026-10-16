'use strict';

/**
 * MailMaster 主进程入口
 * 邮件定时推广助手 · Windows 10 桌面应用
 */

const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const { Database } = require('./db');
const { CampaignRunner } = require('./engine');
const { Scheduler } = require('./scheduler');
const { IpcBridge } = require('./ipc');
const { BounceWatcher } = require('./bounce-watcher');

const isDev = process.argv.includes('--dev');

// 单实例：推广任务调度器必须全局唯一，避免重复发送
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.mailmaster.desktop');
app.disableHardwareAcceleration();

let mainWindow = null;
let tray = null;
let db = null;
let runner = null;
let scheduler = null;
let bridge = null;
let bounceWatcher = null;

const DAY_MS = 24 * 3600 * 1000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#12151c',
    title: 'MailMaster · 邮件定时推广助手',
    autoHideMenuBar: true,
    // 无边框窗口 + 界面内自定义标题栏（侧栏与顶栏已设置拖拽区域，窗口按钮通过 IPC 控制）
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 独立邮件预览窗口：本地预览页允许以独立窗口打开（按完整尺寸查看邮件样式）
    if (/\/preview\.html(\?|#|$)/.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1040,
          height: 940,
          minWidth: 480,
          minHeight: 420,
          show: true,
          title: '邮件预览 · MailMaster',
          backgroundColor: '#eef1f6',
          autoHideMenuBar: true,
          frame: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
          },
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 无边框窗口下最大化状态变化时通知界面（便于按钮图标联动）
  mainWindow.on('maximize', () => mainWindow.webContents.send('push:event', { type: 'window-maximized', maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('push:event', { type: 'window-maximized', maximized: false }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVR42u2SMQ6AIAxFX40n8AqewMHJwSv0AB7BwSt4AgcHJy/gCRwcnaQDGUkDDVQaBid/0pS+/LZpgKIoiqL8UwBmZmbPzLyZWW7u7u7uZmbWzKyZ2TwzMzNvZmbNzJqZzTMzM/8AtPQCUpVxv3EAAAAASUVORK5CYII=',
    );
    tray = new Tray(icon);
    tray.setToolTip('MailMaster · 邮件定时推广助手');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开主界面', click: () => (mainWindow ? mainWindow.show() : createWindow()) },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
    tray.on('double-click', () => (mainWindow ? mainWindow.show() : createWindow()));
  } catch (err) {
    console.warn('[tray] 托盘创建失败（无桌面环境时正常）：', err.message);
  }
}

app.whenReady().then(() => {
  db = new Database();
  db.init(app.getPath('userData'));

  // 日志保留策略
  const settings = db.getSettings();
  if (settings.logRetentionDays > 0) {
    try {
      db.pruneLogs(settings.logRetentionDays);
    } catch (_) {
      /* ignore */
    }
  }

  const push = (payload) => {
    if (bridge) bridge.push(payload);
  };

  runner = new CampaignRunner(db, (payload) => {
    push(payload);
    // 任务结束后刷新总览数据
    if (payload && payload.type === 'campaign') push({ type: 'overview-dirty' });
  });

  scheduler = new Scheduler(db, (campaign, reason) => runner.runCampaign(campaign.id, { reason }), push);

  // IMAP 退信监听：定时轮询收件箱，自动标记退信地址并从发送列表剔除
  bounceWatcher = new BounceWatcher(db, push);

  bridge = new IpcBridge({ db, runner, scheduler, bounceWatcher, getWindow: () => mainWindow });
  bridge.register();

  createWindow();
  createTray();
  scheduler.start();
  bounceWatcher.start();
  // 启动后延迟 20 秒做一次退信检查，避免与界面首屏加载抢资源
  setTimeout(() => {
    if (!db.getSettings().imapAutoCheck) return;
    bounceWatcher.checkNow({ reason: 'startup' }).catch((err) => console.error('[bounce] 启动检查失败', err.message));
  }, 20000).unref();

  // 每日 0 点后按天重置的配额依赖日志按日统计，无需额外定时；这里做一次数据自检
  setInterval(() => {
    try {
      db.flush();
    } catch (_) {
      /* ignore */
    }
  }, 5 * 60 * 1000).unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // 定时推广应用：关闭窗口后驻留托盘继续执行定时任务（Windows 行为）
  if (process.platform === 'darwin') {
    if (process.argv.includes('--quit-on-close')) app.quit();
  }
});

app.on('before-quit', () => {
  if (scheduler) scheduler.stop();
  if (bounceWatcher) bounceWatcher.stop();
  if (db) db.flush();
});

process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常：', err);
});

module.exports = { DAY_MS };
