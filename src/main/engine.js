'use strict';

/**
 * 推广执行引擎：按受众解析收件人，逐封发送并记录投递结果。
 * 支持：手动触发 / 定时触发、暂停/继续/中止、失败重试、退信熔断、每日配额、试运行。
 */

const { LOG_STATUS } = require('./db');
const { scheduleNextRun } = require('./scheduler');
const mailer = require('./mailer');

class CampaignRunner {
  /**
   * @param {object} db Database 实例
   * @param {(payload: object) => void} onEvent 事件回调（推送到界面）
   */
  constructor(db, onEvent) {
    this.db = db;
    this.onEvent = onEvent || (() => {});
    this.controls = new Map(); // campaignId -> { paused, cancelled }
  }

  emit(payload) {
    try {
      this.onEvent(payload);
    } catch (err) {
      console.error('[engine] 事件推送失败', err.message);
    }
  }

  isRunning(campaignId) {
    const c = this.db.getCampaign(campaignId);
    return Boolean(c && c.running);
  }

  runningCount() {
    return this.db.listCampaigns().filter((c) => c.running).length;
  }

  setPaused(campaignId, paused) {
    const control = this.controls.get(campaignId);
    const campaign = this.db.getCampaign(campaignId);
    if (!campaign) throw new Error('任务不存在');
    if (!campaign.running) {
      campaign.status = paused ? 'paused' : 'active';
      campaign.updatedAt = new Date().toISOString();
      this.db.store.saveThrottled(100);
      return campaign;
    }
    if (control) control.paused = paused;
    campaign.status = paused ? 'paused' : 'active';
    campaign.updatedAt = new Date().toISOString();
    this.db.store.saveThrottled(100);
    this.emit({ type: 'campaign', campaign });
    return campaign;
  }

  cancel(campaignId) {
    const control = this.controls.get(campaignId);
    if (control) control.cancelled = true;
    this.emit({ type: 'toast', level: 'warn', message: '已请求中止当前发送，正在等待当前邮件结束…' });
    return true;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    });
  }

  async waitWhilePaused(control) {
    while (control.paused && !control.cancelled) {
      await this.sleep(500);
    }
  }

  /**
   * 执行一次推广
   * @param {string} campaignId
   * @param {{ reason?: string, onlyFailed?: boolean }} options
   */
  async runCampaign(campaignId, options = {}) {
    const db = this.db;
    const campaign = db.getCampaign(campaignId);
    if (!campaign) throw new Error('推广任务不存在');
    if (campaign.running) throw new Error('该任务正在执行中，请稍候');

    const template = db.getTemplate(campaign.templateId);
    if (!template) throw new Error('任务未关联有效的邮件模板，请先选择模板');

    const settings = db.getSettings();
    const effectiveDryRun = settings.sendMode !== 'live' || campaign.dryRun !== false;

    // 解析本任务使用的发信邮箱账号（不同任务可使用不同发信地址）
    const account = db.resolveSendingAccount(campaign.accountId);
    if (!effectiveDryRun) {
      const problem = mailer.validateAccount(account);
      if (problem) throw new Error(`${problem}，请在「发信邮箱配置」中完善后再执行`);
      // 按账号控制每日发送量
      if (account.dailyLimit > 0 && db.accountUsageToday(account.email) >= account.dailyLimit) {
        throw new Error(`发信账号 ${account.email} 今日发送量已达上限（${account.dailyLimit} 封），请更换账号或等待次日重置`);
      }
      // 腾讯云免费额度提示
      if (account.provider === 'tencent-ses' && account.ses) {
        const freeTotal = Number(account.ses.freeQuotaTotal) || 0;
        const usedTotal = db.accountUsageTotal(account.email);
        if (freeTotal > 0 && usedTotal >= freeTotal) {
          this.emit({
            type: 'toast',
            level: 'warn',
            message: `腾讯云账号 ${account.email} 的免费额度（${freeTotal} 封）已用完，之后的发送将按量计费，请留意控制台账单`,
          });
        }
      }
    }

    const sender = effectiveDryRun ? null : mailer.createSender(account);
    const accountLabel = account ? `${account.provider === 'tencent-ses' ? '腾讯云邮件推送 · ' : ''}${account.email}` : '（未配置发信账号）';

    // 重发失败模式：只取历史失败/退信的联系人；否则按受众解析
    let recipients;
    if (options.onlyFailed) {
      const failedIds = new Set(
        db.data.logs
          .filter((l) => l.campaignId === campaignId && (l.status === LOG_STATUS.FAILED || l.status === LOG_STATUS.BOUNCED))
          .map((l) => l.contactId),
      );
      recipients = db.data.contacts.filter((c) => failedIds.has(c.id));
    } else {
      recipients = db.resolveAudience(campaign.audience);
    }

    if (!recipients.length) {
      this.emit({ type: 'toast', level: 'warn', message: '没有命中任何收件人，请检查受众筛选条件' });
      return { total: 0, success: 0, failed: 0, bounced: 0 };
    }

    const control = { paused: false, cancelled: false };
    this.controls.set(campaignId, control);

    const throttle = Object.assign({ intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 }, campaign.throttle || {});
    const startedAt = new Date().toISOString();

    campaign.running = true;
    campaign.lastRunAt = startedAt;
    if (campaign.status === 'draft') campaign.status = campaign.kind === 'manual' ? 'active' : 'active';
    campaign.progress = {
      total: recipients.length,
      done: 0,
      success: 0,
      failed: 0,
      bounced: 0,
      startedAt,
      finishedAt: null,
      skipped: 0,
    };
    db.store.saveThrottled(100);
    this.emit({
      type: 'campaign',
      campaign,
      message: `开始执行「${campaign.name}」：共 ${recipients.length} 位收件人 · 发信账号 ${accountLabel}${effectiveDryRun ? '（试运行模式）' : ''}`,
    });

    let dailyQuotaHit = false;
    let accountQuotaHit = false;

    try {
      for (let i = 0; i < recipients.length; i += 1) {
        if (control.cancelled) break;
        await this.waitWhilePaused(control);
        if (control.cancelled) break;

        const contact = recipients[i];

        // 每日配额控制（仅真实发送计入）
        if (!effectiveDryRun && throttle.dailyLimit > 0 && db.sentTodayCount(campaignId) >= throttle.dailyLimit) {
          dailyQuotaHit = true;
          break;
        }
        if (!effectiveDryRun && account && account.dailyLimit > 0 && db.accountUsageToday(account.email) >= account.dailyLimit) {
          accountQuotaHit = true;
          break;
        }

        const mail = mailer.renderMail(template, contact, settings, {
          account,
          index: i + 1,
          total: recipients.length,
        });

        const log = db.addLog({
          campaignId,
          campaignName: campaign.name,
          accountId: account ? account.id : null,
          accountEmail: account ? account.email : '',
          accountName: account ? account.name : '',
          contactId: contact.id,
          company: contact.company,
          contact: contact.contact,
          salutation: contact.salutation,
          email: contact.email,
          subject: mail.subject,
          status: LOG_STATUS.SENDING,
          dryRun: effectiveDryRun,
          attempts: 0,
        });
        this.emit({ type: 'log', log });

        let result = null;
        const maxAttempts = Math.max(1, Number(throttle.maxRetries) || 1) + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          log.attempts = attempt;
          result = sender
            ? await sender.send(mail)
            : await mailer.sendMail({ settings, mail, dryRun: true });
          if (result.status === LOG_STATUS.SUCCESS || !result.transient) break;
          if (attempt < maxAttempts) await this.sleep(2000);
        }

        db.updateLog(log.id, {
          status: result.status,
          error: result.error || '',
          messageId: result.messageId || '',
          attempts: log.attempts,
          durationMs: result.durationMs,
          finishedAt: new Date().toISOString(),
          subject: mail.subject,
          missingVars: mail.missing,
        });
        db.applyContactResult(contact.id, result.status);
        db.bumpCounters({
          attempts: 1,
          success: result.status === LOG_STATUS.SUCCESS ? 1 : 0,
          failed: result.status === LOG_STATUS.FAILED ? 1 : 0,
          bounced: result.status === LOG_STATUS.BOUNCED ? 1 : 0,
        });

        campaign.progress.done += 1;
        if (result.status === LOG_STATUS.SUCCESS) campaign.progress.success += 1;
        else if (result.status === LOG_STATUS.FAILED) campaign.progress.failed += 1;
        else if (result.status === LOG_STATUS.BOUNCED) campaign.progress.bounced += 1;

        this.emit({ type: 'log', log: db.getLog(log.id) });
        this.emit({ type: 'campaign', campaign });

        // 退信熔断：短时间内大量硬退信通常意味着名单质量或发信域问题
        if (
          settings.bounceAutoPause &&
          campaign.progress.bounced >= (Number(settings.bouncePauseThreshold) || 5) &&
          campaign.progress.bounced / Math.max(1, campaign.progress.done) > 0.3
        ) {
          campaign.status = 'paused';
          this.emit({
            type: 'toast',
            level: 'error',
            message: `退信率过高（${campaign.progress.bounced}/${campaign.progress.done}），已自动暂停任务「${campaign.name}」以保护发信信誉`,
          });
          break;
        }

        if (i < recipients.length - 1 && throttle.intervalSeconds > 0) {
          await this.sleep(throttle.intervalSeconds * 1000);
        }
      }
    } finally {
      campaign.running = false;
      campaign.runCount = (campaign.runCount || 0) + 1;
      campaign.progress.finishedAt = new Date().toISOString();
      campaign.updatedAt = new Date().toISOString();
      if (control.cancelled) campaign.progress.cancelled = true;
      if (campaign.kind !== 'manual' && campaign.schedule.type !== 'manual') {
        const next = scheduleNextRun(campaign.schedule, new Date());
        campaign.nextRunAt = next ? next.toISOString() : null;
        if (!next && campaign.schedule.type === 'once') campaign.status = 'finished';
        if (dailyQuotaHit || accountQuotaHit) campaign.status = 'paused';
      } else if (campaign.progress.done >= recipients.length && !control.cancelled) {
        campaign.status = 'finished';
        campaign.nextRunAt = null;
      }
      db.bumpCounters({ runs: 1 });
      this.db.store.saveThrottled(100);
      this.controls.delete(campaignId);
      if (sender) sender.close();
      this.emit({ type: 'campaign', campaign });
      this.emit({
        type: 'toast',
        level: dailyQuotaHit || accountQuotaHit ? 'warn' : 'info',
        message: dailyQuotaHit
          ? `「${campaign.name}」已达该任务今日发送上限（${throttle.dailyLimit} 封），任务已暂停，剩余 ${recipients.length - campaign.progress.done} 位收件人待下次执行`
          : accountQuotaHit
            ? `「${campaign.name}」已达发信账号 ${account.email} 的今日上限（${account.dailyLimit} 封），任务已暂停，剩余 ${recipients.length - campaign.progress.done} 位收件人待下次执行`
            : `「${campaign.name}」执行结束：成功 ${campaign.progress.success} / 失败 ${campaign.progress.failed} / 退信 ${campaign.progress.bounced}`,
      });
    }

    return campaign.progress;
  }
}

module.exports = { CampaignRunner };
