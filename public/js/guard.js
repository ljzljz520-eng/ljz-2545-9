/**
 * 版本守卫（浏览器/Node 双端可用）：
 * 保证“网页版本不被旧响应覆盖”——
 *  1) 列表级：每次请求领取递增令牌，响应到达时若已有更新的响应被应用，则丢弃；
 *  2) 行级：每行数据带 version，已渲染更新的 version 后，旧 version 的响应不再覆盖。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VersionGuard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function createGuard() {
    let issued = 0;        // 已发出的请求令牌
    let applied = 0;       // 已应用的响应令牌
    const rowVersions = new Map();
    return {
      begin() { return ++issued; },
      /** 响应是否允许渲染（只允许严格更新的响应） */
      accept(token) {
        if (typeof token !== 'number' || token <= applied) return false;
        applied = token;
        return true;
      },
      /** 行级版本：version 低于已渲染版本则拒绝 */
      acceptRow(id, version) {
        const v = rowVersions.get(id);
        if (v !== undefined && version < v) return false;
        rowVersions.set(id, version);
        return true;
      },
      rowVersion(id) { return rowVersions.get(id); },
      reset() { issued = 0; applied = 0; rowVersions.clear(); },
      snapshot() { return { issued, applied, rows: rowVersions.size }; },
    };
  }
  return { createGuard };
});
