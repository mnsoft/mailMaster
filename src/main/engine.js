'use strict';

/**
 * 推广执行引擎：按受众解析收件人，逐封发送并记录投递结果。
 * 支持：手动触发 / 定时触发、暂停/继续/中止、失败重试、退信熔断、每日配额、试运行、
 *      随机延迟与速率控制、多账号轮询、Spintax 逐封去重。
 */

const { LOG_STATUS } = require('./db');
const { scheduleNextRun } = require('./scheduler');
const mailer = require('./mailer');
const pacing = require('./pacing');
const { AccountPool, resolvePoolAccounts } = require('./account-pool');

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

  /**
   * 等待若干毫秒
   * @param {number} ms
   * @param {{ unref?: boolean }} [options] unref 为 true 时该定时器不阻止进程退出（用于暂停轮询）
   */
  sleep(ms, options = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // 发送过程中的等待必须保持事件循环存活，否则纯 Node 场景下会「没有句柄」直接退出
      if (options.unref && timer.unref) timer.unref();
    });
  }

  async waitWhilePaused(control) {
    while (control.paused && !control.cancelled) {
      await this.sleep(500, { unref: true });
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

    // 解析本次执行使用的发信账号：账号池（轮询）或单账号
    const poolAccounts = resolvePoolAccounts(campaign, db.listAccounts(), (id) => db.resolveSendingAccount(id));
    if (!poolAccounts.length) throw new Error('未找到可用的发信邮箱账号，请先在「发信邮箱配置」中添加');

    if (!effectiveDryRun) {
      for (const item of poolAccounts) {
        const problem = mailer.validateAccount(item);
        if (problem) throw new Error(`${problem}，请在「发信邮箱配置」中完善后再执行`);
      }
      const usable = poolAccounts.filter(
        (a) => a.enabled !== false && !(a.dailyLimit > 0 && db.accountUsageToday(a.email) >= a.dailyLimit),
      );
      if (!usable.length) {
        throw new Error('账号池中的发信账号今日用量都已达上限或全部停用，请更换账号或等待次日重置');
      }
      // 腾讯云免费额度提示
      for (const item of poolAccounts) {
        if (item.provider !== 'tencent-ses' || !item.ses) continue;
        const freeTotal = Number(item.ses.freeQuotaTotal) || 0;
        if (freeTotal > 0 && db.accountUsageTotal(item.email) >= freeTotal) {
          this.emit({
            type: 'toast',
            level: 'warn',
            message: `腾讯云账号 ${item.email} 的免费额度（${freeTotal} 封）已用完，之后的发送将按量计费，请留意控制台账单`,
          });
        }
      }
    }

    // 发送节奏：任务自身配置优先；任务没配过时才沿用全局默认（改动全局默认只影响新建任务）
    const hasOwnThrottle = campaign.throttle && Object.keys(campaign.throttle).length > 0;
    const pace = pacing.normalize(hasOwnThrottle ? campaign.throttle : settings.defaultThrottle || {});

    const pool = new AccountPool(poolAccounts, { strategy: campaign.accountStrategy });
    const senders = new Map(); // accountId -> sender（按需创建并复用同一条连接）
    const senderFor = (item) => {
      if (effectiveDryRun || !item) return null;
      if (!senders.has(item.id)) senders.set(item.id, mailer.createSender(item));
      return senders.get(item.id);
    };
    const closeSenders = () => {
      for (const sender of senders.values()) {
        try {
          sender.close();
        } catch (_) {
          /* ignore */
        }
      }
      senders.clear();
    };

    const accountLabel =
      poolAccounts.length > 1
        ? `账号池 ${poolAccounts.length} 个（${poolAccounts.map((a) => a.email).join('、')}）`
        : `${poolAccounts[0].provider === 'tencent-ses' ? '腾讯云邮件推送 · ' : ''}${poolAccounts[0].email}`;

    // 重发失败模式：只取历史失败/退信的联系人（同时排除退订与已打退信标记者）；否则按受众解析
    let recipients;
    if (options.onlyFailed) {
      const failedIds = new Set(
        db.data.logs
          .filter((l) => l.campaignId === campaignId && (l.status === LOG_STATUS.FAILED || l.status === LOG_STATUS.BOUNCED))
          .map((l) => l.contactId),
      );
      recipients = db.data.contacts.filter((c) => failedIds.has(c.id) && c.subscribed !== false && !c.bounceMarked);
    } else {
      recipients = db.resolveAudience(campaign.audience);
    }

    if (!recipients.length) {
      this.emit({ type: 'toast', level: 'warn', message: '没有命中任何收件人，请检查受众筛选条件（已自动排除退订与退信标记的地址）' });
      return { total: 0, success: 0, failed: 0, bounced: 0 };
    }

    const control = { paused: false, cancelled: false };
    this.controls.set(campaignId, control);

    const startedAt = new Date().toISOString();

    campaign.running = true;
    campaign.lastRunAt = startedAt;
    if (campaign.status === 'draft') campaign.status = 'active';
    campaign.progress = {
      total: recipients.length,
      done: 0,
      success: 0,
      failed: 0,
      bounced: 0,
      startedAt,
      finishedAt: null,
      skipped: 0,
      pace: pacing.describe(pace),
      accountUsage: pool.distribution(),
    };
    db.store.saveThrottled(100);
    this.emit({
      type: 'campaign',
      campaign,
      message: `开始执行「${campaign.name}」：共 ${recipients.length} 位收件人 · ${accountLabel} · ${pacing.describe(pace)}${
        effectiveDryRun ? '（试运行模式，单次间隔最多模拟 5 秒）' : ''
      }`,
    });

    let dailyQuotaHit = false;
    let accountQuotaHit = false;
    // Spintax 去重：同一批次内优先选用未出现过的「主题 × 正文」组合
    const spintaxCtx = { used: new Set() };
    const sentTimestamps = [];

    try {
      for (let i = 0; i < recipients.length; i += 1) {
        if (control.cancelled) break;
        await this.waitWhilePaused(control);
        if (control.cancelled) break;

        const contact = recipients[i];

        // 每小时限速：达到上限后等待窗口滑动
        if (!effectiveDryRun && pace.hourlyLimit > 0) {
          for (;;) {
            const waitMs = pacing.waitForHourlySlot(sentTimestamps, pace.hourlyLimit);
            if (waitMs <= 0 || control.cancelled) break;
            this.emit({
              type: 'campaign',
              campaign,
              message: `已达每小时发送上限（${pace.hourlyLimit} 封），等待 ${Math.ceil(waitMs / 1000)} 秒后继续…`,
            });
            await this.sleep(Math.min(waitMs, 60000));
            await this.waitWhilePaused(control);
          }
          if (control.cancelled) break;
        }

        // 任务级每日配额（仅真实发送计入）
        if (!effectiveDryRun && pace.dailyLimit > 0 && db.sentTodayCount(campaignId) >= pace.dailyLimit) {
          dailyQuotaHit = true;
          break;
        }

        // 选择本封使用的发信账号：轮询账号池，自动跳过停用与超限账号
        const picked = pool.next((item) => {
          if (item.enabled === false) return '账号已停用';
          if (item.dailyLimit > 0 && !effectiveDryRun && db.accountUsageToday(item.email) >= item.dailyLimit) {
            return `今日已达上限（${item.dailyLimit} 封）`;
          }
          return null;
        });
        if (!picked.account) {
          accountQuotaHit = true;
          this.emit({
            type: 'toast',
            level: 'warn',
            message: `所有发信账号均已不可用：${picked.blocked.map((b) => `${b.email}（${b.reason}）`).join('；')}`,
          });
          break;
        }
        const account = picked.account;

        const mail = mailer.renderMail(template, contact, settings, {
          account,
          index: i + 1,
          total: recipients.length,
          spintax: spintaxCtx,
        });

        const log = db.addLog({
          campaignId,
          campaignName: campaign.name,
          accountId: account.id,
          accountEmail: account.email,
          accountName: account.name,
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
        const maxAttempts = Math.max(1, Number(pace.maxRetries) || 1) + 1;
        const sender = senderFor(account);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          log.attempts = attempt;
          result = sender ? await sender.send(mail) : await mailer.sendMail({ settings, mail, dryRun: true });
          if (result.status === LOG_STATUS.SUCCESS || !result.transient) break;
          if (attempt < maxAttempts) await this.sleep(2000);
        }

        pool.markUsed(account.id);
        sentTimestamps.push(Date.now());

        db.updateLog(log.id, {
          status: result.status,
          error: result.error || '',
          messageId: result.messageId || '',
          attempts: log.attempts,
          durationMs: result.durationMs,
          finishedAt: new Date().toISOString(),
          subject: mail.subject,
          missingVars: mail.missing,
          accountId: account.id,
          accountEmail: account.email,
          accountName: account.name,
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
        campaign.progress.accountUsage = pool.distribution();

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

        if (i < recipients.length - 1) {
          const delay = pacing.nextDelay(pace, { sentCount: campaign.progress.done });
          // 试运行模式把过长的等待压缩到 5 秒以内，便于快速验证流程
          const delayMs = effectiveDryRun ? Math.min(delay.ms, 5000) : delay.ms;
          if (delay.kind === 'burst' && delayMs > 0) {
            this.emit({
              type: 'campaign',
              campaign,
              message: `已连续发送 ${pace.burstEvery} 封，按拟人节奏休息 ${Math.round(delay.ms / 1000)} 秒…`,
            });
          }
          if (delayMs > 0) await this.sleep(delayMs);
        }
      }
    } finally {
      campaign.running = false;
      campaign.runCount = (campaign.runCount || 0) + 1;
      campaign.progress.finishedAt = new Date().toISOString();
      campaign.progress.accountUsage = pool.distribution();
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
      closeSenders();
      this.emit({ type: 'campaign', campaign });

      const usageText =
        poolAccounts.length > 1
          ? ` · 账号分布 ${pool
              .distribution()
              .map((d) => `${d.email} ${d.sent} 封`)
              .join('、')}`
          : '';
      this.emit({
        type: 'toast',
        level: dailyQuotaHit || accountQuotaHit ? 'warn' : 'info',
        message: dailyQuotaHit
          ? `「${campaign.name}」已达该任务今日发送上限（${pace.dailyLimit} 封），任务已暂停，剩余 ${recipients.length - campaign.progress.done} 位收件人待下次执行`
          : accountQuotaHit
            ? `「${campaign.name}」已无可用的发信账号（均达今日上限或已停用），任务已暂停，剩余 ${recipients.length - campaign.progress.done} 位收件人待下次执行`
            : `「${campaign.name}」执行结束：成功 ${campaign.progress.success} / 失败 ${campaign.progress.failed} / 退信 ${campaign.progress.bounced}${usageText}`,
      });
    }

    return campaign.progress;
  }
}

module.exports = { CampaignRunner };
