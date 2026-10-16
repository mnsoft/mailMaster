# MailMaster 项目长期备忘

Electron 桌面邮件推广工具（面向 Win10）。主进程 `src/main/`、渲染层 `src/renderer/`，
全部数据落在单个 JSON（`JsonStore`）；渲染层页面模块挂在 `window.MM.pages.<route>`，
IPC 统一 `{ok, data}` 信封。

## 上线流程（用户硬性要求）

1. **先预览**：`npm run preview` → http://127.0.0.1:4173/ （dev-mock 内存模拟，不落盘不发信），
   只给地址，**不要截图**。
2. 用户确认后才：提交推送 → `package.json` 升版本号 → 打包。
3. 预览必须是「正式文件副本 + 本次改动」，不允许另写独立预览页。

## 命令（本机 WorkBuddy 环境下必须清注入变量）

```bash
npm test                                        # 数据契约测试（node）
npm run preview                                 # 预览服务 :4173
env -u ELECTRON_RUN_AS_NODE npm run smoke       # 无头 UI 冒烟（真实 DOM，需 preview 在跑）
env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE npm run build:win   # 打 Windows 包
```

- `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node；
- `NODE_OPTIONS` 注入了 WorkBuddy 的 `node-language-shim.cjs` 文件代理，
  会让 electron-builder 写 `.asar` 时报 `Brokered file token refused: modify backup failed`。
  打包必须清掉它。
- 打包产物：`dist/MailMaster-<version>-x64-setup.exe`、`-portable.exe`、`.blockmap`。
- 核对产物内容用 `@electron/asar` 的 `listPackage` / `extractFile`（别用 grep 探测字符串）。

## 版本号

单一来源 `package.json` 的 `version`，主进程走 `app.getVersion()`；
`src/renderer/js/dev-mock.js` 的 `info()` 需手动同步（预览层读不到 electron 的 version）。

## 环境坑（macOS）

- BSD `grep` 的 BRE 不支持 `\|`，要用 `grep -E`。
- 外部卷 `/Volumes/mnSHAcn` 偶发读取竞态：刚写完立刻读可能为空，复核一次即可。
- 同一文件的多个改动必须串行编辑，改完立刻回读复核。
