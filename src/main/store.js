'use strict';

/**
 * 极简 JSON 持久化存储：内存态 + 原子落盘（写临时文件后 rename）+ 合并写入节流。
 * 不依赖任何原生模块，保证在 Windows 上打包后零编译依赖。
 */

const fs = require('fs');
const path = require('path');

class JsonStore {
  /**
   * @param {string} filePath 数据文件绝对路径
   * @param {() => object} defaultsFactory 首次创建时的默认数据结构
   */
  constructor(filePath, defaultsFactory) {
    this.filePath = filePath;
    this.defaultsFactory = defaultsFactory;
    this.data = null;
    this._timer = null;
    this._writing = false;
    this._dirty = false;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = raw.trim() ? JSON.parse(raw) : this.defaultsFactory();
      } else {
        this.data = this.defaultsFactory();
      }
    } catch (err) {
      // 数据损坏时备份原文件并重建，避免直接崩溃
      try {
        const backup = `${this.filePath}.corrupt-${Date.now()}.bak`;
        fs.renameSync(this.filePath, backup);
        console.error(`[store] 数据文件解析失败，已备份到 ${backup}`, err.message);
      } catch (_) {
        /* ignore */
      }
      this.data = this.defaultsFactory();
    }
    return this.data;
  }

  get() {
    if (!this.data) this.load();
    return this.data;
  }

  /** 立即原子落盘 */
  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    this._dirty = false;
  }

  /** 节流落盘：高频写入（发送日志）时避免磁盘抖动 */
  saveThrottled(delay = 800) {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.save();
      } catch (err) {
        console.error('[store] 落盘失败', err.message);
      }
    }, delay);
  }

  /** 退出前确保数据已写入 */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._dirty && this.data) this.save();
  }
}

module.exports = { JsonStore };
