/** 轻量 API 客户端：统一错误提示；所有渲染经过 VersionGuard 防旧响应覆盖 */
const Api = {
  token: localStorage.getItem('admin_token') || '',
  async call(method, url, body, useAdmin) {
    const headers = { 'Content-Type': 'application/json' };
    if (useAdmin) headers['x-admin-token'] = this.token || 'dev-admin-token';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      err.code = data.error && data.error.code;
      err.status = res.status;
      err.details = data.error && data.error.details;
      throw err;
    }
    return data;
  },
  get(u, useAdmin) { return this.call('GET', u, undefined, useAdmin); },
  post(u, b, a) { return this.call('POST', u, b, a); },
  del(u, a) { return this.call('DELETE', u, undefined, a); },
};

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function fmtDay(iso) { return { d: iso.slice(8, 10), m: iso.slice(0, 7), t: iso.slice(11, 16) }; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
