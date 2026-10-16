'use strict';

/**
 * 退信自动监听器
 *
 * 工作方式：按设定间隔轮询各发信账号的 IMAP 收件箱，找出未读的退信报告（DSN），
 * 解析出「哪个地址退信、是硬退信还是临时失败」，然后：
 *   1. 在联系人上打「退信标记」，使其从后续所有推广的发送列表中剔除；
 *   2. 写入一条退信事件记录，供界面查看与追溯；
 *   3. 把该邮件在服务器上标记为已读，避免重复处理。
 *
 * 退信标记是**可撤销**的：在「退信监听」页面手动解除后，该地址会重新进入发送列表。
 */

const mime = require('./mime');
const { ImapClient, ImapError } = require('./imap');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_MESSAGES_PER_CHECK = 60;

/** IMAP SEARCH 的日期格式：12-Oct-2026 */
function imapDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/** 从账号配置里整理出 IMAP 连接参数（缺省时沿用发信账号本身） */
function resolveImapConfig(account) {
  const imap = (account && account.imap) || {};
  return {
    host: imap.host || '',
    port: Number(imap.port) || (imap.secure === false ? 143 : 993),
    secure: imap.secure !== false,
    user: imap.user || account.user || account.email || '',
    pass: imap.pass || account.pass || '',
    mailbox: imap.mailbox || 'INBOX',
    markSeen: imap.markSeen !== false,
    searchDays: Number(imap.searchDays) || 30,
    // 内网 / 本机邮件服务器可能不提供 STARTTLS，允许用户显式放行明文连接
    allowInsecure: imap.allowInsecure === true,
  };
}

/** 该账号是否具备监听条件 */
function imapReadiness(account) {
  if (!account) return '发信账号不存在';
  if (account.enabled === false) return '账号已停用';
  const imap = account.imap || {};
  if (!imap.enabled) return '未启用 IMAP 退信监听';
  const cfg = resolveImapConfig(account);
  if (!cfg.host) return '未配置 IMAP 服务器地址';
  if (!cfg.user) return '未配置 IMAP 登录名';
  if (!cfg.pass) return 'IMAP 密码与发信密码都为空，无法登录（两者至少填一个）';
  return null;
}

class BounceWatcher {
  /**
   * @param {object} db Database 实例
   * @param {(payload: object) => void} push 事件推送
   */
  constructor(db, push) {
    this.db = db;
    this.push = push || (() => {});
    this.timer = null;
    this.running = false;
    this.lastCheckAt = null;
    this.lastSummary = null;
    this.lastErrors = [];
  }

  emit(payload) {
    try {
      this.push(payload);
    } catch (_) {
      /* ignore */
    }
  }

  settings() {
    const s = this.db.getSettings() || {};
    return {
      autoCheck: s.imapAutoCheck !== false,
      pollMinutes: Math.max(1, Number(s.imapPollMinutes) || 5),
      autoMarkBounce: s.imapAutoMarkBounce !== false,
      minType: s.imapBounceType === 'all' ? 'all' : 'hard',
    };
  }

  /** 启动定时轮询 */
  start() {
    this.stop();
    const { autoCheck, pollMinutes } = this.settings();
    const period = pollMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      if (!this.settings().autoCheck) return;
      this.checkNow({ reason: 'auto' }).catch((err) => console.error('[bounce] 自动检查失败', err.message));
    }, period);
    if (this.timer.unref) this.timer.unref();
    console.log(`[bounce] 退信监听已启动，间隔 ${pollMinutes} 分钟${autoCheck ? '' : '（当前为关闭状态，仅手动检查）'}`);
    return { pollMinutes, autoCheck };
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 重新读取设置并调整轮询间隔 */
  restart() {
    return this.start();
  }

  enabledAccounts() {
    return (this.db.listAccounts() || []).filter((a) => (a.imap || {}).enabled);
  }

  /** 当前监听状态（供界面展示） */
  state() {
    const accounts = (this.db.listAccounts() || []).map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      enabled: (a.imap || {}).enabled === true,
      host: (a.imap || {}).host || '',
      mailbox: (a.imap || {}).mailbox || 'INBOX',
      readiness: imapReadiness(a),
      lastCheckAt: (a.imap || {}).lastCheckAt || null,
      lastError: (a.imap || {}).lastError || '',
      lastFound: (a.imap || {}).lastFound || 0,
    }));
    const settings = this.settings();
    const markedCount = (this.db.data.contacts || []).filter((c) => c.bounceMarked).length;
    return {
      running: this.running,
      lastCheckAt: this.lastCheckAt || this.db.getSettings().imapLastCheckAt || null,
      lastSummary: this.lastSummary,
      lastErrors: this.lastErrors,
      pollMinutes: settings.pollMinutes,
      autoCheck: settings.autoCheck,
      autoMarkBounce: settings.autoMarkBounce,
      minType: settings.minType,
      enabledAccountCount: this.enabledAccounts().length,
      markedCount,
      eventCount: (this.db.data.bounceEvents || []).length,
      accounts,
    };
  }

  /**
   * 立即检查（手动或定时触发）
   * @param {{ reason?: string, accountId?: string }} options
   */
  async checkNow(options = {}) {
    if (this.running) {
      return Object.assign({ skipped: true, reason: '已有一次检查正在进行中' }, this.lastSummary || {});
    }
    const targets = options.accountId
      ? this.db.listAccounts().filter((a) => a.id === options.accountId)
      : this.enabledAccounts();

    if (!targets.length) {
      const summary = {
        checkedAt: new Date().toISOString(),
        accounts: 0,
        scanned: 0,
        bounced: 0,
        marked: 0,
        skipped: 0,
        message: '没有启用 IMAP 监听且配置完整的发信账号，请在「发信邮箱配置」中打开退信监听',
      };
      this.lastSummary = summary;
      this.lastCheckAt = summary.checkedAt;
      return summary;
    }

    this.running = true;
    const summary = {
      checkedAt: new Date().toISOString(),
      reason: options.reason || 'manual',
      accounts: targets.length,
      scanned: 0,
      bounced: 0,
      marked: 0,
      skipped: 0,
      errors: [],
      details: [],
    };

    try {
      for (const account of targets) {
        const readiness = imapReadiness(account);
        if (readiness) {
          summary.errors.push({ account: account.email, message: readiness });
          continue;
        }
        try {
          const result = await this.checkAccount(account);
          summary.scanned += result.scanned;
          summary.bounced += result.bounced;
          summary.marked += result.marked;
          summary.skipped += result.skipped;
          if (result.details.length) summary.details.push(...result.details);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          summary.errors.push({ account: account.email, message });
          this.db.setAccountImapState(account.id, { lastError: message });
        }
      }
    } finally {
      this.running = false;
      this.lastSummary = summary;
      this.lastCheckAt = summary.checkedAt;
      this.lastErrors = summary.errors;
      this.db.updateSettings({ imapLastCheckAt: summary.checkedAt });
      this.emit({ type: 'bounce-state', state: this.state() });
      if (summary.marked > 0) {
        this.emit({
          type: 'toast',
          level: 'warn',
          message: `退信监听：本轮标记 ${summary.marked} 个退信地址，已从后续发送列表中剔除`,
        });
      }
      this.emit({ type: 'overview-dirty' });
    }

    return summary;
  }

  /**
   * 检查单个账号的收件箱
   */
  async checkAccount(account) {
    const cfg = resolveImapConfig(account);
    const { client, exists } = await ImapClient.open(cfg, { timeout: 20000 });
    const result = { scanned: 0, bounced: 0, marked: 0, skipped: 0, details: [], exists };

    try {
      const since = new Date(Date.now() - cfg.searchDays * 24 * 3600 * 1000);
      let uids = await client.search(['UNSEEN', `SINCE ${imapDate(since)}`]);
      // 兜底：部分服务器对 SINCE 处理不一致，若没有未读则退回只按时间搜索
      if (!uids.length) uids = await client.search([`SINCE ${imapDate(since)}`]);
      uids = uids.slice(-MAX_MESSAGES_PER_CHECK);

      for (const uid of uids) {
        if (this.db.hasBounceEvent(account.id, uid)) {
          result.skipped += 1;
          continue;
        }
        let raw = null;
        try {
          raw = await client.fetchRaw(uid);
        } catch (err) {
          result.skipped += 1;
          continue;
        }
        if (!raw || !raw.length) {
          result.skipped += 1;
          continue;
        }
        result.scanned += 1;

        const node = mime.parseMessage(raw);
        const bounce = mime.extractBounce(node);
        if (!bounce.isBounce) {
          // 不是退信：只标已读，不产生记录
          if (cfg.markSeen) await client.markSeen(uid).catch(() => {});
          continue;
        }

        result.bounced += 1;
        const applied = this.handleBounce(account, uid, bounce);
        if (applied.marked) result.marked += 1;
        result.details.push(applied);
        if (cfg.markSeen) await client.markSeen(uid).catch(() => {});
      }

      this.db.setAccountImapState(account.id, {
        lastCheckAt: new Date().toISOString(),
        lastError: '',
        lastFound: result.bounced,
      });
    } finally {
      try {
        await client.logout();
      } catch (_) {
        client.destroy();
      }
    }

    return result;
  }

  /**
   * 处理一封退信：定位联系人 → 写事件 → 打标记
   */
  handleBounce(account, uid, bounce) {
    const db = this.db;
    const settings = this.settings();

    // 1) 定位联系人：优先按原邮件 Message-ID 精确匹配，其次按退信收件人地址
    let contact = null;
    let log = null;
    const candidateIds = [];
    if (bounce.originalMessageId) candidateIds.push(bounce.originalMessageId);
    for (const id of extractMessageIds(bounce.text)) candidateIds.push(id);

    for (const mid of candidateIds) {
      const hit = db.findLogByMessageId(mid);
      if (hit) {
        log = hit;
        contact = db.getContact(hit.contactId);
        break;
      }
    }
    if (!contact) {
      for (const email of bounce.recipients) {
        const hit = db.getContactByEmail(email);
        if (hit) {
          contact = hit;
          break;
        }
      }
    }

    const primaryEmail = (contact && contact.email) || bounce.recipients[0] || '';
    const campaign = log ? db.getCampaign(log.campaignId) : null;

    const event = db.addBounceEvent({
      accountId: account.id,
      accountEmail: account.email,
      uid,
      type: bounce.type || 'hard',
      status: bounce.status,
      diagnostic: bounce.diagnostic,
      reason: bounce.reason,
      subject: bounce.subject,
      from: bounce.from,
      date: bounce.date,
      originalMessageId: bounce.originalMessageId,
      recipients: bounce.recipients,
      contactId: contact ? contact.id : null,
      email: primaryEmail,
      company: contact ? contact.company : '',
      contactName: contact ? contact.contact : '',
      campaignId: log ? log.campaignId : null,
      campaignName: log ? log.campaignName || (campaign ? campaign.name : '') : '',
      logId: log ? log.id : null,
      source: 'imap',
      matched: Boolean(contact),
    });

    // 2) 打退信标记（硬退信默认标记；临时性退信按设置决定）
    let marked = false;
    const shouldMark =
      settings.autoMarkBounce &&
      contact &&
      (settings.minType === 'all' ? bounce.type !== null : bounce.type === 'hard' || bounce.type === 'blocked');

    if (shouldMark) {
      db.markContactBounce(contact.id, {
        type: bounce.type,
        status: bounce.status,
        reason: bounce.reason,
        diagnostic: bounce.diagnostic,
        subject: bounce.subject,
        accountEmail: account.email,
        eventId: event.id,
        source: 'imap',
      });
      marked = true;
    }

    this.emit({ type: 'bounce-event', event });
    return {
      eventId: event.id,
      email: primaryEmail,
      type: bounce.type,
      status: bounce.status,
      marked,
      matched: Boolean(contact),
      subject: bounce.subject,
    };
  }

  /** 解除某个联系人的退信标记，使其重新进入发送列表 */
  release(contactId, options = {}) {
    const contact = this.db.releaseContactBounce(contactId, options);
    this.emit({ type: 'bounce-state', state: this.state() });
    this.emit({ type: 'overview-dirty' });
    return contact;
  }

  /** 退信事件列表 */
  listEvents(query = {}) {
    return this.db.listBounceEvents(query);
  }

  /** 测试某个账号的 IMAP 连接（按 id 从数据库取） */
  async test(accountId) {
    const account = this.db.getAccount(accountId);
    if (!account) throw new Error('发信账号不存在');
    return this.testAccount(account);
  }

  /**
   * 直接测试一份账号配置（用于「新增账号」尚未保存时先验证 IMAP）
   * @param {object} account 与数据库账号同构的对象（至少含 email / pass / imap）
   */
  async testAccount(account) {
    if (!account) throw new Error('发信账号不存在');
    const readiness = imapReadiness(account);
    if (readiness) throw new Error(readiness);
    const cfg = resolveImapConfig(account);
    const started = Date.now();
    try {
      const { client, exists } = await ImapClient.open(cfg, { timeout: 15000 });
      try {
        await client.logout();
      } catch (_) {
        client.destroy();
      }
      return {
        ok: true,
        message: `IMAP 连接成功 · ${cfg.host}:${cfg.port} · 邮箱 ${cfg.mailbox}（当前 ${exists} 封）`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, message: err.message, stage: err.stage || '', durationMs: Date.now() - started };
    }
  }
}

/** 从退信正文里捞 Message-ID（DSN 常常内嵌原始邮件头） */
function extractMessageIds(text, limit = 6) {
  const out = [];
  const re = /message-id\s*:\s*<([^>\s]+)>/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push(m[1]);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { BounceWatcher, resolveImapConfig, imapReadiness, imapDate };
