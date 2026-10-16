'use strict';

/**
 * 发送节奏控制：把「固定间隔」升级为可模拟人工发送痕迹的节奏模型。
 *
 * 支持：
 *  - 固定间隔（intervalSeconds，精确可预期）
 *  - 随机延迟（delayMinSeconds ~ delayMaxSeconds 之间随机取值，避免等间隔的机器特征）
 *  - 长停顿（每发送 burstEvery 封后插入一次 burstMin ~ burstMax 秒的较长休息）
 *  - 每小时上限（hourlyLimit，达到后自动等待到下一个小时窗口再继续）
 *
 * 只做纯计算，不依赖时间与网络，便于测试与复用。
 */

const DEFAULTS = {
  mode: 'fixed', // 'fixed' | 'random'
  intervalSeconds: 6,
  delayMinSeconds: 20,
  delayMaxSeconds: 90,
  burstEvery: 0, // 0 表示不插入长停顿
  burstMinSeconds: 180,
  burstMaxSeconds: 420,
  hourlyLimit: 0, // 0 表示不限速
  dailyLimit: 200,
  maxRetries: 1,
};

/** 上限保护：避免误填出「等 3 天」这类离谱配置 */
const MAX_DELAY_SECONDS = 6 * 3600;

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 归一化节奏配置：兼容旧数据的 { intervalSeconds, dailyLimit, maxRetries }
 * @param {object} input
 * @returns {object}
 */
function normalize(input = {}) {
  const raw = Object.assign({}, DEFAULTS, input || {});
  // 旧任务没有 mode 字段：沿用固定间隔语义，保证行为不变
  const mode = raw.mode === 'random' ? 'random' : 'fixed';

  const intervalSeconds = clamp(toInt(raw.intervalSeconds, DEFAULTS.intervalSeconds), 0, MAX_DELAY_SECONDS);
  let delayMinSeconds = clamp(toInt(raw.delayMinSeconds, DEFAULTS.delayMinSeconds), 0, MAX_DELAY_SECONDS);
  let delayMaxSeconds = clamp(toInt(raw.delayMaxSeconds, DEFAULTS.delayMaxSeconds), 0, MAX_DELAY_SECONDS);
  if (delayMaxSeconds < delayMinSeconds) delayMaxSeconds = delayMinSeconds;

  let burstMinSeconds = clamp(toInt(raw.burstMinSeconds, DEFAULTS.burstMinSeconds), 0, MAX_DELAY_SECONDS);
  let burstMaxSeconds = clamp(toInt(raw.burstMaxSeconds, DEFAULTS.burstMaxSeconds), 0, MAX_DELAY_SECONDS);
  if (burstMaxSeconds < burstMinSeconds) burstMaxSeconds = burstMinSeconds;

  return {
    mode,
    intervalSeconds,
    delayMinSeconds,
    delayMaxSeconds,
    burstEvery: clamp(toInt(raw.burstEvery, DEFAULTS.burstEvery), 0, 5000),
    burstMinSeconds,
    burstMaxSeconds,
    hourlyLimit: clamp(toInt(raw.hourlyLimit, DEFAULTS.hourlyLimit), 0, 100000),
    dailyLimit: clamp(toInt(raw.dailyLimit, DEFAULTS.dailyLimit), 0, 1000000),
    maxRetries: clamp(toInt(raw.maxRetries, DEFAULTS.maxRetries), 0, 20),
  };
}

function randomBetween(min, max, rng) {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 计算「发完第 sentCount 封之后、发下一封之前」需要等待的毫秒数
 * @param {object} config normalize() 的结果
 * @param {{ sentCount: number, rng?: () => number }} context sentCount 为本轮已发送封数
 * @returns {{ ms: number, kind: 'interval'|'random'|'burst' }}
 */
function nextDelay(config, context = {}) {
  const cfg = normalize(config);
  const sentCount = Math.max(0, toInt(context.sentCount, 0));
  const rng = typeof context.rng === 'function' ? context.rng : Math.random;

  // 长停顿优先：每发送 burstEvery 封后休息一次
  if (cfg.burstEvery > 0 && sentCount > 0 && sentCount % cfg.burstEvery === 0) {
    return { ms: randomBetween(cfg.burstMinSeconds, cfg.burstMaxSeconds, rng) * 1000, kind: 'burst' };
  }

  if (cfg.mode === 'random') {
    // 随机模式下即便是 0 也允许留一点最小间隔，避免瞬时并发
    return { ms: randomBetween(cfg.delayMinSeconds, cfg.delayMaxSeconds, rng) * 1000, kind: 'random' };
  }

  return { ms: cfg.intervalSeconds * 1000, kind: 'interval' };
}

/**
 * 估算整批耗时（毫秒），用于界面提示
 * @param {object} config
 * @param {number} total 收件人总数
 */
function estimateMs(config, total) {
  const cfg = normalize(config);
  const count = Math.max(0, toInt(total, 0));
  if (count <= 0) return 0;

  const average = cfg.mode === 'random' ? (cfg.delayMinSeconds + cfg.delayMaxSeconds) / 2 : cfg.intervalSeconds;
  let ms = average * 1000 * Math.max(0, count - 1);

  if (cfg.burstEvery > 0) {
    const bursts = Math.floor(Math.max(0, count - 1) / cfg.burstEvery);
    // 长停顿会替代一次普通间隔，这里减去被替代的部分
    ms += bursts * (((cfg.burstMinSeconds + cfg.burstMaxSeconds) / 2 - average) * 1000);
  }

  if (cfg.hourlyLimit > 0 && count > cfg.hourlyLimit) {
    const extraHours = Math.ceil(count / cfg.hourlyLimit) - 1;
    ms += extraHours * 3600 * 1000;
  }

  return Math.max(0, Math.round(ms));
}

/** 把毫秒描述成人话 */
function humanizeMs(ms) {
  if (!ms || ms < 1000) return '几乎瞬时';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `约 ${h} 小时 ${m} 分`;
  if (m > 0) return `约 ${m} 分 ${s} 秒`;
  return `约 ${s} 秒`;
}

/** 生成给用户看的中文说明 */
function describe(config) {
  const cfg = normalize(config);
  const parts = [];
  parts.push(
    cfg.mode === 'random'
      ? `随机延迟 ${cfg.delayMinSeconds}–${cfg.delayMaxSeconds} 秒/封`
      : `固定间隔 ${cfg.intervalSeconds} 秒/封`,
  );
  if (cfg.burstEvery > 0) {
    parts.push(`每 ${cfg.burstEvery} 封后休息 ${cfg.burstMinSeconds}–${cfg.burstMaxSeconds} 秒`);
  }
  if (cfg.hourlyLimit > 0) parts.push(`每小时最多 ${cfg.hourlyLimit} 封`);
  if (cfg.dailyLimit > 0) parts.push(`每日最多 ${cfg.dailyLimit} 封`);
  return parts.join(' · ');
}

/**
 * 每小时限速：返回还需要等待的毫秒数
 * @param {number[]} recentTimestamps 最近发送的时间戳（毫秒，升序或乱序均可）
 * @param {number} hourlyLimit
 * @param {number} [now]
 */
function waitForHourlySlot(recentTimestamps, hourlyLimit, now = Date.now()) {
  const limit = toInt(hourlyLimit, 0);
  if (limit <= 0) return 0;
  const windowStart = now - 3600 * 1000;
  const inWindow = (recentTimestamps || []).filter((t) => t > windowStart).sort((a, b) => a - b);
  if (inWindow.length < limit) return 0;
  // 等到最早的一次发送滑出 1 小时窗口
  const oldest = inWindow[inWindow.length - limit];
  return Math.max(0, oldest + 3600 * 1000 - now) + 50;
}

/** 预设：供界面一键套用 */
const PRESETS = [
  {
    key: 'steady',
    label: '稳健匀速',
    hint: '固定 10 秒/封，适合自建 SMTP 通道',
    config: { mode: 'fixed', intervalSeconds: 10, burstEvery: 0, hourlyLimit: 0, dailyLimit: 200, maxRetries: 1 },
  },
  {
    key: 'human',
    label: '拟人节奏（推荐）',
    hint: '20–90 秒随机 + 每 10 封长休息，最接近人工发送',
    config: {
      mode: 'random',
      delayMinSeconds: 20,
      delayMaxSeconds: 90,
      burstEvery: 10,
      burstMinSeconds: 180,
      burstMaxSeconds: 420,
      hourlyLimit: 60,
      dailyLimit: 200,
      maxRetries: 1,
    },
  },
  {
    key: 'conservative',
    label: '保守低频',
    hint: '1–3 分钟随机 + 每小时 20 封上限，适合普通邮箱 SMTP',
    config: {
      mode: 'random',
      delayMinSeconds: 60,
      delayMaxSeconds: 180,
      burstEvery: 8,
      burstMinSeconds: 600,
      burstMaxSeconds: 1200,
      hourlyLimit: 20,
      dailyLimit: 80,
      maxRetries: 1,
    },
  },
  {
    key: 'fast',
    label: '快速通道',
    hint: '5 秒/封，配合腾讯云邮件推送等专业通道使用',
    config: { mode: 'fixed', intervalSeconds: 5, burstEvery: 0, hourlyLimit: 0, dailyLimit: 1000, maxRetries: 2 },
  },
];

module.exports = {
  DEFAULTS,
  PRESETS,
  normalize,
  nextDelay,
  estimateMs,
  humanizeMs,
  describe,
  waitForHourlySlot,
  MAX_DELAY_SECONDS,
};
