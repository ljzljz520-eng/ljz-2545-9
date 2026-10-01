'use strict';
/** 极简路由器：支持 :param 路径参数、JSON body、统一错误格式 */
const { ApiError } = require('./util');

function createRouter() {
  const routes = [];
  function add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler });
  }
  async function handle(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
        body = await readJson(req);
      }
      try {
        const result = await r.handler({ params, query: Object.fromEntries(url.searchParams), body, req, ...ctx });
        if (result !== undefined) send(res, 200, result);
        return true;
      } catch (e) {
        const status = e instanceof ApiError ? e.status : (Number.isInteger(e.status) ? e.status : 500);
        if (status === 500) console.error('[500]', e);
        send(res, status, { error: { code: e.code || 'INTERNAL', message: e.message, details: e.details } });
        return true;
      }
    }
    return false;
  }
  return { add, handle };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

module.exports = { createRouter, send };
