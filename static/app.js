/* 星空放映厅 · 前台
 * 旧响应不覆盖新状态：每次请求带单调序号，响应乱序返回时丢弃旧者；
 * 每个场次再按 version 比较，低版本数据不渲染。 */
const $ = s => document.querySelector(s);
const clientKey = (() => {
  let k = localStorage.getItem('cinema_key');
  if (!k) { k = 'ck-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('cinema_key', k); }
  return k;
})();
const store = { sessions: new Map(), seq: 0 };
const modal = { sid: null, seq: 0, version: 0, hold: null, selected: null, timer: null, poll: null };

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = n => String(n).padStart(2, '0');
const fmtTime = iso => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const fmtFull = iso => { const d = new Date(iso); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

let toastTimer = null;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function errText(r) {
  const m = {
    SEAT_TAKEN: '手慢了，该座位刚被锁定', BOOKING_FROZEN: '改期处理中，暂停新报名',
    SESSION_CANCELLED: '场次已取消', HOLD_EXPIRED: '占位已超时，请重新选座',
    SEAT_OUT_OF_CAPACITY: '该座位不在本场开放容量内', HOLD_NOT_ACTIVE: '占位已失效',
    STALE_VERSION: '页面数据已过期，正在刷新'
  };
  return m[r.data && r.data.error] || ('操作失败：' + ((r.data && (r.data.detail || r.data.error)) || r.status));
}

/* ---------- 列表（带版本守卫） ---------- */
async function loadSessions() {
  const seq = ++store.seq;
  const { data } = await api('/api/sessions');
  if (seq !== store.seq) return;              // 旧响应：丢弃
  for (const s of (data.sessions || [])) {
    const old = store.sessions.get(s.id);
    if (old && old.version > s.version) continue; // 低版本：不覆盖
    store.sessions.set(s.id, s);
  }
  renderList();
}
function badgeHtml(s) {
  const b = [];
  if (s.display_status === 'cancelled') b.push('<span class="stamp st-cancel">已取消</span>');
  if (s.rescheduled) b.push(`<span class="stamp st-move">改期 ×${s.reschedule_count}</span>`);
  if (s.display_status === 'full') b.push('<span class="stamp st-full">满额</span>');
  if (s.display_status === 'frozen') b.push('<span class="stamp st-freeze">改期处理中 · 暂停报名</span>');
  if (s.pending_weather_plan) b.push('<span class="stamp st-wx">天气预案待决</span>');
  if (!b.length && s.display_status === 'open') b.push('<span class="stamp st-open">售票中</span>');
  return b.join('');
}
function cardHtml(s) {
  const pct = s.capacity ? Math.min(100, Math.round(100 * s.confirmed / s.capacity)) : 0;
  const canBook = s.display_status === 'open';
  const btnText = canBook ? '选座购票' : (s.display_status === 'full' ? '已满额' : s.display_status === 'cancelled' ? '已取消' : '暂停报名');
  return `<article class="card" style="--acc:${esc(s.film.palette)}">
    <div class="card-top">
      <div>
        <div class="card-code mono">${esc(s.public_code)}</div>
        <h3>${esc(s.film.title)}</h3>
        <div class="card-sub">${esc(s.venue.name)} · ${s.film.duration_min}′ · ${esc(s.film.rating)}</div>
      </div>
      <div class="card-time"><b>${fmtTime(s.start_time)}</b>${s.rescheduled ? `<i>原 ${fmtTime(s.original_start_time)}</i>` : ''}</div>
    </div>
    <div class="badges">${badgeHtml(s)}</div>
    <div class="meter"><span style="width:${pct}%"></span></div>
    <div class="card-foot">
      <span class="mono">${s.confirmed}/${s.capacity} 已确认 · 余 ${s.seats_left}</span>
      <button class="btn" ${canBook ? '' : 'disabled'} data-open="${s.id}">${btnText}</button>
    </div>
  </article>`;
}
function renderList() {
  const arr = [...store.sessions.values()].sort((a, b) => a.start_time < b.start_time ? -1 : 1);
  $('#sessionList').innerHTML = arr.map(cardHtml).join('') || '<p class="dim">暂无场次</p>';
  $('#heroStats').textContent = `${arr.length} 场放映 · ${arr.reduce((n, s) => n + s.capacity, 0)} 个座位 · ${arr.filter(s => s.display_status === 'open').length} 场售票中`;
  $('#syncInfo').textContent = '同步于 ' + new Date().toLocaleTimeString();
}

/* ---------- 选座弹窗 ---------- */
async function openSession(id) {
  modal.sid = id; modal.hold = null; modal.selected = null; modal.version = 0;
  $('#modal').hidden = false;
  await refreshModal();
  clearInterval(modal.poll);
  modal.poll = setInterval(refreshModal, 3000);
}
function closeModal() {
  $('#modal').hidden = true;
  clearInterval(modal.poll); clearInterval(modal.timer);
  modal.sid = null;
}
async function refreshModal() {
  if (!modal.sid) return;
  const seq = ++modal.seq;
  const key = modal.hold ? modal.hold.idempotency_key : '';
  const { data } = await api(`/api/sessions/${modal.sid}?key=${encodeURIComponent(key)}`);
  if (seq !== modal.seq) return;             // 乱序响应：丢弃
  if (data.version < modal.version) return;  // 低版本：不覆盖
  modal.version = data.version;
  renderModal(data);
}
function renderModal(d) {
  const seats = (d.seats || []).map(s => {
    const cls = ['seat', s.state];
    if (modal.selected === s.label && s.state === 'free') cls.push('sel');
    if (s.mine) cls.push('mine');
    return `<button class="${cls.join(' ')}" data-seat="${s.label}" ${s.state !== 'free' ? 'disabled' : ''}>${s.label}</button>`;
  }).join('');
  $('#modalBody').innerHTML = `
    <div class="m-head">
      <div>
        <div class="mono dim">${esc(d.public_code)} · v${d.version}</div>
        <h3>${esc(d.film.title)}</h3>
        <div class="dim small">${fmtFull(d.start_time)} · ${esc(d.venue.name)} · 余 ${d.seats_left} 座</div>
      </div>
      <div class="badges">${badgeHtml(d)}</div>
    </div>
    <div class="screen">银 幕</div>
    <div class="seatmap" style="grid-template-columns:repeat(${d.venue.cols},1fr)">${seats}</div>
    <div class="legend">
      <span><i class="seat free"></i>可选</span><span><i class="seat mine"></i>我的占位</span>
      <span><i class="seat held"></i>被锁定</span><span><i class="seat taken"></i>已售</span>
      <span><i class="seat na"></i>未开放</span>
    </div>
    <div class="m-actions" id="mActions"></div>
    <div id="mReceipt"></div>`;
  renderActions(d);
}
function renderActions(d) {
  const el = $('#mActions');
  if (modal.hold && modal.hold.state === 'active') {
    el.innerHTML = `<div class="holdbar">
      <span>已锁定 <b>${esc(modal.hold.seat_label)}</b>，请在 <b class="mono" id="cd">--</b> 内确认，超时自动释放</span>
      <span><button class="btn primary" id="btnConfirm">确认购票</button><button class="btn ghost" id="btnRelease">放弃</button></span>
    </div>`;
    $('#btnConfirm').onclick = doConfirm;
    $('#btnRelease').onclick = doRelease;
    tickCd();
  } else if (d.display_status === 'open') {
    el.innerHTML = `<div class="bookbar">
        <input id="mUser" placeholder="您的称呼（用于取票）" maxlength="20">
        <button class="btn primary" id="btnHold">锁定座位</button>
      </div>
      <p class="dim small" style="margin-top:8px">选座后席位为您保留 120 秒；改期冻结 / 取消 / 满额场次不可报名。</p>`;
    $('#btnHold').onclick = doHold;
  } else {
    el.innerHTML = '<p class="dim">当前状态不可报名。</p>';
  }
}
async function doHold() {
  const user = $('#mUser').value.trim();
  if (!user) return toast('请填写称呼');
  if (!modal.selected) return toast('请先选择座位');
  const sid = modal.sid, seat = modal.selected;
  let key = `${clientKey}:${sid}:${seat}`;
  let r = await api(`/api/sessions/${sid}/holds`, { method: 'POST', body: JSON.stringify({ seat, user, idempotency_key: key, ttl_seconds: 120 }) });
  if (r.status === 200 && r.data.hold && r.data.hold.state !== 'active') {
    key += ':r' + (Date.now() % 100000); // 旧占位已过期/释放：换新键重试一次
    r = await api(`/api/sessions/${sid}/holds`, { method: 'POST', body: JSON.stringify({ seat, user, idempotency_key: key, ttl_seconds: 120 }) });
  }
  if ((r.status === 201 || r.status === 200) && r.data.hold && r.data.hold.state === 'active') {
    modal.hold = r.data.hold;
    toast('已锁定 ' + seat + '，请尽快确认');
  } else {
    toast(errText(r));
  }
  refreshModal(); loadSessions();
}
async function doConfirm() {
  if (!modal.hold) return;
  const r = await api('/api/holds/confirm', { method: 'POST', body: JSON.stringify({ idempotency_key: modal.hold.idempotency_key }) });
  if (r.status === 201 || r.status === 200) {
    showReceipt(r.data.reservation);
    modal.hold = null;
    toast('购票成功');
  } else {
    toast(errText(r));
  }
  refreshModal(); loadSessions();
}
async function doRelease() {
  if (!modal.hold) return;
  await api('/api/holds/release', { method: 'POST', body: JSON.stringify({ idempotency_key: modal.hold.idempotency_key }) });
  modal.hold = null;
  refreshModal(); loadSessions();
}
function tickCd() {
  clearInterval(modal.timer);
  modal.timer = setInterval(() => {
    if (!modal.hold) return;
    const el = $('#cd'); if (!el) return;
    const left = new Date(modal.hold.expires_at) - Date.now();
    if (left <= 0) {
      clearInterval(modal.timer);
      modal.hold = null;
      toast('占位已超时释放');
      refreshModal(); loadSessions();
      return;
    }
    el.textContent = Math.ceil(left / 1000) + 's';
  }, 300);
}
function showReceipt(r) {
  $('#mReceipt').innerHTML = `<div class="receipt">
    <div class="r-main">
      <div class="mono dim small">取票码 · 重复提交同一回执不会产生第二张票</div>
      <div class="r-code mono">R-${String(r.id).padStart(4, '0')}</div>
      <div>${esc(r.user_name)} · 座位 <b>${esc(r.seat_label)}</b> · 确认序号 #${r.confirm_seq}</div>
    </div>
    <div class="r-stub">已确认<br>CONFIRMED</div>
  </div>`;
}

/* ---------- 事件 ---------- */
document.addEventListener('click', e => {
  const t = e.target;
  if (t.dataset && t.dataset.open) openSession(+t.dataset.open);
  if (t.dataset && t.dataset.seat && t.classList.contains('free')) {
    modal.selected = t.dataset.seat;
    document.querySelectorAll('.seat.sel').forEach(x => x.classList.remove('sel'));
    t.classList.add('sel');
  }
});
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

loadSessions();
setInterval(loadSessions, 5000);
