'use strict';
/** 应用装配：内存/文件 SQLite + 路由 + 静态资源。createApp() 供测试以独立配置启动。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, makeTx, nextNo } = require('./db');
const { createServices } = require('./services');
const { createRouter, send } = require('./router');
const { registerRoutes } = require('./api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function createApp(config = {}) {
  const db = openDb(config.dbPath);
  const tx = makeTx(db);
  const svc = createServices(db, tx, (k) => nextNo(db, k), { strategy: config.strategy });
  const router = createRouter();
  const adminToken = config.adminToken || process.env.ADMIN_TOKEN || 'dev-admin-token';
  registerRoutes(router, { db, tx, nextNo: (k) => nextNo(db, k), svc, adminToken });

  const sweeper = setInterval(() => { try { svc.sweepExpiredHolds(); } catch (e) { console.error('[sweep]', e.message); } },
    Number(config.sweepIntervalMs || 30000));
  sweeper.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const matched = await router.handle(req, res, {});
      if (!matched) send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const filePath = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } }); return; }
    serveStatic(res, filePath);
  });

  return { server, db, svc, close: () => { clearInterval(sweeper); db.close(); } };
}

if (require.main === module) {
  const { seedIfEmpty } = require('./seed');
  const app = createApp();
  seedIfEmpty(app.db);
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => {
    console.log(`星空放映厅 · Starlit Cinema`);
    console.log(`  网站:     http://localhost:${port}/`);
    console.log(`  后台:     http://localhost:${port}/admin.html  (令牌: dev-admin-token)`);
    console.log(`  设计说明: http://localhost:${port}/design.html`);
    console.log(`  席位策略: ${app.svc.strategy}`);
  });
}

module.exports = { createApp };
