'use strict';

/**
 * 渲染层安全桥：仅暴露白名单能力，渲染层无法直接访问 Node/文件系统。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

const api = {
  // 应用
  info: () => invoke('app:info'),
  openDataDir: () => invoke('app:openDataDir'),
  minimize: () => invoke('app:minimize'),
  toggleMaximize: () => invoke('app:toggleMaximize'),
  close: () => invoke('app:close'),

  // 总览
  overview: () => invoke('overview:get'),

  // 设置
  getSettings: () => invoke('settings:get'),
  saveSettings: (payload) => invoke('settings:save', payload),
  testSmtp: (payload) => invoke('settings:testSmtp', payload),

  // 发信邮箱账号
  listAccounts: () => invoke('accounts:list'),
  saveAccount: (payload) => invoke('accounts:save', payload),
  removeAccount: (id) => invoke('accounts:remove', { id }),
  setDefaultAccount: (id) => invoke('accounts:setDefault', { id }),
  testAccount: (payload) => invoke('accounts:test', payload),
  querySesQuota: (payload) => invoke('accounts:quota', payload),

  // 联系人
  listContacts: (query) => invoke('contacts:list', query),
  saveContact: (payload) => invoke('contacts:save', payload),
  removeContacts: (ids) => invoke('contacts:remove', { ids }),
  markContactBounced: (payload) => invoke('contacts:markBounced', payload),
  exportContactsCsv: (query) => invoke('contacts:exportCsv', query),
  importContactsFile: (options) => invoke('contacts:importCsvFile', options),
  importContactsText: (payload) => invoke('contacts:importCsvText', payload),

  // 模板
  listTemplates: () => invoke('templates:list'),
  saveTemplate: (payload) => invoke('templates:save', payload),
  removeTemplate: (id) => invoke('templates:remove', { id }),
  templateFields: () => invoke('templates:fields'),
  scanTemplate: (payload) => invoke('templates:scan', payload),
  previewTemplate: (payload) => invoke('templates:preview', payload),
  spintaxInfo: (payload) => invoke('templates:spintax', payload),

  // 推广任务
  listCampaigns: () => invoke('campaigns:list'),
  saveCampaign: (payload) => invoke('campaigns:save', payload),
  removeCampaign: (id) => invoke('campaigns:remove', { id }),
  previewCampaignAudience: (audience) => invoke('campaigns:preview', { audience }),
  runCampaign: (payload) => invoke('campaigns:run', payload),
  pauseCampaign: (payload) => invoke('campaigns:pause', payload),
  cancelCampaign: (id) => invoke('campaigns:cancel', { id }),
  campaignNextRuns: (id) => invoke('campaigns:nextRuns', { id }),
  pacingMeta: () => invoke('pacing:meta'),
  paceEstimate: (payload) => invoke('campaigns:paceEstimate', payload),

  // 投递状态
  listLogs: (query) => invoke('logs:list', query),
  exportLogsCsv: (query) => invoke('logs:exportCsv', query),
  logMailPreview: (payload) => invoke('logs:mailPreview', payload),
  resendLog: (payload) => invoke('logs:resend', payload),

  // 退信监听（IMAP）
  bounceState: () => invoke('bounce:state'),
  checkBounces: (payload) => invoke('bounce:check', payload),
  listBounces: (query) => invoke('bounce:list', query),
  releaseBounce: (payload) => invoke('bounce:release', payload),
  testImap: (payload) => invoke('bounce:test', payload),
  releaseContactBounce: (payload) => invoke('contacts:releaseBounce', payload),

  // 维护
  recomputeStats: () => invoke('maintenance:recomputeStats'),
  pruneLogs: (days) => invoke('maintenance:pruneLogs', { days }),
  recalcSchedule: () => invoke('maintenance:recalcSchedule'),

  /** 订阅主进程推送（任务进度 / 日志 / 提示） */
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('push:event', listener);
    return () => ipcRenderer.removeListener('push:event', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('appEnv', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
