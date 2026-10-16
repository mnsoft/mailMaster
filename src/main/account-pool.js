'use strict';

/**
 * 发信账号池：让一个推广任务在多条发信邮箱之间轮询投递，
 * 避免所有邮件都从同一个邮箱发出（同一发件人高频投递更容易被判定为机器群发）。
 *
 * 策略：
 *  - roundRobin：按账号列表顺序轮询，达到限额的账号自动跳过
 *  - random：每封在可用账号中随机挑一个
 *
 * 账号是否「可用」由调用方通过 isUsable 回调判断（需要读数据库用量），
 * 这样本模块保持无状态依赖，便于测试。
 */

const STRATEGIES = [
  { key: 'roundRobin', label: '轮询（推荐）', hint: '按顺序依次使用每个账号，用量最均衡' },
  { key: 'random', label: '随机', hint: '每封在可用账号中随机挑选，分布更不规律' },
];

class AccountPool {
  /**
   * @param {object[]} accounts 账号列表（已按用户勾选顺序）
   * @param {{ strategy?: string, rng?: () => number }} [options]
   */
  constructor(accounts, options = {}) {
    this.accounts = (accounts || []).filter(Boolean);
    this.strategy = options.strategy === 'random' ? 'random' : 'roundRobin';
    this.rng = typeof options.rng === 'function' ? options.rng : Math.random;
    this.cursor = 0;
    this.usage = new Map(); // accountId -> 本轮已用封数
  }

  size() {
    return this.accounts.length;
  }

  usedCount(accountId) {
    return this.usage.get(accountId) || 0;
  }

  markUsed(accountId) {
    this.usage.set(accountId, this.usedCount(accountId) + 1);
  }

  /** 轮询顺序：轮询策略返回固定顺序，随机策略返回打乱后的顺序 */
  order() {
    const list = this.accounts.slice();
    if (this.strategy !== 'random') {
      const n = list.length;
      if (!n) return list;
      const start = this.cursor % n;
      return list.slice(start).concat(list.slice(0, start));
    }
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  /**
   * 取下一个可用账号
   * @param {(account: object) => (string|null)} isUsable 返回 null 表示可用，否则返回不可用原因
   * @returns {{ account: object|null, blocked: {id:string,email:string,reason:string}[] }}
   */
  next(isUsable) {
    const blocked = [];
    for (const account of this.order()) {
      const reason = typeof isUsable === 'function' ? isUsable(account) : null;
      if (reason) {
        blocked.push({ id: account.id, email: account.email, reason });
        continue;
      }
      const index = this.accounts.findIndex((a) => a.id === account.id);
      if (index >= 0) this.cursor = (index + 1) % this.accounts.length;
      return { account, blocked };
    }
    return { account: null, blocked };
  }

  /** 本轮各账号的实际使用分布 */
  distribution() {
    return this.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name || '',
      fromName: a.fromName || '',
      sent: this.usedCount(a.id),
    }));
  }
}

/**
 * 组装任务要使用的账号列表
 * @param {object} campaign 推广任务（支持 accountId 单账号与 accountIds 账号池）
 * @param {object[]} allAccounts 全部账号
 * @param {(accountId: string) => object|null} resolveFallback 兜底解析（默认账号等）
 */
function resolvePoolAccounts(campaign, allAccounts, resolveFallback) {
  const list = allAccounts || [];
  const poolMode = campaign && (campaign.accountMode === 'pool' || (Array.isArray(campaign.accountIds) && campaign.accountIds.length > 1));

  if (poolMode) {
    const ids = Array.isArray(campaign.accountIds) ? campaign.accountIds : [];
    const picked = ids.map((id) => list.find((a) => a.id === id)).filter(Boolean);
    if (picked.length) return picked;
  }

  // 单账号模式：沿用原有解析规则（指定账号 → 默认账号 → 第一个启用账号）
  const single = typeof resolveFallback === 'function' ? resolveFallback(campaign ? campaign.accountId : null) : null;
  return single ? [single] : [];
}

module.exports = { AccountPool, resolvePoolAccounts, STRATEGIES };
