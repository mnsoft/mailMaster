'use strict';

/**
 * 定时调度：根据任务 schedule 计算「下次执行时间」，并按秒轮询触发。
 * schedule 结构：
 *   { type:'manual' }
 *   { type:'once',     at:'2026-10-12T15:00' }
 *   { type:'interval', everyMinutes:30 }
 *   { type:'daily',    time:'09:30' }
 *   { type:'weekly',   weekdays:[1,3,5], time:'09:30' }      // 0=周日 ... 6=周六
 *   { type:'monthly',  days:[1,15],      time:'09:30' }
 */

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parseTime(time) {
  const [h, m] = String(time || '09:00')
    .split(':')
    .map((v) => Number(v) || 0);
  return { h: Math.min(23, Math.max(0, h)), m: Math.min(59, Math.max(0, m)) };
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function atTime(base, time) {
  const { h, m } = parseTime(time);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0);
  return d;
}

/**
 * 计算 from 之后的下一次执行时间
 * @returns {Date|null} 手动任务或已失效的一次性任务返回 null
 */
function scheduleNextRun(schedule, from = new Date()) {
  if (!schedule || !schedule.type) return null;
  const type = schedule.type;

  if (type === 'manual') return null;

  if (type === 'once') {
    if (!schedule.at) return null;
    const d = new Date(schedule.at);
    if (Number.isNaN(d.getTime()) || d <= from) return null;
    return d;
  }

  if (type === 'interval') {
    const minutes = Math.max(1, Number(schedule.everyMinutes) || 60);
    const stepMs = minutes * 60000;
    const base = schedule.startAt ? new Date(schedule.startAt) : null;
    const anchor = base && !Number.isNaN(base.getTime()) ? base : null;
    // 起点在未来：以起点为首次执行时间
    if (anchor && anchor > from) return anchor;
    const start = anchor || from;
    const elapsed = from.getTime() - start.getTime();
    const k = elapsed < 0 ? 1 : Math.floor(elapsed / stepMs) + 1;
    return new Date(start.getTime() + k * stepMs);
  }

  if (type === 'daily') {
    const candidate = atTime(from, schedule.time);
    if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (type === 'weekly') {
    const weekdays = (Array.isArray(schedule.weekdays) && schedule.weekdays.length ? schedule.weekdays : [1])
      .map((v) => Number(v))
      .filter((v) => v >= 0 && v <= 6);
    if (!weekdays.length) return null;
    for (let offset = 0; offset <= 8; offset += 1) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
      if (!weekdays.includes(day.getDay())) continue;
      const candidate = atTime(day, schedule.time);
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (type === 'monthly') {
    const days = (Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [1])
      .map((v) => Math.min(31, Math.max(1, Number(v) || 1)))
      .sort((a, b) => a - b);
    if (!days.length) return null;
    for (let offset = 0; offset <= 24; offset += 1) {
      const probe = new Date(from.getFullYear(), from.getMonth() + offset, 1);
      const maxDay = daysInMonth(probe.getFullYear(), probe.getMonth());
      for (const day of days) {
        const realDay = Math.min(day, maxDay);
        const candidate = atTime(new Date(probe.getFullYear(), probe.getMonth(), realDay), schedule.time);
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  return null;
}

/** 生成人类可读的调度描述 */
function describeSchedule(schedule) {
  if (!schedule || !schedule.type) return '未设置';
  switch (schedule.type) {
    case 'manual':
      return '仅手动触发';
    case 'once': {
      if (!schedule.at) return '单次（未设置时间）';
      const d = new Date(schedule.at);
      return `单次：${formatDateTime(d)}`;
    }
    case 'interval':
      return `每 ${Math.max(1, Number(schedule.everyMinutes) || 60)} 分钟自动执行一次`;
    case 'daily':
      return `每天 ${schedule.time || '09:00'} 执行`;
    case 'weekly': {
      const days = (schedule.weekdays || []).map((d) => WEEKDAY_TEXT[Number(d)] || '').join('、');
      return `每周 ${days || '周一'} ${schedule.time || '09:00'} 执行`;
    }
    case 'monthly': {
      const days = (schedule.days || []).map((d) => `${d} 日`).join('、');
      return `每月 ${days || '1 日'} ${schedule.time || '09:00'} 执行`;
    }
    default:
      return '未设置';
  }
}

function pad(v) {
  return String(v).padStart(2, '0');
}

function formatDateTime(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 调度器：每秒检查是否有到期的定时任务
 */
class Scheduler {
  /**
   * @param {object} db Database 实例
   * @param {(campaign: object, reason: string) => Promise<any>} trigger 触发执行的回调
   * @param {(payload: object) => void} [onEvent] 事件推送
   */
  constructor(db, trigger, onEvent) {
    this.db = db;
    this.trigger = trigger;
    this.onEvent = onEvent || (() => {});
    this.timer = null;
    this.tickCount = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    this.tickCount += 1;
    const now = new Date();
    let dirty = false;

    for (const campaign of this.db.listCampaigns()) {
      if (campaign.status !== 'active') continue;
      if (campaign.schedule.type === 'manual') continue;

      // 下次执行时间缺失时补算
      if (!campaign.nextRunAt) {
        const next = scheduleNextRun(campaign.schedule, now);
        campaign.nextRunAt = next ? next.toISOString() : null;
        dirty = true;
        if (!next && campaign.schedule.type === 'once') {
          campaign.status = 'finished';
          campaign.updatedAt = now.toISOString();
        }
        continue;
      }

      if (new Date(campaign.nextRunAt) > now) continue;
      if (campaign.running) continue;

      // 到期：推进下次时间并触发
      const following = scheduleNextRun(campaign.schedule, new Date(new Date(campaign.nextRunAt).getTime() + 1000));
      campaign.nextRunAt = following ? following.toISOString() : null;
      if (!following) campaign.status = campaign.schedule.type === 'once' ? 'finished' : campaign.status;
      campaign.updatedAt = now.toISOString();
      dirty = true;

      Promise.resolve(this.trigger(campaign, 'schedule')).catch((err) => {
        this.onEvent({ type: 'error', message: `定时任务触发失败：${err.message}` });
      });
    }

    if (dirty) this.db.store.saveThrottled(200);
    // 每 5 秒推送一次心跳，供界面刷新倒计时/进度
    if (this.tickCount % 5 === 0) this.onEvent({ type: 'heartbeat', at: now.toISOString() });
  }

  /** 重新计算所有任务的 nextRunAt */
  recalcAll() {
    const now = new Date();
    for (const campaign of this.db.listCampaigns()) {
      if (campaign.kind === 'manual' && campaign.schedule.type === 'manual') {
        campaign.nextRunAt = null;
        continue;
      }
      const next = scheduleNextRun(campaign.schedule, now);
      campaign.nextRunAt = next ? next.toISOString() : null;
    }
    this.db.store.saveThrottled(100);
  }
}

module.exports = { scheduleNextRun, describeSchedule, formatDateTime, Scheduler, WEEKDAY_TEXT };
