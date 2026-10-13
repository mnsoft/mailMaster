'use strict';

/**
 * 本地 UI 预览服务器：把 src/renderer 以静态站点方式提供出来，
 * 配合 src/renderer/js/dev-mock.js 的模拟数据桥，可在浏览器中直接查看完整界面。
 * 生产运行时由 Electron 通过 file:// 加载同一批文件，无需本服务器。
 *
 * 用法：node tools/preview-server.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.argv[2]) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MailMaster UI 预览已启动：http://127.0.0.1:${PORT}/`);
  console.log('（提示：预览模式使用内存模拟数据，不会真实发送邮件，也不会写入磁盘）');
});
