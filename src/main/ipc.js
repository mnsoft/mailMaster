'use strict';

/**
 * 主进程 IPC 处理器：渲染层所有能力都从这里进出。
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, app } = require('electron');
const { CONTACT_FIELDS, GLOBAL_FIELDS, listVariables, renderMessage, buildGlobalContext, describeSpintax } = require('./template');
const { describeSchedule, formatDateTime, scheduleNextRun } = require('./scheduler');
const { PRESETS: PACING_PRESETS, normalize: normalizePacing, describe: describePacing, estimateMs: estimatePacing, humanizeMs } = require('./pacing');
const { STRATEGIES: ACCOUNT_STRATEGIES } = require('./account-pool');
const mailer = require('./mailer');
const tencentSes = require('./tencent-ses');

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

class IpcBridge {
  constructor({ db, runner, scheduler, bounceWatcher, getWindow }) {
    this.db = db;
    this.runner = runner;
    this.scheduler = scheduler;
    this.bounceWatcher = bounceWatcher;
    this.getWindow = getWindow;
  }

  push(payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('push:event', payload);
  }

  /** 按渠道测试发信账号连通性：SMTP 走协议校验，腾讯云走接口调用 */
  async testAccount(account) {
    if (!account) throw new Error('请先填写发信账号信息');
    if (account.provider === 'tencent-ses') {
      if (!account.ses || !account.ses.secretId || !account.ses.secretKey) throw new Error('请先填写腾讯云 SecretId 与 SecretKey');
      return tencentSes.verifyAccount(account);
    }
    if (!account.host) throw new Error('请先填写 SMTP 服务器地址');
    return mailer.verifyTransport(account);
  }

  /** 查询腾讯云邮件推送额度：优先接口返回，同时给出本地统计兜底 */
  async queryQuota(account) {
    const local = {
      todayUsed: this.db.accountUsageToday(account.email),
      monthUsed: this.db.accountUsageMonth(account.email),
      totalUsed: this.db.accountUsageTotal(account.email),
      freeQuotaTotal: Number(account.ses?.freeQuotaTotal) || 1000,
    };
    local.freeQuotaRemainingLocal = Math.max(0, local.freeQuotaTotal - local.totalUsed);

    if (!account.ses || !account.ses.secretId || !account.ses.secretKey) {
      return {
        ok: false,
        remote: false,
        local,
        message: '未配置 SecretId / SecretKey，无法查询腾讯云端额度，以下为本应用记录的本地用量',
      };
    }
    const remote = await tencentSes.queryQuota(account);
    return { ok: remote.ok, remote: true, local, quota: remote.quota, packages: remote.packages, message: remote.message, raw: remote.raw };
  }

  handle(channel, fn) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return ok(await fn(payload || {}));
      } catch (err) {
        console.error(`[ipc] ${channel} 失败：`, err.message);
        return fail(err);
      }
    });
  }

  register() {
    // ---------------- 应用信息 ----------------
    this.handle('app:info', () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      dataFile: path.join(app.getPath('userData'), 'mailmaster-data.json'),
      isDev: process.argv.includes('--dev'),
    }));

    this.handle('app:openDataDir', () => {
      shell.openPath(app.getPath('userData'));
      return true;
    });

    this.handle('app:minimize', () => {
      const win = this.getWindow();
      if (win) win.minimize();
      return true;
    });

    this.handle('app:toggleMaximize', () => {
      const win = this.getWindow();
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    });

    this.handle('app:close', () => {
      const win = this.getWindow();
      if (win) win.close();
      return true;
    });

    // ---------------- 总览 ----------------
    this.handle('overview:get', () => this.db.overview());

    // ---------------- 设置 ----------------
    this.handle('settings:get', () => this.db.getSettings());
    this.handle('settings:save', (payload) => {
      const before = this.db.getSettings();
      const settings = this.db.updateSettings(payload || {});
      this.scheduler.recalcAll();
      // 退信监听的轮询间隔 / 开关变化后要重排定时器
      const imapChanged =
        before.imapPollMinutes !== settings.imapPollMinutes || before.imapAutoCheck !== settings.imapAutoCheck;
      if (imapChanged && this.bounceWatcher) this.bounceWatcher.restart();
      return settings;
    });
    this.handle('settings:testSmtp', (payload) => {
      const target = payload && (payload.host || payload.ses) ? payload : this.db.resolveSendingAccount(payload && payload.accountId);
      if (!target) throw new Error('尚未配置任何发信邮箱账号');
      return this.testAccount(target);
    });

    // ---------------- 发信邮箱账号 ----------------
    this.handle('accounts:list', () => {
      const stats = this.db.accountStats();
      return this.db.listAccounts().map((a) => Object.assign({}, a, stats.find((s) => s.id === a.id) || {}, { todayUsed: this.db.accountUsageToday(a.email) }));
    });
    this.handle('accounts:save', (payload) => this.db.saveAccount(payload));
    this.handle('accounts:remove', (payload) => {
      this.db.removeAccount(payload.id);
      return true;
    });
    this.handle('accounts:setDefault', (payload) => this.db.setDefaultAccount(payload.id));
    this.handle('accounts:test', (payload) => {
      const account = payload && payload.id ? Object.assign({}, this.db.getAccount(payload.id) || {}, payload) : payload;
      return this.testAccount(account);
    });
    this.handle('accounts:quota', (payload) => {
      const account = (payload && payload.id ? this.db.getAccount(payload.id) : null) || this.db.listAccounts().find((a) => a.provider === 'tencent-ses');
      if (!account) throw new Error('尚未配置腾讯云邮件推送账号');
      return this.queryQuota(account);
    });

    // ---------------- 联系人 ----------------
    this.handle('contacts:list', (query) => ({
      items: this.db.listContacts(query),
      tags: this.db.allTags(),
      total: this.db.data.contacts.length,
    }));
    this.handle('contacts:save', (payload) => this.db.saveContact(payload));
    this.handle('contacts:remove', (payload) => ({ removed: this.db.removeContacts(payload.ids || []) }));
    this.handle('contacts:markBounced', (payload) => this.db.markContactBounced(payload.id, payload.note));

    /** 手动解除退信标记：该地址重新进入发送列表 */
    this.handle('contacts:releaseBounce', (payload) => {
      const contact = this.db.releaseContactBounce(payload.id, { restoreSubscription: payload.restoreSubscription !== false });
      this.push({ type: 'bounce-state', state: this.bounceWatcher ? this.bounceWatcher.state() : null });
      this.push({ type: 'overview-dirty' });
      return contact;
    });
    this.handle('contacts:exportCsv', async (payload) => {
      const csv = this.db.exportContactsCsv(payload || {});
      const result = await dialog.showSaveDialog(this.getWindow(), {
        title: '导出邮件列表',
        defaultPath: `邮件列表-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      fs.writeFileSync(result.filePath, csv, 'utf8');
      return { canceled: false, filePath: result.filePath, bytes: Buffer.byteLength(csv) };
    });
    this.handle('contacts:importCsvFile', async (payload) => {
      const result = await dialog.showOpenDialog(this.getWindow(), {
        title: '导入邮件列表',
        properties: ['openFile'],
        filters: [{ name: 'CSV / 文本', extensions: ['csv', 'txt', 'tsv'] }],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const filePath = result.filePaths[0];
      const text = fs.readFileSync(filePath, 'utf8');
      const summary = this.db.importContactsFromCsv(text, payload || {});
      return Object.assign({ canceled: false, filePath }, summary);
    });
    this.handle('contacts:importCsvText', (payload) =>
      this.db.importContactsFromCsv(payload.text || '', { mode: payload.mode }),
    );

    // ---------------- 模板 ----------------
    this.handle('templates:list', () => this.db.listTemplates());
    this.handle('templates:save', (payload) => this.db.saveTemplate(payload));
    this.handle('templates:remove', (payload) => {
      this.db.removeTemplate(payload.id);
      return true;
    });
    this.handle('templates:fields', () => ({ contact: CONTACT_FIELDS, global: GLOBAL_FIELDS }));
    this.handle('templates:scan', (payload) => listVariables(`${payload.subject || ''}\n${payload.body || ''}`));

    /** Spintax 概览：可产生多少种不同内容、各选项组内容 */
    this.handle('templates:spintax', (payload) => {
      const tpl = { subject: payload.subject || '', body: payload.body || '' };
      const info = describeSpintax(tpl);
      // 抽样展示几个真实变体，让用户直观看到「每封都不一样」的效果
      const samples = [];
      const rand = Math.random;
      for (let i = 0; i < 5; i += 1) {
        const rendered = renderMessage(tpl, { company: '示例公司', contact: '张三', salutation: '张总', city: '深圳' }, buildGlobalContext({ index: i + 1, total: 5 }), {
          spintax: { rng: rand },
        });
        samples.push({ subject: rendered.subject, body: rendered.body.slice(0, 120) });
      }
      return {
        ...info,
        samples,
        sampleCount: samples.length,
        sampleUniqueSubjects: new Set(samples.map((s) => s.subject)).size,
      };
    });
    this.handle('templates:preview', (payload) => {
      const contact =
        this.db.getContact(payload.contactId) ||
        this.db.data.contacts.find((c) => c.subscribed !== false) ||
        { company: '示例科技有限公司', contact: '张三', salutation: '张总', email: 'demo@example.com', phone: '13800000000', city: '深圳', position: '采购总监' };
      const settings = this.db.getSettings();
      const account = this.db.resolveSendingAccount(payload.accountId);
      const rendered = renderMessage(
        { subject: payload.subject || '', body: payload.body || '' },
        contact,
        buildGlobalContext({
          sender: (account && account.fromName) || settings.smtp?.fromName,
          senderCompany: settings.senderCompany,
          index: 1,
          total: 1,
        }),
        // spinIndex 由界面指定（「换一组措辞」按钮），不传则随机取一组
        Number.isFinite(payload.spinIndex) ? { spintax: { index: Number(payload.spinIndex) } } : undefined,
      );
      return { contact, rendered, account, spintax: describeSpintax({ subject: payload.subject, body: payload.body }) };
    });

    // ---------------- 推广任务 ----------------
    /** 发送节奏与账号池的元信息（预设、策略） */
    this.handle('pacing:meta', () => ({
      presets: PACING_PRESETS,
      strategies: ACCOUNT_STRATEGIES,
    }));

    this.handle('campaigns:list', () => {
      const settings = this.db.getSettings();
      const accounts = this.db.listAccounts();
      return this.db.listCampaigns().map((c) => {
        const account = this.db.resolveSendingAccount(c.accountId);
        const poolAccounts =
          c.accountMode === 'pool' ? (c.accountIds || []).map((id) => accounts.find((a) => a.id === id)).filter(Boolean) : [];
        const pace = normalizePacing(c.throttle && Object.keys(c.throttle).length ? c.throttle : settings.defaultThrottle || {});
        return {
          ...c,
          accountEmail: account ? account.email : '',
          accountName: account ? account.name : '',
          poolEmails: poolAccounts.map((a) => a.email),
          paceText: describePacing(pace),
          scheduleText: describeSchedule(c.schedule),
          nextRunText: formatDateTime(c.nextRunAt),
          effectiveDryRun: settings.sendMode !== 'live' || c.dryRun !== false,
        };
      });
    });
    this.handle('campaigns:save', (payload) => {
      const campaign = this.db.saveCampaign(payload);
      return campaign;
    });
    this.handle('campaigns:remove', (payload) => {
      const campaign = this.db.getCampaign(payload.id);
      if (campaign && campaign.running) throw new Error('任务正在执行中，无法删除');
      this.db.removeCampaign(payload.id);
      return true;
    });
    this.handle('campaigns:preview', (payload) => {
      const contacts = this.db.resolveAudience(payload.audience || { mode: 'all' });
      const exclusions = this.db.audienceExclusions();
      return {
        total: contacts.length,
        exclusions,
        sample: contacts.slice(0, 30).map((c) => ({
          id: c.id,
          company: c.company,
          contact: c.contact,
          salutation: c.salutation,
          email: c.email,
          phone: c.phone,
        })),
      };
    });

    /** 按当前节奏估算整批耗时（编辑任务时实时提示） */
    this.handle('campaigns:paceEstimate', (payload) => {
      const pace = normalizePacing(payload.throttle || {});
      const total = Number(payload.total) || 0;
      const ms = estimatePacing(pace, total);
      return { pace, total, ms, text: humanizeMs(ms), describe: describePacing(pace) };
    });
    this.handle('campaigns:run', async (payload) => {
      const campaign = this.db.getCampaign(payload.id);
      if (!campaign) throw new Error('推广任务不存在');
      if (payload.activate && campaign.status !== 'active' && campaign.schedule.type !== 'manual') {
        campaign.status = 'active';
        const next = scheduleNextRun(campaign.schedule, new Date());
        campaign.nextRunAt = next ? next.toISOString() : null;
      }
      // 不阻塞调用：立即返回，进度通过事件推送
      this.runner.runCampaign(payload.id, { reason: 'manual', onlyFailed: !!payload.onlyFailed }).catch((err) => {
        this.push({ type: 'toast', level: 'error', message: err.message });
      });
      return { started: true };
    });
    this.handle('campaigns:pause', (payload) => {
      const paused = payload.paused !== false;
      const campaign = this.runner.setPaused(payload.id, paused);
      return { status: campaign.status, running: campaign.running };
    });
    this.handle('campaigns:cancel', (payload) => {
      this.runner.cancel(payload.id);
      return true;
    });
    this.handle('campaigns:nextRuns', (payload) => {
      const campaign = this.db.getCampaign(payload.id);
      if (!campaign) return [];
      const out = [];
      let cursor = new Date();
      for (let i = 0; i < 5; i += 1) {
        const next = scheduleNextRun(campaign.schedule, cursor);
        if (!next) break;
        out.push(next.toISOString());
        cursor = new Date(next.getTime() + 1000);
      }
      return out;
    });

    // ---------------- 投递状态 ----------------
    this.handle('logs:list', (query) => this.db.listLogs(query));
    this.handle('logs:exportCsv', async (payload) => {
      const csv = this.db.exportLogsCsv(payload || {});
      const result = await dialog.showSaveDialog(this.getWindow(), {
        title: '导出投递记录',
        defaultPath: `投递记录-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      fs.writeFileSync(result.filePath, csv, 'utf8');
      return { canceled: false, filePath: result.filePath };
    });
    this.handle('logs:mailPreview', (payload) => {
      const log = this.db.getLog(payload.id);
      if (!log) throw new Error('投递记录不存在');
      const template =
        (this.db.getTemplate(payload.templateId) || (this.db.getCampaign(log.campaignId) && this.db.getTemplate(this.db.getCampaign(log.campaignId).templateId)) || this.db.listTemplates()[0]) ||
        { subject: log.subject, body: '（原模板已被删除，无法还原正文）' };
      const contact = this.db.getContact(log.contactId) || { email: log.email, contact: log.contact, company: log.company };
      const settings = this.db.getSettings();
      const account = this.db.resolveSendingAccount(log.accountId);
      const rendered = mailer.renderMail(template, contact, settings, { account });
      // 供「独立窗口预览」使用：附带收件人与发信账号信息
      return Object.assign(rendered, {
        contact: {
          company: contact.company || log.company || '',
          contact: contact.contact || log.contact || '',
          salutation: contact.salutation || '',
          email: contact.email || log.email || '',
        },
        account: account ? { email: account.email || '', name: account.name || '', fromName: account.fromName || '' } : null,
      });
    });

    /** 对单条投递记录立即重发一次 */
    this.handle('logs:resend', async (payload) => {
      const log = this.db.getLog(payload.id);
      if (!log) throw new Error('投递记录不存在');
      const campaign = this.db.getCampaign(log.campaignId);
      const template = this.db.getTemplate(campaign ? campaign.templateId : null) || this.db.listTemplates()[0];
      if (!template) throw new Error('找不到可用的邮件模板，无法重发');
      const contact = this.db.getContact(log.contactId);
      if (!contact) throw new Error('该联系人已从邮件列表中删除，无法重发');

      const settings = this.db.getSettings();
      const effectiveDryRun = settings.sendMode !== 'live' || (campaign ? campaign.dryRun !== false : true);
      const account = this.db.resolveSendingAccount(log.accountId || (campaign ? campaign.accountId : null));
      if (!effectiveDryRun) {
        const problem = mailer.validateAccount(account);
        if (problem) throw new Error(`${problem}，无法重发`);
      }
      const sender = effectiveDryRun ? null : mailer.createSender(account);

      const mail = mailer.renderMail(template, contact, settings, { account });
      const newLog = this.db.addLog({
        campaignId: log.campaignId,
        campaignName: `${log.campaignName || '（单封重发）'}（重发）`,
        accountId: account ? account.id : null,
        accountEmail: account ? account.email : '',
        accountName: account ? account.name : '',
        contactId: contact.id,
        company: contact.company,
        contact: contact.contact,
        salutation: contact.salutation,
        email: contact.email,
        subject: mail.subject,
        status: 'sending',
        dryRun: effectiveDryRun,
        attempts: 1,
      });
      const result = sender ? await sender.send(mail) : await mailer.sendMail({ settings, mail, dryRun: true });
      this.db.updateLog(newLog.id, {
        status: result.status,
        error: result.error || '',
        messageId: result.messageId || '',
        finishedAt: new Date().toISOString(),
        durationMs: result.durationMs,
      });
      this.db.applyContactResult(contact.id, result.status);
      this.db.bumpCounters({
        attempts: 1,
        success: result.status === 'success' ? 1 : 0,
        failed: result.status === 'failed' ? 1 : 0,
        bounced: result.status === 'bounced' ? 1 : 0,
      });
      if (sender) sender.close();
      this.push({ type: 'log', log: this.db.getLog(newLog.id) });
      this.push({ type: 'overview-dirty' });
      return { status: result.status, error: result.error || '' };
    });

    // ---------------- IMAP 退信监听 ----------------
    this.handle('bounce:state', () => (this.bounceWatcher ? this.bounceWatcher.state() : { enabled: false, accounts: [] }));

    this.handle('bounce:check', async (payload) => {
      if (!this.bounceWatcher) throw new Error('退信监听尚未启动');
      const summary = await this.bounceWatcher.checkNow({ reason: payload.manual === false ? 'auto' : 'manual', accountId: payload.accountId });
      return summary;
    });

    this.handle('bounce:list', (query) => this.db.listBounceEvents(query || {}));

    this.handle('bounce:release', (payload) => {
      if (!this.bounceWatcher) throw new Error('退信监听尚未启动');
      const contact = this.bounceWatcher.release(payload.id, { restoreSubscription: payload.restoreSubscription !== false });
      return contact;
    });

    this.handle('bounce:test', async (payload) => {
      if (!this.bounceWatcher) throw new Error('退信监听尚未启动');
      // 新增账号尚未落库时，界面把当前表单里的 IMAP 配置直接传进来验证
      if (!payload.id && payload.draft) {
        const draft = payload.draft || {};
        return this.bounceWatcher.testAccount({
          email: draft.email || '',
          user: draft.user || '',
          pass: draft.pass || '',
          enabled: true,
          imap: Object.assign({ enabled: true }, draft.imap || {}),
        });
      }
      return this.bounceWatcher.test(payload.id);
    });

    // ---------------- 维护 ----------------
    this.handle('maintenance:recomputeStats', () => {
      this.db.recomputeCounters();
      return this.db.counters ? this.db.counters : this.db.data.counters;
    });
    this.handle('maintenance:pruneLogs', (payload) => ({
      removed: this.db.pruneLogs(payload.days || this.db.getSettings().logRetentionDays),
    }));
    this.handle('maintenance:recalcSchedule', () => {
      this.scheduler.recalcAll();
      return true;
    });
  }
}

module.exports = { IpcBridge };
