/* 后台管理：所有变更携带 expected_version；409 STALE_VERSION 时提示并刷新 */
const $ = s => document.querySelector(s);
const A = { sessions: [], films: [], venues: [], plans: [] };
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = n => String(n).padStart(2, '0');
const fmtT = iso => { const d = new Date(iso); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 2600);
}
function handle(r, okMsg) {
  if (r.status === 409 && r.data.error === 'STALE_VERSION') {
    toast(`数据已被他人修改（当前 v${r.data.current_version}），已刷新`);
    loadSessions();
    return false;
  }
  if (r.status >= 400) { toast('失败：' + (r.data.detail || r.data.error || r.status)); return false; }
  if (okMsg) toast(okMsg);
  return true;
}

/* ---------- 标签页 ---------- */
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'panel-' + b.dataset.tab));
  ({ sessions: loadSessions, films: loadFilms, venues: loadVenues, weather: loadPlans, notify: loadNotify, audit: loadAudit })[b.dataset.tab]();
});

/* ---------- 场次 ---------- */
async function loadBase() {
  const [f, v] = await Promise.all([api('/api/films'), api('/api/venues')]);
  A.films = f.data.films || []; A.venues = v.data.venues || [];
  $('#csFilm').innerHTML = A.films.map(x => `<option value="${x.id}">${esc(x.title)}（${x.duration_min}′）</option>`).join('');
  $('#csVenue').innerHTML = A.venues.map(x => `<option value="${x.id}">${esc(x.name)}（${x.capacity}座）</option>`).join('');
}
async function loadSessions() {
  const { data } = await api('/api/sessions');
  A.sessions = data.sessions || [];
  renderSessions(); renderWxSessionOptions();
}
function badges(s) {
  const b = [];
  if (s.display_status === 'cancelled') b.push('<span class="stamp st-cancel">已取消</span>');
  if (s.rescheduled) b.push(`<span class="stamp st-move">改期×${s.reschedule_count}</span>`);
  if (s.display_status === 'full') b.push('<span class="stamp st-full">满额</span>');
  if (s.display_status === 'frozen') b.push('<span class="stamp st-freeze">冻结中</span>');
  if (s.pending_weather_plan) b.push('<span class="stamp st-wx">预案待决</span>');
  return b.join('') || '<span class="dim">正常</span>';
}
function renderSessions() {
  const rows = A.sessions.map(s => `<tr>
    <td class="mono">${esc(s.public_code)}</td>
    <td>${esc(s.film.title)}</td><td>${esc(s.venue.name)}</td>
    <td class="mono">${fmtT(s.start_time)}${s.rescheduled ? `<br><span class="dim small mono">原 ${fmtT(s.original_start_time)}</span>` : ''}</td>
    <td class="mono">${s.confirmed}/${s.capacity}</td>
    <td>${badges(s)}</td><td class="mono">v${s.version}</td>
    <td class="ops">
      <button data-act="reschedule" data-id="${s.id}" data-v="${s.version}" ${s.status === 'cancelled' ? 'disabled' : ''}>改期</button>
      <button data-act="capacity" data-id="${s.id}" data-v="${s.version}">容量</button>
      <button data-act="freeze" data-id="${s.id}" data-v="${s.version}" data-f="${s.booking_frozen}">${s.booking_frozen ? '解冻报名' : '冻结报名'}</button>
      <button data-act="cancel" data-id="${s.id}" data-v="${s.version}" ${s.status === 'cancelled' ? 'disabled' : ''}>取消</button>
      <button data-act="people" data-id="${s.id}">名单</button>
    </td></tr>`).join('');
  $('#sessionTable').innerHTML = `<table class="tbl"><thead><tr>
    <th>场次身份</th><th>影片</th><th>场地</th><th>时间</th><th>确认/容量</th><th>状态</th><th>版本</th><th>操作</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}
$('#csBtn').onclick = async () => {
  const body = { film_id: +$('#csFilm').value, venue_id: +$('#csVenue').value, start_time: $('#csStart').value };
  if ($('#csCap').value) body.capacity = +$('#csCap').value;
  const r = await api('/api/admin/sessions', { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 409 && r.data.error === 'VENUE_CONFLICT') {
    return toast('场地冲突：' + r.data.conflicts.map(c => c.public_code).join('、'));
  }
  if (handle(r, '场次已创建 ' + (r.data.session || {}).public_code)) loadSessions();
};

/* 场次操作面板 */
$('#sessionTable').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = +b.dataset.id, v = +b.dataset.v, act = b.dataset.act;
  const s = A.sessions.find(x => x.id === id);
  const box = $('#opPanel');
  if (act === 'reschedule') {
    box.innerHTML = `<div class="opbox"><h4>改期 · ${esc(s.public_code)}（同一活动，身份不变）</h4>
      <div class="form">
        <label>新时间</label><input type="datetime-local" id="rsTime">
        <label>旧票政策</label>
        <select id="rsPolicy">
          <option value="migrate">migrate 自动迁移到新场次</option>
          <option value="rebook">rebook 转待重订，释放座位</option>
        </select>
        <input id="rsNote" placeholder="备注（可选）" style="width:200px">
        <button class="btn primary" id="rsGo">提交改期</button>
        <button class="btn ghost" id="opClose">收起</button>
      </div>
      <p class="dim small">提交后场次进入「冻结报名」，通知发出后请手动解冻。不会重新生成活动，原预约不失联。</p></div>`;
    $('#opClose').onclick = () => box.innerHTML = '';
    $('#rsGo').onclick = async () => {
      const r = await api(`/api/admin/sessions/${id}/reschedule`, { method: 'POST', body: JSON.stringify({
        new_start_time: $('#rsTime').value, ticket_policy: $('#rsPolicy').value,
        note: $('#rsNote').value, expected_version: v }) });
      if (r.status === 409 && r.data.error === 'VENUE_CONFLICT') return toast('新时间与 ' + r.data.conflicts.map(c => c.public_code).join('、') + ' 冲突');
      if (handle(r, '已改期，场次冻结中')) { box.innerHTML = ''; loadSessions(); }
    };
  } else if (act === 'capacity') {
    box.innerHTML = `<div class="opbox"><h4>调整容量 · ${esc(s.public_code)}（当前 ${s.capacity}，场地上限 ${s.venue.capacity}）</h4>
      <div class="form">
        <label>新容量</label><input type="number" id="capN" min="0" max="${s.venue.capacity}" value="${s.capacity}" style="width:100px">
        <button class="btn primary" id="capGo">提交</button>
        <button class="btn ghost" id="opClose">收起</button>
      </div>
      <p class="dim small">缩减时按确认顺序保留先确认者，溢出观众列入待处置名单（不随机撤销）。</p>
      <div id="capResult"></div></div>`;
    $('#opClose').onclick = () => box.innerHTML = '';
    $('#capGo').onclick = async () => {
      const r = await api(`/api/admin/sessions/${id}/capacity`, { method: 'POST', body: JSON.stringify({ new_capacity: +$('#capN').value, expected_version: v }) });
      if (!handle(r)) return;
      const d = r.data;
      $('#capResult').innerHTML = d.displaced.length
        ? `<div class="msg bad">需处置 ${d.displaced.length} 人（按确认顺序溢出）：<ul>${d.displaced.map(x => `<li>#${x.confirm_seq} ${esc(x.user)} · 座位 ${esc(x.seat)}</li>`).join('')}</ul>已生成 seat_displaced 通知任务。</div>`
        : '<div class="msg ok">容量已调整，无人受影响。</div>';
      loadSessions();
    };
  } else if (act === 'freeze') {
    const r = await api(`/api/admin/sessions/${id}/freeze`, { method: 'POST', body: JSON.stringify({ frozen: !+b.dataset.f, expected_version: v }) });
    if (handle(r, +b.dataset.f ? '已解冻，恢复报名' : '已冻结，暂停新报名')) loadSessions();
  } else if (act === 'cancel') {
    if (!confirm(`确认取消 ${s.public_code}？已确认观众将收到取消通知。`)) return;
    const r = await api(`/api/admin/sessions/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'manual', expected_version: v }) });
    if (handle(r, '场次已取消')) loadSessions();
  } else if (act === 'people') {
    const r = await api(`/api/admin/sessions/${id}/reservations`);
    const rows = r.data.reservations.map(x => `<tr><td class="mono">#${x.confirm_seq}</td><td>${esc(x.user_name)}</td>
      <td class="mono">${esc(x.seat_label)}</td><td><span class="tag">${x.state}</span></td><td class="mono dim">${fmtT(x.created_at)}</td></tr>`).join('');
    const holds = r.data.holds.map(h => `<tr><td class="mono">H${h.id}</td><td>${esc(h.user_name)}</td>
      <td class="mono">${esc(h.seat_label)}</td><td><span class="tag">${h.state}</span></td><td class="mono dim">${fmtT(h.expires_at)} 止</td></tr>`).join('');
    box.innerHTML = `<div class="opbox"><h4>预约名单 · ${esc(s.public_code)}（按确认顺序）</h4>
      <table class="tbl"><thead><tr><th>确认序</th><th>观众</th><th>座位</th><th>状态</th><th>时间</th></tr></thead><tbody>${rows || '<tr><td colspan=5 class=dim>暂无</td></tr>'}</tbody></table>
      <h4>占位记录</h4>
      <table class="tbl"><thead><tr><th>占位</th><th>观众</th><th>座位</th><th>状态</th><th>过期</th></tr></thead><tbody>${holds || '<tr><td colspan=5 class=dim>暂无</td></tr>'}</tbody></table>
      <button class="btn ghost" id="opClose">收起</button></div>`;
    $('#opClose').onclick = () => box.innerHTML = '';
  }
});

/* ---------- 片单 / 场地 ---------- */
async function loadFilms() {
  const { data } = await api('/api/films'); A.films = data.films || [];
  $('#filmTable').innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>片名</th><th>时长</th><th>简介</th><th>主题色</th></tr></thead><tbody>${
    A.films.map(f => `<tr><td class="mono">${f.id}</td><td>${esc(f.title)}</td><td class="mono">${f.duration_min}′</td>
      <td class="dim">${esc(f.synopsis)}</td><td><span class="tag" style="border-color:${esc(f.palette)};color:${esc(f.palette)}">${esc(f.palette)}</span></td></tr>`).join('')}</tbody></table>`;
  loadBase();
}
$('#fBtn').onclick = async () => {
  const r = await api('/api/admin/films', { method: 'POST', body: JSON.stringify({
    title: $('#fTitle').value, duration_min: +$('#fDur').value, synopsis: $('#fSyn').value, palette: $('#fPalette').value }) });
  if (handle(r, '影片已添加')) loadFilms();
};
async function loadVenues() {
  const { data } = await api('/api/venues'); A.venues = data.venues || [];
  $('#venueTable').innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>名称</th><th>位置</th><th>规格</th><th>容量</th></tr></thead><tbody>${
    A.venues.map(v => `<tr><td class="mono">${v.id}</td><td>${esc(v.name)}</td><td class="dim">${esc(v.location)}</td>
      <td class="mono">${v.rows}排×${v.cols}列</td><td class="mono">${v.capacity}</td></tr>`).join('')}</tbody></table>`;
  loadBase();
}
$('#vBtn').onclick = async () => {
  const r = await api('/api/admin/venues', { method: 'POST', body: JSON.stringify({
    name: $('#vName').value, location: $('#vLoc').value, rows: +$('#vRows').value, cols: +$('#vCols').value }) });
  if (handle(r, '场地已添加')) loadVenues();
};

/* ---------- 天气预案 ---------- */
function renderWxSessionOptions() {
  $('#wxSession').innerHTML = A.sessions.filter(s => s.status !== 'cancelled')
    .map(s => `<option value="${s.id}">${esc(s.public_code)} · ${esc(s.film.title)}</option>`).join('');
}
$('#wxBtn').onclick = async () => {
  const r = await api('/api/weather/ingest', { method: 'POST', body: JSON.stringify({
    session_id: +$('#wxSession').value, observed_at: $('#wxObserved').value, risk: $('#wxRisk').value, source: 'admin-sim' }) });
  const p = r.data.plan;
  $('#wxMsg').innerHTML = p
    ? `<div class="msg ${p.state === 'pending' ? '' : 'bad'}">预案 #${p.id} 状态 <b>${p.state}</b>${r.data.reason ? '（' + r.data.reason + '）' : ''} — 公开状态未改变，待运营确认。</div>`
    : `<div class="msg ok">${esc(r.data.reason || '无风险，未生成预案')}</div>`;
  loadPlans(); loadSessions();
};
async function loadPlans() {
  const { data } = await api('/api/admin/weather-plans');
  A.plans = data.plans || [];
  $('#planTable').innerHTML = `<table class="tbl"><thead><tr>
    <th>#</th><th>场次</th><th>观测时间</th><th>风险</th><th>建议</th><th>状态</th><th>决定</th><th>操作</th></tr></thead><tbody>${
    A.plans.map(p => `<tr>
      <td class="mono">${p.id}</td><td class="mono">${esc(p.session_code)}</td>
      <td class="mono">${esc(p.observed_at)}</td><td>${esc(p.risk)}</td><td>${esc(p.proposal)}</td>
      <td><span class="tag">${p.state}</span></td>
      <td class="dim small">${p.decided_by ? esc(p.decided_by) + ' · ' + fmtT(p.decided_at) : '—'}</td>
      <td class="ops">${p.state === 'pending' ? `
        <button data-decide="cancel" data-id="${p.id}">确认取消场次</button>
        <button data-decide="postpone" data-id="${p.id}">确认顺延2h</button>
        <button data-decide="reject" data-id="${p.id}">驳回</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}
$('#planTable').addEventListener('click', async e => {
  const b = e.target.closest('button[data-decide]'); if (!b) return;
  const act = b.dataset.decide;
  const body = act === 'reject' ? { decision: 'reject', operator: 'admin' }
    : { decision: 'confirm', action: act, postpone_hours: 2, operator: 'admin' };
  const r = await api(`/api/admin/weather-plans/${b.dataset.id}/decide`, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 409 && r.data.error === 'VENUE_CONFLICT') return toast('顺延目标时间与他场冲突');
  if (handle(r, '预案已处理')) { loadPlans(); loadSessions(); }
});

/* ---------- 通知中心 ---------- */
async function loadNotify() {
  const [n, m] = await Promise.all([api('/api/admin/notifications'), api('/api/admin/mock-channel')]);
  const list = n.data.notifications || [];
  const pending = list.filter(x => x.state === 'pending').length;
  $('#notifyStats').textContent = `待发送 ${pending} · 已发送 ${list.filter(x => x.state === 'sent').length} · 渠道回执 ${(m.data.messages || []).length} 条`;
  $('#notifTable').innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>类型</th><th>收件人</th><th>内容</th><th>状态</th><th>时间</th></tr></thead><tbody>${
    list.map(x => `<tr><td class="mono">${x.id}</td><td><span class="tag">${esc(x.kind)}</span></td>
      <td>${esc(x.recipient)}</td><td class="dim small mono">${esc(x.payload)}</td>
      <td><span class="tag">${x.state}</span></td><td class="mono dim small">${esc(x.sent_at || x.created_at)}</td></tr>`).join('')}</tbody></table>`;
  $('#mockList').innerHTML = (m.data.messages || []).slice().reverse()
    .map(x => `<div class="msg ok mono small">→ ${esc(x.recipient)} [${esc(x.kind)}] ${esc(JSON.stringify(x.payload))} <span class="dim">${esc(x.sent_at)}</span></div>`).join('')
    || '<p class="dim">渠道暂无消息</p>';
}
$('#drainBtn').onclick = async () => {
  const r = await api('/api/admin/notifications/drain', { method: 'POST', body: '{}' });
  toast(`已投递 ${r.data.sent} 条到本地模拟渠道`);
  loadNotify();
};

/* ---------- 审计 ---------- */
async function loadAudit() {
  const { data } = await api('/api/admin/audit');
  $('#auditTable').innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>实体</th><th>动作</th><th>明细</th><th>时间</th></tr></thead><tbody>${
    (data.audit || []).map(x => `<tr><td class="mono">${x.id}</td><td class="mono">${esc(x.entity)}#${esc(x.entity_id)}</td>
      <td><span class="tag">${esc(x.action)}</span></td><td class="dim small mono">${esc(x.detail)}</td>
      <td class="mono dim small">${esc(x.created_at)}</td></tr>`).join('')}</tbody></table>`;
}

loadBase().then(loadSessions);
