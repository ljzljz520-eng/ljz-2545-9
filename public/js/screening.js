/* 场次详情：座位图 -> 占位(倒计时) -> 确认出票；查票；改期待确认票的接受/拒绝 */
const guard = VersionGuard.createGuard();
const sid = new URLSearchParams(location.search).get('id');
let detail = null;
let pickedSeat = null;
let currentHold = null;
let timer = null;

async function refresh() {
  const token = guard.begin();
  try {
    const d = await Api.get(`/api/screenings/${encodeURIComponent(sid)}`);
    if (!guard.accept(token)) return; // 丢弃旧响应，防止覆盖新状态
    detail = d;
    renderDetail();
    renderSeats();
  } catch (e) {
    document.getElementById('detail').innerHTML = `<p class="notice">${esc(e.message)}</p>`;
  }
}

function renderDetail() {
  const d = detail;
  const statusTag = d.status === 'scheduled'
    ? (d.sale_state === 'open' ? '<span class="tag green">售票中</span>' : '<span class="tag amber">改期处理中·暂停售票</span>')
    : `<span class="tag red">${d.status === 'weather_cancelled' ? '因天气取消' : '已取消'}</span>`;
  const revNote = d.revisions.length > 1
    ? `<p class="notice">本场次改期过 ${d.revisions.length - 1} 次（活动身份不变，原票仍关联本场）。当前为第 ${d.rev_no} 版排期。</p>` : '';
  document.getElementById('detail').innerHTML = `
    <h1 style="font-family:var(--serif);letter-spacing:.06em">${esc(d.film.title)}</h1>
    <p class="mono dim">${esc(d.starts_at.slice(0, 16).replace('T', ' '))} — ${esc(d.ends_at.slice(11, 16))} · ${esc(d.venue.name)} · ${d.film.duration_min}′</p>
    <p style="margin:.5rem 0">${statusTag} <span class="tag">余票 ${d.seats_available}/${d.capacity}</span> <span class="tag">v${d.version}</span></p>
    ${revNote}
    <p class="dim" style="font-size:.85rem">${esc(d.film.synopsis || '')}</p>`;
}

function renderSeats() {
  const map = document.getElementById('seatmap');
  const rows = {};
  for (const s of detail.seats) (rows[s.row] = rows[s.row] || []).push(s);
  map.innerHTML = Object.entries(rows).map(([r, seats]) =>
    `<div class="seatrow"><span class="rlabel">${esc(r)}</span>${seats.map(s => {
      const cls = s.state === 'available' ? '' : s.state;
      const picked = pickedSeat === s.id ? ' picked' : '';
      const disabled = s.state !== 'available' || detail.status !== 'scheduled' || detail.sale_state !== 'open';
      return `<button class="seat ${cls}${picked}" data-id="${s.id}" ${disabled ? 'disabled' : ''}>${s.col}</button>`;
    }).join('')}</div>`).join('');
}

document.getElementById('seatmap').addEventListener('click', (e) => {
  const b = e.target.closest('.seat');
  if (!b || b.disabled) return;
  pickedSeat = Number(b.dataset.id);
  renderSeats();
  const seat = detail.seats.find(s => s.id === pickedSeat);
  document.getElementById('hold-seat').textContent = `${seat.row}${seat.col}`;
  document.getElementById('hold-panel').hidden = false;
  document.getElementById('hold-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.getElementById('btn-hold').addEventListener('click', async () => {
  const name = document.getElementById('f-name').value.trim();
  const contact = document.getElementById('f-contact').value.trim();
  if (!name) return toast('请填写姓名', true);
  try {
    const { hold, ttl_seconds } = await Api.post(`/api/screenings/${encodeURIComponent(sid)}/holds`, {
      seat_id: pickedSeat, attendee_name: name, contact,
    });
    currentHold = hold;
    document.getElementById('hold-panel').hidden = true;
    document.getElementById('confirm-panel').hidden = false;
    document.getElementById('hold-id').textContent = hold.id;
    startCountdown(hold.expires_at);
    toast(`已占位 ${ttl_seconds / 60} 分钟，请及时确认`);
    refresh();
  } catch (e) {
    toast(e.message, true);
    refresh(); // 座位被抢/满额：刷新座位图
  }
});

function startCountdown(expiresAt) {
  clearInterval(timer);
  const el = document.getElementById('countdown');
  const tick = () => {
    const left = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    if (left <= 0) {
      clearInterval(timer);
      document.getElementById('confirm-panel').hidden = true;
      toast('占位已超时释放', true);
      currentHold = null;
      refresh();
    }
  };
  tick();
  timer = setInterval(tick, 1000);
}

document.getElementById('btn-confirm').addEventListener('click', async () => {
  if (!currentHold) return;
  try {
    const { ticket } = await Api.post(`/api/holds/${encodeURIComponent(currentHold.id)}/confirm`);
    clearInterval(timer);
    document.getElementById('confirm-panel').hidden = true;
    showTicket(ticket.id);
    currentHold = null;
    refresh();
  } catch (e) { toast(e.message, true); refresh(); }
});

document.getElementById('btn-release').addEventListener('click', async () => {
  if (!currentHold) return;
  try { await Api.del(`/api/holds/${encodeURIComponent(currentHold.id)}`); } catch {}
  clearInterval(timer);
  document.getElementById('confirm-panel').hidden = true;
  currentHold = null;
  toast('已放弃占位');
  refresh();
});

function ticketHtml(t) {
  const mig = t.status === 'migrate_pending'
    ? `<p class="notice">本场次已改期至 <b>${esc(t.current_starts_at.slice(0, 16).replace('T', ' '))}</b>，请确认是否迁移：</p>
       <div style="display:flex;gap:.6rem">
         <button class="btn small" onclick="answerMigration('${esc(t.id)}', true)">接受新时间</button>
         <button class="btn small danger" onclick="answerMigration('${esc(t.id)}', false)">拒绝并退票</button>
       </div>` : '';
  const statusMap = { confirmed: '有效', migrate_pending: '待确认迁移', displaced: '待处置（容量调整）', cancelled: '已取消' };
  return `<div class="mono" style="font-size:.9rem;line-height:2">
      票号 <span class="tag amber">${esc(t.id)}</span> 状态 <span class="tag ${t.status === 'confirmed' ? 'green' : 'red'}">${statusMap[t.status] || t.status}</span><br>
      ${esc(t.film_title)} · ${esc(t.venue_name)} · 座位 <b>${esc(t.seat_label)}</b><br>
      放映时间（当前排期）<b>${esc(t.current_starts_at.slice(0, 16).replace('T', ' '))}</b>
      ${t.screening_rev_count > 1 ? `<span class="tag amber">已改期·第${t.screening_rev_count}版</span>` : ''}
      ${t.screening_status !== 'scheduled' ? `<span class="tag red">场次${t.screening_status}</span>` : ''}
    </div>${mig}`;
}

async function showTicket(id) {
  const t = await Api.get(`/api/tickets/${encodeURIComponent(id)}`);
  document.getElementById('ticket-panel').hidden = false;
  document.getElementById('ticket-view').innerHTML = ticketHtml(t);
  document.getElementById('ticket-panel').scrollIntoView({ behavior: 'smooth' });
}

window.answerMigration = async (ticketId, accept) => {
  try {
    await Api.post(`/api/tickets/${encodeURIComponent(ticketId)}/migration`, { accept });
    toast(accept ? '已接受新时间' : '已退票');
    showTicket(ticketId);
    refresh();
  } catch (e) { toast(e.message, true); }
};

document.getElementById('btn-lookup').addEventListener('click', async () => {
  const id = document.getElementById('f-ticket').value.trim();
  if (!id) return;
  try {
    const t = await Api.get(`/api/tickets/${encodeURIComponent(id)}`);
    document.getElementById('lookup-view').innerHTML = ticketHtml(t);
  } catch (e) {
    document.getElementById('lookup-view').innerHTML = `<p class="notice">${esc(e.message)}</p>`;
  }
});

refresh();
setInterval(refresh, 12000);
