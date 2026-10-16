'use strict';

/**
 * Spintax 语法引擎（同义词轮换）
 *
 * 语法：`{选项A|选项B|选项C}` —— 每次渲染随机取其中一个，使每封邮件的主题与正文字面不同。
 *  - 支持嵌套：`{您好|{早上好|下午好}}`
 *  - 用 `\{` `\}` 输出字面大括号
 *  - 只有「含有顶层 `|` 的大括号组」才被当作 Spintax，因此与本应用既有的 `{{变量}}` 语法完全不冲突，
 *    正文里正常写 `{}` 也不会被误解析。
 *
 * 关键能力：`expand(source, { used })` 会优先挑选「本批次尚未使用过」的组合，
 * 于是只要组合总数 ≥ 收件人数，就能保证这一批每封邮件的内容都不重复。
 */

const MAX_DEPTH = 12;

let nextGroupId = 1;

/** 解析大括号组：返回节点列表 */
function parseNodes(src, start, depth) {
  const nodes = [];
  let buf = '';
  let pos = start;

  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (pos < src.length) {
    const ch = src[pos];

    // 转义：\{ \} 输出字面大括号
    if (ch === '\\' && (src[pos + 1] === '{' || src[pos + 1] === '}')) {
      buf += src[pos + 1];
      pos += 2;
      continue;
    }

    if (ch === '}') {
      flush();
      return { nodes, pos, closed: true };
    }

    if (ch === '{') {
      if (depth >= MAX_DEPTH) {
        buf += ch;
        pos += 1;
        continue;
      }
      const inner = parseNodes(src, pos + 1, depth + 1);
      if (!inner.closed) {
        // 未闭合的 `{`：当普通字符处理，避免吞掉后续正文
        buf += ch;
        pos += 1;
        continue;
      }
      flush();
      nodes.push({
        type: 'group',
        id: nextGroupId++,
        options: splitOptions(inner.nodes),
      });
      pos = inner.pos + 1;
      continue;
    }

    buf += ch;
    pos += 1;
  }

  flush();
  return { nodes, pos, closed: false };
}

/** 把组内节点按顶层 `|` 切成若干选项 */
function splitOptions(nodes) {
  const options = [[]];
  for (const node of nodes) {
    if (node.type === 'text' && node.value.includes('|')) {
      const parts = node.value.split('|');
      parts.forEach((part, i) => {
        if (i > 0) options.push([]);
        if (part) options[options.length - 1].push({ type: 'text', value: part });
      });
      continue;
    }
    options[options.length - 1].push(node);
  }
  return options;
}

/** 该组是否真的是 Spintax（选项数 > 1） */
function isSpin(node) {
  return node.type === 'group' && node.options.length > 1;
}

function parse(source) {
  return parseNodes(String(source == null ? '' : source), 0, 0).nodes;
}

/** 组合总数（所有 Spintax 组选项数的乘积） */
function countNodes(nodes) {
  let total = 1;
  for (const node of nodes) {
    if (node.type === 'text') continue;
    if (isSpin(node)) {
      total *= node.options.reduce((sum, option) => sum + countNodes(option), 0);
    } else {
      total *= countNodes(node.options[0] || []);
    }
  }
  return total;
}

/** 模板可产生的不同内容组合数；无 Spintax 时为 1 */
function countVariants(source) {
  const variants = countNodes(parse(source));
  return variants > 0 ? variants : 1;
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
      continue;
    }
    const spin = isSpin(node);
    if (spin) {
      const idx = ctx.choose(node);
      ctx.choices.push({ id: node.id, index: idx });
      out += renderNodes(node.options[idx], ctx);
    } else {
      // 单选项的 `{}` 不是 Spintax，原样保留大括号
      out += `{${renderNodes(node.options[0] || [], ctx)}}`;
    }
  }
  return out;
}

/**
 * 按「组合序号」确定性地渲染
 *
 * 把整棵语法树的所有组合按深度优先顺序编号 0..variants-1，
 * 因此给定序号就能唯一确定一组选项 —— 这是「保证同批次不重复」的基础。
 */
function renderByIndex(nodes, index) {
  let rest = index;
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
      continue;
    }
    if (!isSpin(node)) {
      out += `{${renderByIndex(node.options[0] || [], rest)}}`;
      continue;
    }
    const sizes = node.options.map((option) => countNodes(option));
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    let local = ((rest % total) + total) % total;
    let picked = 0;
    for (let i = 0; i < sizes.length; i += 1) {
      if (local < sizes[i]) {
        picked = i;
        break;
      }
      local -= sizes[i];
    }
    rest = Math.floor(rest / total);
    out += renderByIndex(node.options[picked], local);
  }
  return out;
}

/**
 * 选取一个组合序号；传入 used 集合时优先挑没用过的（用尽后自动开启新一轮）
 * @param {number} variants 组合总数
 * @param {Set<number>|null} used
 * @param {() => number} rng
 */
function pickIndex(variants, used, rng) {
  const total = Math.max(1, variants);
  const random = typeof rng === 'function' ? rng : Math.random;
  if (!used) return Math.floor(random() * total) % total;

  if (used.size >= total) used.clear(); // 组合用尽：开启新一轮，避免死循环
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const idx = Math.floor(random() * total) % total;
    if (!used.has(idx)) {
      used.add(idx);
      return idx;
    }
  }
  // 随机撞车太多次时退化为线性扫描（整数比较，成本极低）
  for (let i = 0; i < total; i += 1) {
    if (!used.has(i)) {
      used.add(i);
      return i;
    }
  }
  used.clear();
  used.add(0);
  return 0;
}

/**
 * 展开 Spintax
 * @param {string} source 模板文本
 * @param {object} [options]
 * @param {number} [options.index] 指定组合序号（确定性展开）
 * @param {() => number} [options.rng] 随机数发生器，便于测试注入
 * @param {Set<number>} [options.used] 本批次已用过的组合序号；传入即启用去重
 * @returns {{ text: string, index: number, variants: number, groups: number }}
 */
function expand(source, options = {}) {
  const text = String(source == null ? '' : source);
  const nodes = parse(text);
  const variants = Math.max(1, countNodes(nodes));
  const groups = countSpinGroups(nodes, 0);
  const index = options.index != null ? Number(options.index) : pickIndex(variants, options.used, options.rng);
  return { text: renderByIndex(nodes, index), index, variants, groups };
}

function countSpinGroups(nodes, acc) {
  let total = acc;
  for (const node of nodes) {
    if (node.type === 'text') continue;
    if (isSpin(node)) {
      total += 1;
      for (const option of node.options) total = countSpinGroups(option, total);
    } else {
      total = countSpinGroups(node.options[0] || [], total);
    }
  }
  return total;
}

/** 列出所有 Spintax 组（供界面展示与冲突提示） */
function listGroups(source) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      if (isSpin(node)) {
        out.push({
          id: node.id,
          options: node.options.map((option) => renderNodes(option, { choose: () => 0, choices: [] })),
        });
        node.options.forEach(walk);
      } else {
        walk(node.options[0] || []);
      }
    }
  };
  walk(parse(source));
  return out;
}

/** 概览：是否有 Spintax、能产生多少种不同内容 */
function describe(source) {
  const groups = listGroups(source);
  return {
    hasSpintax: groups.length > 0,
    groupCount: groups.length,
    variants: countVariants(source),
    groups,
  };
}

/** 可复现随机数（mulberry32） */
function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  const str = String(seed);
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  parse,
  expand,
  renderByIndex,
  pickIndex,
  countVariants,
  listGroups,
  describe,
  seededRandom,
  MAX_DEPTH,
};
