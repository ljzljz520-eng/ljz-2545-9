/* 场次列表：直接显示 改期/取消/满额；轮询刷新经 VersionGuard 防旧响应覆盖 */
const guard = VersionGuard.createGuard();
let filter = 'all';
let cache = [];

document.getElementById('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  filter = b.dataset.f;
  render();
});

function badgeHtml(s) {
  const b = [];
  if (s.flags.cancelled) b.push(`<span class="badge danger">已取消${s.status === 'weather_cancelled' ? '·天气' : ''}</span>`);
  if (s.flags.rescheduled) b.push(`<span class="badge warn">已改期 ${esc((s.original_starts_at || '').slice(11, 16))}→${esc(s.starts_at.slice(11, 16))}</span>`);
  if (s.flags.full) b.push('<span class="badge danger">满额</span>');
  if (s.pending_plan && !s.flags.cancelled) b.push('<span class="badge info">天气预案待确认</span>');
  if (s.sale_state === 'paused') b.push('<span class="badge mute">改期处理中</span>');
  if (!b.length) b.push('<span class="badge ok">可订</span>');
  return b.join('');
}

function render() {
  const list = document.getElementById('list');
  const items = cache.filter(s => {
    if (filter === 'open') return !s.flags.cancelled && !s.flags.full && s.sale_state === 'open';
    if (filter === 'rescheduled') return s.flags.rescheduled;
    if (filter === 'cancelled') return s.flags.cancelled;
    if (filter === 'full') return s.flags.full;
    return true;
  });
  if (!items.length) { list.innerHTML = '<p class="dim">暂无符合条件的场次。</p>'; return; }
  list.innerHTML = items.map(s => {
    const dt = fmtDay(s.starts_at);
    const pct = s.capacity ? Math.min(100, Math.round(s.taken / s.capacity * 100)) : 0;
    const cls = ['stub', s.flags.cancelled ? 'cancelled' : '', s.flags.full ? 'full' : ''].join(' ');
    const bookable = !s.flags.cancelled && !s.flags.full && s.sale_state === 'open';
    return `<article class="${cls}" data-id="${esc(s.id)}">
      <div class="date-block"><span class="d">${esc(dt.d)}</span><span class="m">${esc(dt.m)}</span><span class="t">${esc(dt.t)}</span></div>
      <div class="body">
        <h3>${esc(s.film.title)}</h3>
        <div class="meta"><span>${esc(s.venue.name)}</span><span>${s.film.duration_min}′</span><span>v${s.version}</span></div>
        <div class="badges">${badgeHtml(s)}</div>
        <div class="foot">
          <div class="seatbar"><i style="width:${pct}%"></i></div>
          <span class="seats-left">${s.flags.cancelled ? '—' : `余 ${s.seats_available}/${s.capacity}`}</span>
          ${bookable
            ? `<a class="btn small" href="/screening.html?id=${encodeURIComponent(s.id)}">选座</a>`
            : `<a class="btn small ghost" href="/screening.html?id=${encodeURIComponent(s.id)}">查看</a>`}
        </div>
      </div>
    </article>`;
  }).join('');
}

async function refresh() {
  const token = guard.begin();
  try {
    const data = await Api.get('/api/screenings');
    if (!guard.accept(token)) return; // 已有更新的响应渲染过，丢弃这份旧响应
    // 行级防回退：某行 version 变旧（异常乱序）时保留新数据
    cache = data.items.map(row => {
      const prev = cache.find(c => c.id === row.id);
      return (prev && prev.version > row.version) ? prev : row;
    });
    document.getElementById('strategy').textContent = `· ${data.strategy}`;
    document.getElementById('sync-note').textContent = `同步于 ${data.server_time.slice(11, 19)}`;
    render();
  } catch (e) { /* 静默轮询失败 */ }
}

refresh();
setInterval(refresh, 10000);
