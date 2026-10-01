/* 运营后台逻辑：所有写操作携带 version 做乐观并发；列表刷新经 VersionGuard 防旧响应覆盖 */
const guard = VersionGuard.createGuard();
let screenings = [];
let current = null; // 当前操作的场次详情

Api.token = localStorage.getItem('admin_token') || 'dev-admin-token';
document.getElementById('adm-token').value = Api.token;
document.getElementById('btn-token').addEventListener('click', () => {
  Api.token = document.getElementById('adm-token').value.trim();
  localStorage.setItem('admin_token', Api.token);
  toast('令牌已保存');
  refreshAll();
});

/* 标签页切换 */
document.querySelectorAll('.tabs')[0].addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  document.querySelectorAll('.tabs')[0].querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  ['screenings', 'catalog', 'weather', 'notify', 'mock'].forEach(t => {
    document.getElementById('tab-' + t).hidden = t !== b.dataset.tab;
  });
  refreshAll();
});
document.querySelector('#panel-ops .tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-op]');
  if (!b) return;
  document.querySelectorAll('#panel-ops .tabs button').forEach(x => x.classList.toggle('on', x === b));
  ['reschedule', 'capacity', 'cancel', 'tickets'].forEach(t => {
    document.getElementById('op-' + t).hidden = t !== b.dataset.op;
  });
});

const statusName = { scheduled: '排期中', cancelled: '已取消', weather_cancelled: '天气取消', completed: '已完结' };

async function refreshScreenings() {
  const token = guard.begin();
  const data = await Api.get('/api/screenings');
  if (!guard.accept(token)) return;
  screenings = data.items;
  const tbl = document.getElementById('tbl-screenings');
  tbl.innerHTML = `<tr><th>场次</th><th>影片/场地</th><th>时间</th><th>状态</th><th>售票</th><th>占用</th><th>版本</th><th></th></tr>` +
    screenings.map(s => `<tr>
      <td class="mono">${esc(s.id)}${s.flags.rescheduled ? ' <span class="tag amber">改期×</span>'.replace('×', '') : ''}</td>
      <td>${esc(s.film.title)}<br><span class="dim">${esc(s.venue.name)}</span></td>
      <td class="mono">${esc(s.starts_at.slice(5, 16).replace('T', ' '))}</td>
      <td><span class="tag ${s.status === 'scheduled' ? 'green' : 'red'}">${statusName[s.status]}</span>
          ${s.pending_plan ? '<span class="tag amber">预案待决</span>' : ''}</td>
      <td>${s.sale_state === 'open' ? '开放' : s.sale_state === 'paused' ? '暂停' : '关闭'}</td>
      <td class="mono">${s.taken}/${s.capacity}${s.flags.full ? ' 满' : ''}</td>
      <td class="mono">v${s.version}</td>
      <td><button class="btn small ghost" onclick="openOps('${esc(s.id)}')">管理</button></td>
    </tr>`).join('');
}

window.openOps = async (id) => {
  current = await Api.get(`/api/admin/screenings/${encodeURIComponent(id)}`, true).catch(e => ({ error: e }));
  if (current.error) {
    // GET 走公共详情 + 版本
    const d = await Api.get(`/api/screenings/${encodeURIComponent(id)}`);
    current = { ...d, tickets: [], active_holds: [], plans: [] };
  }
  document.getElementById('panel-ops').hidden = false;
  document.getElementById('ops-id').textContent = id;
  document.getElementById('ops-ver').textContent = `v${current.version}`;
  renderTickets();
  document.getElementById('panel-ops').scrollIntoView({ behavior: 'smooth' });
};

function renderTickets() {
  const tbl = document.getElementById('tbl-tickets');
  const rows = (current.tickets || []).map(t => `<tr>
    <td class="mono">#${t.confirm_seq}</td><td class="mono">${esc(t.id)}</td>
    <td>${esc(t.attendee_name)}</td><td class="mono">${esc(t.contact || '')}</td>
    <td><span class="tag ${t.status === 'confirmed' ? 'green' : t.status === 'displaced' ? 'amber' : 'red'}">${t.status}</span></td>
    <td class="mono">${esc(t.confirmed_at || '')}</td></tr>`).join('');
  const holds = (current.active_holds || []).map(h => `<tr>
    <td class="mono">—</td><td class="mono">${esc(h.id)}</td><td>${esc(h.attendee_name)}</td>
    <td class="mono">${esc(h.contact || '')}</td><td><span class="tag amber">占位中</span></td>
    <td class="mono">至 ${esc(h.expires_at.slice(11, 19))}</td></tr>`).join('');
  tbl.innerHTML = `<tr><th>确认序</th><th>单号</th><th>观众</th><th>联系</th><th>状态</th><th>时间</th></tr>${rows}${holds}` ||
    '<tr><td class="dim">暂无</td></tr>';
}

/* 新建场次 */
async function fillSelects() {
  const [films, venues] = await Promise.all([
    Api.get('/api/admin/films', true).catch(() => ({ items: [] })),
    Api.get('/api/admin/venues', true).catch(() => ({ items: [] })),
  ]);
  const opts = (items, fn) => items.map(i => `<option value="${i.id}">${esc(fn(i))}</option>`).join('');
  document.getElementById('ns-film').innerHTML = opts(films.items, f => `${f.title}（${f.duration_min}′）`);
  document.getElementById('ns-venue').innerHTML = opts(venues.items, v => `${v.name}（容 ${v.capacity}）`);
  document.getElementById('w-venue').innerHTML = opts(venues.items, v => v.name);
  document.getElementById('catalog-list').innerHTML =
    `<p class="mono" style="font-size:.8rem">影片：${films.items.map(f => esc(f.title)).join('、') || '—'}</p>
     <p class="mono" style="font-size:.8rem;margin-top:.4rem">场地：${venues.items.map(v => `${esc(v.name)}(${v.rows}×${v.cols})`).join('、') || '—'}</p>`;
}

document.getElementById('btn-ns').addEventListener('click', async () => {
  const msg = document.getElementById('ns-msg');
  try {
    const r = await Api.post('/api/admin/screenings', {
      film_id: Number(document.getElementById('ns-film').value),
      venue_id: Number(document.getElementById('ns-venue').value),
      starts_at: document.getElementById('ns-starts').value.trim(),
      ends_at: document.getElementById('ns-ends').value.trim(),
    }, true);
    msg.textContent = `已创建 ${r.id}`;
    refreshScreenings();
  } catch (e) { msg.textContent = `失败：${e.message}`; }
});

/* 改期 */
document.getElementById('btn-reschedule').addEventListener('click', async () => {
  const msg = document.getElementById('rs-msg');
  try {
    const r = await Api.post(`/api/admin/screenings/${current.id}/reschedule`, {
      starts_at: document.getElementById('rs-starts').value.trim(),
      ends_at: document.getElementById('rs-ends').value.trim(),
      reason: document.getElementById('rs-reason').value.trim(),
      ticket_policy: document.getElementById('rs-policy').value,
      version: current.version,
    }, true);
    msg.textContent = `已生成第 ${r.rev_no} 版排期：迁移 ${r.migrated} / 待确认 ${r.pending} / 作废 ${r.voided}`;
    toast('改期完成，活动身份不变');
    await openOps(current.id);
    refreshScreenings();
  } catch (e) {
    msg.textContent = `失败：${e.message}`;
    if (e.code === 'VERSION_CONFLICT') { toast('版本冲突，已刷新最新数据', true); await openOps(current.id); }
  }
});

/* 容量调整 */
document.getElementById('btn-capacity').addEventListener('click', async () => {
  const box = document.getElementById('cap-result');
  try {
    const r = await Api.post(`/api/admin/screenings/${current.id}/capacity`, {
      capacity: Number(document.getElementById('cap-value').value), version: current.version,
    }, true);
    const list = r.displaced.length
      ? `<p class="notice">需处置人群（按确认顺序，先到者已保留）：</p><table class="data">
         <tr><th>确认序</th><th>票号</th><th>观众</th><th>联系</th></tr>
         ${r.displaced.map(t => `<tr><td class="mono">#${t.confirm_seq}</td><td class="mono">${esc(t.id)}</td><td>${esc(t.attendee_name)}</td><td class="mono">${esc(t.contact || '')}</td></tr>`).join('')}</table>`
      : '<p class="dim">无受影响观众。</p>';
    const restored = r.restored.length ? `<p class="dim">已按顺序恢复 ${r.restored.length} 张 displaced 票。</p>` : '';
    box.innerHTML = list + restored;
    await openOps(current.id);
    refreshScreenings();
  } catch (e) {
    box.innerHTML = `<p class="notice">${esc(e.message)}</p>`;
    if (e.code === 'VERSION_CONFLICT') await openOps(current.id);
  }
});

/* 取消 */
document.getElementById('btn-cancel').addEventListener('click', async () => {
  if (!confirm('确认取消该场次？所有票将作废并生成通知。')) return;
  try {
    await Api.post(`/api/admin/screenings/${current.id}/cancel`, {
      reason: document.getElementById('cancel-reason').value.trim() || 'manual', version: current.version,
    }, true);
    toast('场次已取消');
    await openOps(current.id);
    refreshScreenings();
  } catch (e) { toast(e.message, true); }
});

/* 片单与场地 */
document.getElementById('btn-film').addEventListener('click', async () => {
  try {
    await Api.post('/api/admin/films', {
      title: document.getElementById('f-title').value.trim(),
      director: document.getElementById('f-director').value.trim(),
      duration_min: Number(document.getElementById('f-duration').value),
    }, true);
    toast('影片已添加'); fillSelects();
  } catch (e) { toast(e.message, true); }
});
document.getElementById('btn-venue').addEventListener('click', async () => {
  try {
    await Api.post('/api/admin/venues', {
      name: document.getElementById('v-name').value.trim(),
      rows: Number(document.getElementById('v-rows').value),
      cols: Number(document.getElementById('v-cols').value),
    }, true);
    toast('场地已添加'); fillSelects();
  } catch (e) { toast(e.message, true); }
});

/* 天气 */
document.getElementById('btn-weather').addEventListener('click', async () => {
  const msg = document.getElementById('w-msg');
  try {
    const r = await Api.post('/api/admin/weather/observations', {
      venue_id: Number(document.getElementById('w-venue').value),
      observed_at: document.getElementById('w-at').value.trim(),
      condition: document.getElementById('w-cond').value,
      precipitation_mm: Number(document.getElementById('w-rain').value),
      wind_kph: Number(document.getElementById('w-wind').value),
    }, true);
    msg.textContent = r.severe ? `恶劣天气，影响事件 ${r.events.length} 条` : '天气良好，未触发预案';
    refreshWeather(); refreshScreenings();
  } catch (e) { msg.textContent = `失败：${e.message}`; }
});

async function refreshWeather() {
  const data = await Api.get('/api/admin/contingencies', true).catch(() => ({ items: [], events: [] }));
  const pending = data.items.filter(p => p.status === 'pending_decision');
  document.getElementById('plan-count').textContent = pending.length ? `(${pending.length})` : '';
  document.getElementById('tbl-plans').innerHTML = `<tr><th>#</th><th>场次</th><th>触发天气</th><th>状态</th><th>操作</th></tr>` +
    (data.items.map(p => `<tr>
      <td class="mono">${p.id}</td>
      <td>${esc(p.film_title)} @ ${esc(p.venue_name)}<br><span class="mono dim">${esc(p.screening_id)} ${esc((p.starts_at || '').slice(5, 16))}</span></td>
      <td class="mono">${esc(p.condition || '')} ${p.precipitation_mm || 0}mm ${p.wind_kph || 0}km/h<br><span class="dim">${esc(p.observed_at || '')}</span></td>
      <td><span class="tag ${p.status === 'pending_decision' ? 'amber' : p.status === 'approved' ? 'red' : 'green'}">${{ pending_decision: '待决定', approved: '已批准', rejected: '已驳回' }[p.status]}</span></td>
      <td>${p.status === 'pending_decision'
        ? `<button class="btn small danger" onclick="decide(${p.id}, 'approve')">批准取消场次</button>
           <button class="btn small ghost" onclick="decide(${p.id}, 'reject')">驳回</button>`
        : `<span class="dim mono">${esc(p.decided_by || '')} ${esc((p.decided_at || '').slice(5, 16))}</span>`}</td>
    </tr>`).join('') || '<tr><td class="dim">暂无预案</td></tr>');
  document.getElementById('tbl-wevents').innerHTML = `<tr><th>时间</th><th>场次</th><th>动作</th><th>说明</th></tr>` +
    (data.events.map(e => `<tr><td class="mono">${esc((e.created_at || '').slice(5, 16))}</td>
      <td class="mono">${esc(e.screening_id || '—')}</td><td><span class="tag">${esc(e.action)}</span></td>
      <td class="dim">${esc(e.detail || '')}</td></tr>`).join('') || '<tr><td class="dim">暂无事件</td></tr>');
}

window.decide = async (planId, decision) => {
  try {
    await Api.post(`/api/admin/contingencies/${planId}/decide`, { decision, note: decision === 'approve' ? '运营确认执行' : '观察后认为可放映' }, true);
    toast(decision === 'approve' ? '已批准：场次公开状态已改变' : '已驳回：场次状态不变');
    refreshWeather(); refreshScreenings();
  } catch (e) { toast(e.message, true); }
};

/* 通知中心 */
async function refreshNotify() {
  const data = await Api.get('/api/admin/notifications', true).catch(() => ({ items: [], counts: [] }));
  const pending = (data.counts.find(c => c.status === 'pending') || {}).c || 0;
  document.getElementById('task-count').textContent = pending ? `(${pending})` : '';
  document.getElementById('tbl-tasks').innerHTML = `<tr><th>#</th><th>类型</th><th>收件人</th><th>内容</th><th>状态</th></tr>` +
    (data.items.slice(0, 60).map(t => {
      const p = JSON.parse(t.payload || '{}');
      return `<tr><td class="mono">${t.id}</td><td><span class="tag">${esc(t.kind)}</span></td>
        <td class="mono">${esc(t.recipient)}</td>
        <td style="max-width:340px">${esc(p.subject || '')}<br><span class="dim">${esc(p.body || '')}</span></td>
        <td><span class="tag ${t.status === 'delivered' ? 'green' : t.status === 'pending' ? 'amber' : ''}">${t.status}</span></td></tr>`;
    }).join('') || '<tr><td class="dim">暂无任务</td></tr>');
}
document.getElementById('btn-dispatch').addEventListener('click', async () => {
  try {
    const r = await Api.post('/api/admin/notifications/dispatch', {}, true);
    document.getElementById('disp-msg').textContent = `已派发 ${r.dispatched.length} 条`;
    refreshNotify(); refreshMock();
  } catch (e) { toast(e.message, true); }
});

/* 模拟渠道 */
async function refreshMock() {
  const data = await Api.get('/api/admin/mock-outbox', true).catch(() => ({ items: [], receipts: [] }));
  document.getElementById('tbl-outbox').innerHTML = `<tr><th>消息</th><th>收件人</th><th>内容</th><th>任务状态</th><th>回执</th></tr>` +
    (data.items.map(m => `<tr>
      <td class="mono">${esc(m.message_id)}</td><td class="mono">${esc(m.recipient)}</td>
      <td style="max-width:300px">${esc(m.subject)}<br><span class="dim">${esc(m.body)}</span></td>
      <td><span class="tag ${m.task_status === 'delivered' ? 'green' : 'amber'}">${m.task_status}</span></td>
      <td><button class="btn small ghost" onclick="sendReceipt('${esc(m.message_id)}')">回执</button></td>
    </tr>`).join('') || '<tr><td class="dim">发件箱为空（先到通知中心派发）</td></tr>');
  document.getElementById('tbl-receipts').innerHTML = `<tr><th>#</th><th>任务</th><th>回执令牌</th><th>状态</th><th>时间</th></tr>` +
    (data.receipts.map(r => `<tr><td class="mono">${r.id}</td><td class="mono">${r.task_id}</td>
      <td class="mono">${esc(r.receipt_token)}</td><td>${esc(r.status)}</td><td class="mono dim">${esc(r.created_at)}</td></tr>`).join('')
      || '<tr><td class="dim">暂无回执</td></tr>');
}
window.sendReceipt = async (messageId) => {
  try {
    const r = await Api.post('/api/mock-channel/receipt', { message_id: messageId, status: 'delivered' });
    toast(r.duplicate ? '重复回执：已幂等忽略' : '回执已登记');
    refreshMockAndNotify();
  } catch (e) { toast(e.message, true); }
};
function refreshMockAndNotify() { refreshMock(); refreshNotify(); }

function refreshAll() { refreshScreenings(); fillSelects(); refreshWeather(); refreshNotify(); refreshMock(); }
refreshAll();
setInterval(() => { refreshScreenings(); refreshWeather(); refreshNotify(); }, 15000);
