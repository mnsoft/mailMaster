'use strict';

/**
 * 极简 IMAP4rev1 客户端（只依赖 Node 内置 tls / net）
 *
 * 退信监听只需要很小的协议子集，因此不引入第三方 IMAP 库（也避免 Windows 上的原生模块问题）：
 *   CAPABILITY / STARTTLS / LOGIN / SELECT / UID SEARCH / UID FETCH / UID STORE / NOOP / LOGOUT
 *
 * 说明：
 *  - 服务端响应是「按行 + 字面量 {n}」的混合流，解析器按 CRLF 切行，
 *    遇到字面量标记则精确读取 n 字节，保证不会把正文里的换行误当行结束。
 *  - 同一时刻只允许一条命令在途（内部用队列串行化），足够轮询场景使用。
 */

const net = require('net');
const tls = require('tls');

const DEFAULT_TIMEOUT = 20000;

class ImapError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'ImapError';
    Object.assign(this, extra || {});
  }
}

/** IMAP 字符串：普通字符加引号，含 CR/LF 时用字面量 */
function quote(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function partsToText(parts) {
  return parts.map((p) => (Buffer.isBuffer(p) ? p.toString('utf8') : p)).join('');
}

/**
 * IMAP 响应流解析器：把字节流切成「逻辑行」
 * 逻辑行 = 若干文本片段 + 若干字面量 Buffer，按顺序拼接即为完整内容
 */
class ImapParser {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.need = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.need > 0) {
        if (this.buf.length < this.need) return;
        this.parts.push(this.buf.subarray(0, this.need));
        this.buf = this.buf.subarray(this.need);
        this.need = 0;
        continue;
      }
      const idx = this.buf.indexOf('\r\n');
      if (idx < 0) {
        const alt = this.buf.indexOf('\n');
        if (alt < 0) return;
        const line = this.buf.subarray(0, alt).toString('utf8');
        this.buf = this.buf.subarray(alt + 1);
        this.handleText(line);
        continue;
      }
      const line = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 2);
      this.handleText(line);
    }
  }

  handleText(text) {
    const m = /\{(\d+)\+?\}$/.exec(text);
    if (m) {
      this.parts.push(text.slice(0, m.index));
      this.need = Number(m[1]);
      return;
    }
    this.parts.push(text);
    const parts = this.parts;
    this.parts = [];
    this.onLine(parts);
  }
}

class ImapClient {
  constructor(options = {}) {
    this.host = options.host;
    this.secure = options.secure !== false;
    this.port = Number(options.port) || (this.secure ? 993 : 143);
    this.user = options.user || '';
    this.pass = options.pass || '';
    this.timeoutMs = Number(options.timeout) || DEFAULT_TIMEOUT;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.requireStartTls = options.requireStartTls !== false;

    this.socket = null;
    this.parser = null;
    this.tagSeq = 0;
    this.queue = Promise.resolve();
    this.waiter = null;
    this.connected = false;
    this.greeting = '';
    this.capabilities = [];
    this.closedReason = null;
    this.greetingPromise = null;
  }

  /* --------------------------- 连接层 --------------------------- */

  async connect() {
    if (!this.host) throw new ImapError('未配置 IMAP 服务器地址', { stage: 'connect' });
    await this.openSocket();
    return this.greeting;
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        cleanup();
        reject(new ImapError(`无法连接 IMAP 服务器 ${this.host}:${this.port} —— ${err.message}`, { stage: 'connect' }));
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
      };
      const onTimeout = () => {
        cleanup();
        try {
          socket.destroy();
        } catch (_) {
          /* ignore */
        }
        reject(new ImapError(`连接 IMAP 服务器超时（${this.host}:${this.port}）`, { stage: 'connect' }));
      };

      let socket;
      if (this.secure) {
        socket = tls.connect({
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: this.rejectUnauthorized,
        });
      } else {
        socket = net.connect({ host: this.host, port: this.port });
      }

      this.attach(socket);
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      socket.setTimeout(this.timeoutMs);

      this.greetingPromise = new Promise((res, rej) => {
        this.greetingResolve = res;
        this.greetingReject = rej;
      });

      this.greetingPromise
        .then((text) => {
          cleanup();
          this.connected = true;
          if (/^\*\s+BYE/i.test(text)) {
            reject(new ImapError(`IMAP 服务器拒绝连接：${text}`, { stage: 'connect' }));
            return;
          }
          resolve(text);
        })
        .catch(() => {
          /* 由 onError / onTimeout 统一处理 */
        });
    });
  }

  attach(socket) {
    this.socket = socket;
    this.parser = new ImapParser((parts) => this.onLine(parts));
    socket.on('data', (chunk) => {
      try {
        this.parser.push(chunk);
      } catch (err) {
        this.failAll(new ImapError(`解析 IMAP 响应失败：${err.message}`, { stage: 'parse' }));
      }
    });
    socket.on('error', (err) => this.failAll(new ImapError(`IMAP 连接出错：${err.message}`, { stage: 'socket' })));
    socket.on('close', () => {
      this.connected = false;
      this.closedReason = this.closedReason || '连接已关闭';
      this.failAll(new ImapError(this.closedReason, { stage: 'socket' }));
    });
  }

  onLine(parts) {
    const text = partsToText(parts);

    // 首个响应即问候语
    if (!this.greeting && !this.waiter && this.greetingResolve) {
      this.greeting = text;
      const resolve = this.greetingResolve;
      this.greetingResolve = null;
      resolve(text);
      return;
    }

    // 续行提示：客户端命令中的字面量
    if (/^\+/.test(text)) {
      if (this.waiter && this.waiter.contResolve) {
        const cont = this.waiter.contResolve;
        this.waiter.contResolve = null;
        cont();
      }
      return;
    }

    const waiter = this.waiter;
    if (!waiter) return; // 无人等待的命令响应（如未请求的 EXISTS）直接忽略

    const tagged = new RegExp(`^${waiter.tag} (OK|NO|BAD)\\b`, 'i').exec(text);
    if (tagged) {
      waiter.status = tagged[1].toUpperCase();
      waiter.statusText = text;
      this.settleWaiter({ status: waiter.status, text: waiter.statusText, lines: waiter.lines });
      return;
    }

    if (/^\*\s+BYE/i.test(text)) this.closedReason = text;
    waiter.lines.push({ text, parts });
  }

  settleWaiter(result) {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  failAll(err) {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(err);
  }

  write(data) {
    if (!this.socket || this.socket.destroyed) throw new ImapError('IMAP 连接已断开', { stage: 'write' });
    this.socket.write(data);
  }

  nextTag() {
    this.tagSeq += 1;
    return `A${String(this.tagSeq).padStart(4, '0')}`;
  }

  /* --------------------------- 命令层 --------------------------- */

  /** 串行执行一条命令；args 中可用 { raw: 'xxx' } 原样透传 */
  command(name, args = []) {
    const run = () => this.runCommand(name, args);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async runCommand(name, args) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new ImapError('IMAP 连接不可用', { stage: 'command', command: name });
    }
    const tag = this.nextTag();
    const segments = [];
    let pending = `${tag} ${name}`;

    for (const arg of args) {
      const obj = arg && typeof arg === 'object' && !Buffer.isBuffer(arg) ? arg : { value: arg };
      if (obj.raw !== undefined) {
        pending += ` ${obj.raw}`;
        continue;
      }
      const value = Buffer.isBuffer(obj.value) ? obj.value : String(obj.value == null ? '' : obj.value);
      if (Buffer.isBuffer(value) || /[\r\n]/.test(value)) {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
        segments.push({ kind: 'text', value: `${pending} {${buf.length}}` });
        segments.push({ kind: 'literal', buf });
        pending = '';
      } else {
        pending += ` ${quote(value)}`;
      }
    }
    segments.push({ kind: 'text', value: `${pending}\r\n` });

    const result = new Promise((resolve, reject) => {
      this.waiter = { tag, lines: [], resolve, reject, timer: null, contResolve: null };
      this.waiter.timer = setTimeout(() => {
        const waiter = this.waiter;
        this.waiter = null;
        if (waiter) waiter.reject(new ImapError(`IMAP 命令超时（${name}）`, { stage: 'command', command: name }));
        this.destroy();
      }, this.timeoutMs);
      if (this.waiter.timer.unref) this.waiter.timer.unref();
    });

    for (const seg of segments) {
      if (seg.kind === 'text') {
        this.write(seg.value);
        continue;
      }
      this.write('\r\n');
      await this.waitContinuation();
      this.write(seg.buf);
    }

    return result;
  }

  waitContinuation() {
    const waiter = this.waiter;
    if (!waiter) return Promise.resolve();
    return new Promise((resolve) => {
      waiter.contResolve = resolve;
    });
  }

  /* --------------------------- 语义层 --------------------------- */

  async capability() {
    const res = await this.command('CAPABILITY');
    const line = res.lines.map((l) => l.text).find((t) => /^\*\s+CAPABILITY/i.test(t)) || '';
    this.capabilities = line
      .replace(/^\*\s+CAPABILITY\s*/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => c.toUpperCase());
    return this.capabilities;
  }

  /** 明文连接时升级为 TLS（143 + STARTTLS） */
  async startTls() {
    const res = await this.command('STARTTLS');
    if (res.status !== 'OK') throw new ImapError(`STARTTLS 被服务器拒绝：${res.text}`, { stage: 'starttls' });

    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');

    const secured = tls.connect({
      socket: plain,
      servername: this.host,
      rejectUnauthorized: this.rejectUnauthorized,
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(new ImapError(`STARTTLS 握手失败：${err.message}`, { stage: 'starttls' }));
      secured.once('error', onError);
      secured.once('secureConnect', () => {
        secured.removeListener('error', onError);
        resolve();
      });
    });
    this.attach(secured);
    secured.setTimeout(this.timeoutMs);
    return true;
  }

  async login() {
    const res = await this.command('LOGIN', [this.user, this.pass]);
    if (res.status !== 'OK') {
      throw new ImapError(`IMAP 登录失败：${cleanHint(res.text)}`, { stage: 'login' });
    }
    return true;
  }

  async select(mailbox = 'INBOX') {
    const res = await this.command('SELECT', [mailbox]);
    if (res.status !== 'OK') {
      throw new ImapError(`无法打开邮箱「${mailbox}」：${cleanHint(res.text)}`, { stage: 'select' });
    }
    let exists = 0;
    for (const line of res.lines) {
      const m = /^\*\s+(\d+)\s+EXISTS/i.exec(line.text);
      if (m) exists = Number(m[1]);
    }
    return { exists };
  }

  /**
   * UID SEARCH
   * @param {string[]} criteria 例如 ['UNSEEN', 'SINCE 12-Oct-2026']，可传空数组表示 ALL
   */
  async search(criteria) {
    const tokens = (criteria && criteria.length ? criteria : ['ALL']).map((c) => ({ raw: c }));
    const res = await this.command('UID SEARCH', tokens);
    if (res.status !== 'OK') throw new ImapError(`搜索邮件失败：${cleanHint(res.text)}`, { stage: 'search' });
    const uids = [];
    for (const line of res.lines) {
      const m = /^\*\s+SEARCH\b([\s\S]*)$/i.exec(line.text);
      if (!m) continue;
      for (const token of m[1].trim().split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(Number(token));
      }
    }
    return uids;
  }

  /** 取整封邮件原始内容（BODY.PEEK[] 不会把邮件标成已读） */
  async fetchRaw(uid) {
    const res = await this.command('UID FETCH', [{ raw: String(uid) }, { raw: '(BODY.PEEK[])' }]);
    if (res.status !== 'OK') throw new ImapError(`读取邮件 ${uid} 失败：${cleanHint(res.text)}`, { stage: 'fetch' });
    for (const line of res.lines) {
      const literal = line.parts.find((p) => Buffer.isBuffer(p));
      if (literal) return literal;
    }
    return null;
  }

  /** 取邮件头（用于快速判断是否为退信，正文太大时可省流量） */
  async fetchHeaders(uid) {
    const res = await this.command('UID FETCH', [{ raw: String(uid) }, { raw: '(BODY.PEEK[HEADER])' }]);
    if (res.status !== 'OK') throw new ImapError(`读取邮件头 ${uid} 失败：${cleanHint(res.text)}`, { stage: 'fetch' });
    for (const line of res.lines) {
      const literal = line.parts.find((p) => Buffer.isBuffer(p));
      if (literal) return literal;
    }
    return null;
  }

  async markSeen(uid) {
    const res = await this.command('UID STORE', [{ raw: String(uid) }, { raw: '+FLAGS' }, { raw: '(\\Seen)' }]);
    return res.status === 'OK';
  }

  async noop() {
    const res = await this.command('NOOP');
    return res.status === 'OK';
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch (_) {
      /* 服务端可能直接断开 */
    }
    this.destroy();
  }

  destroy() {
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    this.socket = null;
  }

  /** 一次性流程：连接 → （STARTTLS）→ 登录 → 打开邮箱 */
  static async open(config, options = {}) {
    const client = new ImapClient({
      host: config.host,
      port: config.port,
      secure: config.secure !== false,
      user: config.user || config.email,
      pass: config.pass,
      timeout: options.timeout,
      rejectUnauthorized: options.rejectUnauthorized,
    });
    await client.connect();
    if (!client.secure) {
      const caps = await client.capability().catch(() => []);
      if (caps.includes('STARTTLS')) {
        await client.startTls();
      } else if (!(options.allowInsecure || config.allowInsecure)) {
        client.destroy();
        throw new ImapError(
          '服务器未提供 STARTTLS，明文传输密码有风险，已中止连接。若确为内网或本机邮件服务器，可在账号里勾选「允许明文连接」',
          { stage: 'starttls' },
        );
      }
    }
    await client.login();
    const box = await client.select(config.mailbox || 'INBOX');
    return { client, exists: box.exists };
  }
}

/** 去掉 IMAP 响应里的标签前缀，便于直接展示给用户 */
function cleanHint(text) {
  return String(text || '').replace(/^A\d+\s+(OK|NO|BAD)\s*/i, '').trim() || '服务器未提供原因';
}

/**
 * 测试 IMAP 连接（供界面「测试连接」按钮使用）
 * @param {object} config { host, port, secure, user, pass, mailbox }
 */
async function verifyConnection(config) {
  const started = Date.now();
  let client = null;
  try {
    const opened = await ImapClient.open(config, { timeout: 15000 });
    client = opened.client;
    const message = `IMAP 连接成功 · ${config.host}:${config.port || (config.secure === false ? 143 : 993)} · 邮箱 ${config.mailbox || 'INBOX'}（当前 ${opened.exists} 封）`;
    return { ok: true, message, durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, message: err.message, stage: err.stage || '', durationMs: Date.now() - started };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch (_) {
        client.destroy();
      }
    }
  }
}

module.exports = { ImapClient, ImapParser, ImapError, verifyConnection, quote };
