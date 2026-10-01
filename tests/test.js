'use strict';
/**
 * 验收测试（node --test）：内存 SQLite + 真实 HTTP 服务
 * 覆盖：最后席位竞争（双策略）、预案取消后迟到更新、场地冲突、重复回执、
 *       改期身份不失联、容量缩减顺序、预留超时、改期中报名约束、版本防覆盖、通知中心
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { fmtLocal } = require('../src/util');
const { createGuard } = require('../public/js/guard.js');

const ADMIN = 'test-token';
const iso = (hoursFromNow) => fmtLocal(new Date(Date.now() + hoursFromNow * 3600e3));

function startApp(opts = {}) {
  const app = createApp({ dbPath: ':memory:', strategy: opts.strategy || 'atomic', adminToken: ADMIN, sweepIntervalMs: 1e9 });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve({ app, base: `http://127.0.0.1:${app.server.address().port}` });
    });
  });
}
async function stopApp({ app }) {
  app.server.closeAllConnections?.();
  await new Promise(r => app.server.close(r));
  app.close();
}
async function api(base, method, path, body, { admin = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-token': ADMIN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function mkScreening(base, { rows = 2, cols = 5, capacity, startH = 24, durH = 2 } = {}) {
  const f = await api(base, 'POST', '/api/admin/films', { title: '测试片', duration_min: 100 }, { admin: true });
  const v = await api(base, 'POST', '/api/admin/venues', { name: '测试场', rows, cols, ...(capacity !== undefined ? { capacity } : {}) }, { admin: true });
  const s = await api(base, 'POST', '/api/admin/screenings', {
    film_id: f.data.id, venue_id: v.data.id, starts_at: iso(startH), ends_at: iso(startH + durH),
    ...(capacity !== undefined ? { capacity } : {}),
  }, { admin: true });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return { filmId: f.data.id, venueId: v.data.id, screeningId: s.data.id };
}
async function bookOne(base, screeningId, seatId, name = '观众') {
  const h = await api(base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: seatId, attendee_name: name, contact: `${name}@t.cn` });
  if (h.status !== 200) return h;
  const c = await api(base, 'POST', `/api/holds/${h.data.hold.id}/confirm`);
  return { status: c.status, data: c.data, hold: h.data.hold };
}

/* ============ 1. 最后席位竞争（两种策略各跑一轮） ============ */
for (const strategy of ['atomic', 'screening_lock']) {
  test(`最后席位竞争[${strategy}]：8 并发抢同一座位，恰好 1 成功`, async (t) => {
    const ctx = await startApp({ strategy });
    try {
      const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 1, capacity: 8 }); // 容量充足，只有 1 个座位
      const seatId = ctx.app.db.prepare('SELECT id FROM seats LIMIT 1').get().id;
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: seatId, attendee_name: `竞争${i}` })));
      const ok = results.filter(r => r.status === 200);
      const taken = results.filter(r => r.status === 409);
      assert.equal(ok.length, 1, '恰好一人成功');
      assert.equal(taken.length, 7, '其余全部 409');
      assert.equal(ctx.app.db.prepare(`SELECT COUNT(*) c FROM seat_occupancy WHERE screening_id=?`).get(screeningId).c, 1);
      assert.equal(ctx.app.db.prepare(`SELECT taken_count FROM screenings WHERE id=?`).get(screeningId).taken_count, 1);
    } finally { await stopApp(ctx); }
  });

  test(`容量原子计数[${strategy}]：容量 1 的场次 8 并发抢不同座位，仅 1 成功`, async (t) => {
    const ctx = await startApp({ strategy });
    try {
      const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 2, capacity: 1 });
      const seats = ctx.app.db.prepare('SELECT id FROM seats ORDER BY id').all();
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: seats[i % 2].id, attendee_name: `并发${i}` })));
      assert.equal(results.filter(r => r.status === 200).length, 1, '容量 1 仅 1 单成功');
      const failures = results.filter(r => r.status === 409);
      assert.equal(failures.length, 7);
      if (strategy === 'atomic') {
        // 原子策略：容量计数器先拒绝，全部报满额
        assert.ok(failures.every(r => r.data.error.code === 'SCREENING_FULL'));
      } else {
        // 全场次锁：先查座位后查容量，同座请求报 SEAT_TAKEN，其余报满额
        assert.ok(failures.every(r => ['SEAT_TAKEN', 'SCREENING_FULL'].includes(r.data.error.code)));
      }
      assert.equal(ctx.app.db.prepare('SELECT taken_count FROM screenings WHERE id=?').get(screeningId).taken_count, 1);
    } finally { await stopApp(ctx); }
  });
}

/* ============ 2. 占位确认与预留超时 ============ */
test('占位→确认出票；占位超时后自动回收且过期确认被拒', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 2 });
    const [s1, s2] = ctx.app.db.prepare('SELECT id FROM seats ORDER BY id').all().map(r => r.id);

    const h = await api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: s1, attendee_name: '甲' });
    assert.equal(h.status, 200);
    const c = await api(ctx.base, 'POST', `/api/holds/${h.data.hold.id}/confirm`);
    assert.equal(c.status, 200);
    assert.equal(c.data.ticket.status, 'confirmed');
    assert.equal(ctx.app.db.prepare(`SELECT occupant_type FROM seat_occupancy WHERE screening_id=? AND seat_id=?`).get(screeningId, s1).occupant_type, 'ticket');

    // 占位后手动改到期时间 => 超时
    const h2 = await api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: s2, attendee_name: '乙' });
    assert.equal(h2.status, 200);
    ctx.app.db.prepare(`UPDATE seat_holds SET expires_at='2000-01-01T00:00:00' WHERE id=?`).run(h2.data.hold.id);
    const late = await api(ctx.base, 'POST', `/api/holds/${h2.data.hold.id}/confirm`);
    assert.equal(late.status, 409);
    assert.equal(late.data.error.code, 'HOLD_EXPIRED');
    // 座位已被清扫回收，可重新占位
    const h3 = await api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: s2, attendee_name: '丙' });
    assert.equal(h3.status, 200, '超时席位应被回收');
    assert.equal(ctx.app.db.prepare('SELECT taken_count FROM screenings WHERE id=?').get(screeningId).taken_count, 2);
  } finally { await stopApp(ctx); }
});

/* ============ 3. 改期：同一活动身份，三种政策 ============ */
test('改期是同一活动的新安排：票不失联，政策分别处理', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 4 });
    const seats = ctx.app.db.prepare('SELECT id FROM seats ORDER BY id').all().map(r => r.id);
    const t1 = await bookOne(ctx.base, screeningId, seats[0], '迁移甲');
    const t2 = await bookOne(ctx.base, screeningId, seats[1], '迁移乙');
    assert.equal(t1.status, 200);

    const detail = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    const newStart = iso(48), newEnd = iso(50);
    const r = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/reschedule`,
      { starts_at: newStart, ends_at: newEnd, reason: '设备检修', ticket_policy: 'migrate_all', version: detail.data.version }, { admin: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.migrated, 2);

    // 票仍指向同一活动，查票返回新时间
    const v1 = await api(ctx.base, 'GET', `/api/tickets/${t1.data.ticket.id}`);
    assert.equal(v1.data.screening_id, screeningId);
    assert.equal(v1.data.current_starts_at, newStart);
    assert.equal(v1.data.screening_rev_count, 2);

    // opt_in：票转待确认，观众接受后才算数
    const r2 = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/reschedule`,
      { starts_at: iso(72), ends_at: iso(74), reason: '再改', ticket_policy: 'opt_in', version: detail.data.version + 1 }, { admin: true });
    assert.equal(r2.data.pending, 2);
    const pend = await api(ctx.base, 'GET', `/api/tickets/${t2.data.ticket.id}`);
    assert.equal(pend.data.status, 'migrate_pending');
    const acc = await api(ctx.base, 'POST', `/api/tickets/${t2.data.ticket.id}/migration`, { accept: true });
    assert.equal(acc.data.ticket.status, 'confirmed');
    const dec = await api(ctx.base, 'POST', `/api/tickets/${t1.data.ticket.id}/migration`, { accept: false });
    assert.equal(dec.data.ticket.status, 'cancelled');

    // void_all：全部作废并释放席位
    const t3 = await bookOne(ctx.base, screeningId, seats[2], '迁移丙');
    const d3 = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    const r3 = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/reschedule`,
      { starts_at: iso(96), ends_at: iso(98), reason: '大变', ticket_policy: 'void_all', version: d3.data.version }, { admin: true });
    assert.equal(r3.data.voided, 2); // t2(confirmed) + t3
    const after = ctx.app.db.prepare('SELECT taken_count FROM screenings WHERE id=?').get(screeningId);
    assert.equal(after.taken_count, 0, '作废后席位全部释放');
    // 通知任务以幂等键生成
    const tasks = ctx.app.db.prepare(`SELECT COUNT(*) c FROM notification_tasks WHERE kind='reschedule_notice'`).get();
    assert.ok(tasks.c >= 5);
  } finally { await stopApp(ctx); }
});

test('改期过程（暂停售票）期间新报名被拒', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 2 });
    const seatId = ctx.app.db.prepare('SELECT id FROM seats LIMIT 1').get().id;
    await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/sale-state`, { sale_state: 'paused' }, { admin: true });
    const r = await api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: seatId, attendee_name: '拦' });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'SALE_PAUSED');
    await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/sale-state`, { sale_state: 'open' }, { admin: true });
    const r2 = await api(ctx.base, 'POST', `/api/screenings/${screeningId}/holds`, { seat_id: seatId, attendee_name: '放' });
    assert.equal(r2.status, 200);
  } finally { await stopApp(ctx); }
});

/* ============ 4. 容量缩减：保留确认顺序，列出需处置人群 ============ */
test('缩减容量按 confirm_seq 保留先到者，处置名单有序；扩容按序恢复', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 5, capacity: 5 });
    const seats = ctx.app.db.prepare('SELECT id FROM seats ORDER BY id').all().map(r => r.id);
    const tickets = [];
    for (let i = 0; i < 5; i++) tickets.push((await bookOne(ctx.base, screeningId, seats[i], `观众${i + 1}`)).data.ticket);

    let d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    const cut = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/capacity`,
      { capacity: 2, version: d.data.version }, { admin: true });
    assert.equal(cut.status, 200);
    assert.deepEqual(cut.data.displaced.map(t => t.confirm_seq), [3, 4, 5], '处置名单按确认顺序');
    const kept = ctx.app.db.prepare(`SELECT confirm_seq FROM tickets WHERE screening_id=? AND status='confirmed' ORDER BY confirm_seq`).all(screeningId);
    assert.deepEqual(kept.map(r => r.confirm_seq), [1, 2], '先到者保留，不随机撤销');
    assert.equal(ctx.app.db.prepare('SELECT taken_count FROM screenings WHERE id=?').get(screeningId).taken_count, 2);
    // 处置通知已生成
    assert.equal(ctx.app.db.prepare(`SELECT COUNT(*) c FROM notification_tasks WHERE kind='displacement_notice'`).get().c, 3);

    // 扩容恢复：原座位空闲，#3 #4 按序回来
    d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    const up = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/capacity`,
      { capacity: 4, version: d.data.version }, { admin: true });
    assert.deepEqual(up.data.restored.map(t => t.confirm_seq), [3, 4]);
    assert.equal(ctx.app.db.prepare('SELECT taken_count FROM screenings WHERE id=?').get(screeningId).taken_count, 4);
  } finally { await stopApp(ctx); }
});

/* ============ 5. 场地冲突 ============ */
test('场地冲突：创建与改期均拦截，背对背场次允许', async () => {
  const ctx = await startApp();
  try {
    const f = await api(ctx.base, 'POST', '/api/admin/films', { title: '片', duration_min: 100 }, { admin: true });
    const v1 = await api(ctx.base, 'POST', '/api/admin/venues', { name: '甲场', rows: 1, cols: 2 }, { admin: true });
    const v2 = await api(ctx.base, 'POST', '/api/admin/venues', { name: '乙场', rows: 1, cols: 2 }, { admin: true });
    const mk = (venue, a, b) => api(ctx.base, 'POST', '/api/admin/screenings',
      { film_id: f.data.id, venue_id: venue, starts_at: iso(a), ends_at: iso(b) }, { admin: true });

    const A = await mk(v1.data.id, 24, 26);
    assert.equal(A.status, 200);
    const clash = await mk(v1.data.id, 25, 27); // 重叠
    assert.equal(clash.status, 409);
    assert.equal(clash.data.error.code, 'VENUE_CONFLICT');
    const other = await mk(v2.data.id, 25, 27); // 不同场地
    assert.equal(other.status, 200);
    const backToBack = await mk(v1.data.id, 26, 28); // 紧接不重叠
    assert.equal(backToBack.status, 200, '背对背场次应允许');

    // 改期撞场同样拦截
    const d = await api(ctx.base, 'GET', `/api/screenings/${backToBack.data.id}`);
    const rs = await api(ctx.base, 'POST', `/api/admin/screenings/${backToBack.data.id}/reschedule`,
      { starts_at: iso(25), ends_at: iso(27), ticket_policy: 'migrate_all', version: d.data.version }, { admin: true });
    assert.equal(rs.status, 409);
    assert.equal(rs.data.error.code, 'VENUE_CONFLICT');
  } finally { await stopApp(ctx); }
});

/* ============ 6. 天气预案：只触发待决定；迟到更新不翻盘 ============ */
test('天气数据只生成待决定预案，运营确认才改变公开状态；迟到观测被忽略', async () => {
  const ctx = await startApp();
  try {
    // 场次：1 小时后开场（观测窗口 = 开场前3h ~ 散场）
    const { screeningId, venueId } = await mkScreening(ctx.base, { rows: 1, cols: 2, startH: 1, durH: 2 });
    const obs = (at, cond = 'storm', rain = 20) => api(ctx.base, 'POST', '/api/admin/weather/observations',
      { venue_id: venueId, observed_at: at, condition: cond, precipitation_mm: rain }, { admin: true });

    // 恶劣天气 => 预案 pending，但公开状态不变
    const o1 = await obs(iso(-0.5));
    assert.equal(o1.data.severe, true);
    let d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    assert.equal(d.data.status, 'scheduled', '未经运营确认，公开状态不变');
    let plans = await api(ctx.base, 'GET', '/api/admin/contingencies?status=pending_decision', undefined, { admin: true });
    assert.equal(plans.data.items.length, 1);

    // 运营批准 => 公开状态才改变
    const planId = plans.data.items[0].id;
    const dec = await api(ctx.base, 'POST', `/api/admin/contingencies/${planId}/decide`, { decision: 'approve', note: '确认取消' }, { admin: true });
    assert.equal(dec.data.plan.status, 'approved');
    d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    assert.equal(d.data.status, 'weather_cancelled');

    // 迟到更新：观测时间早于决定时间 => 被忽略，状态不翻盘
    await obs(iso(-0.2));
    d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    assert.equal(d.data.status, 'weather_cancelled', '迟到观测不改变已决定的公开状态');
    const ev = ctx.app.db.prepare(`SELECT action FROM weather_events WHERE screening_id=? ORDER BY id`).all(screeningId);
    assert.ok(ev.some(e => e.action === 'ignored_terminal'), '审计记录迟到观测被忽略');

    // 场景 B：预案被驳回后，陈旧观测不生成新预案；更新的观测才生成
    const s2 = await mkScreening(ctx.base, { rows: 1, cols: 2, startH: 1, durH: 2 });
    await api(ctx.base, 'POST', '/api/admin/weather/observations',
      { venue_id: s2.venueId, observed_at: iso(-0.5), condition: 'storm', precipitation_mm: 30 }, { admin: true });
    let p2 = await api(ctx.base, 'GET', '/api/admin/contingencies?status=pending_decision', undefined, { admin: true });
    const plan2 = p2.data.items.find(p => p.screening_id === s2.screeningId);
    await api(ctx.base, 'POST', `/api/admin/contingencies/${plan2.id}/decide`, { decision: 'reject', note: '云团已过境' }, { admin: true });
    await api(ctx.base, 'POST', '/api/admin/weather/observations',
      { venue_id: s2.venueId, observed_at: iso(-0.1), condition: 'storm', precipitation_mm: 40 }, { admin: true }); // 观测时间 < 驳回时间
    let d2 = await api(ctx.base, 'GET', `/api/screenings/${s2.screeningId}`);
    assert.equal(d2.data.status, 'scheduled');
    const ev2 = ctx.app.db.prepare(`SELECT action FROM weather_events WHERE screening_id=?`).all(s2.screeningId);
    assert.ok(ev2.some(e => e.action === 'ignored_stale'), '陈旧观测被忽略');
    const cnt = ctx.app.db.prepare(`SELECT COUNT(*) c FROM contingency_plans WHERE screening_id=?`).get(s2.screeningId).c;
    assert.equal(cnt, 1, '陈旧观测不生成新预案');
  } finally { await stopApp(ctx); }
});

/* ============ 7. 通知中心 + 重复回执幂等 ============ */
test('通知任务幂等创建，本地模拟渠道派发，重复回执只登记一次', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 2 });
    const seatId = ctx.app.db.prepare('SELECT id FROM seats LIMIT 1').get().id;
    await bookOne(ctx.base, screeningId, seatId, '通知对象');
    const d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/cancel`, { reason: 'manual', version: d.data.version }, { admin: true });
    // 重复取消不产生重复任务
    await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/cancel`, { reason: 'manual', version: 999 }, { admin: true });
    assert.equal(ctx.app.db.prepare(`SELECT COUNT(*) c FROM notification_tasks WHERE kind='cancel_notice'`).get().c, 1);

    let pend = await api(ctx.base, 'GET', '/api/admin/notifications?status=pending', undefined, { admin: true });
    assert.equal(pend.data.items.length, 1);
    const disp = await api(ctx.base, 'POST', '/api/admin/notifications/dispatch', {}, { admin: true });
    assert.equal(disp.data.dispatched.length, 1);
    const msgId = disp.data.dispatched[0].message_id;

    const r1 = await api(ctx.base, 'POST', '/api/mock-channel/receipt', { message_id: msgId, status: 'delivered' });
    assert.equal(r1.data.duplicate, false);
    const r2 = await api(ctx.base, 'POST', '/api/mock-channel/receipt', { message_id: msgId, status: 'delivered' });
    assert.equal(r2.data.duplicate, true, '重复回执幂等');
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) c FROM notification_receipts').get().c, 1);
    const task = ctx.app.db.prepare('SELECT status FROM notification_tasks WHERE id=?').get(r1.data.task_id);
    assert.equal(task.status, 'delivered');
  } finally { await stopApp(ctx); }
});

/* ============ 8. 乐观锁版本 + 前端守卫 ============ */
test('服务端乐观锁：旧版本写入被 409 拒绝', async () => {
  const ctx = await startApp();
  try {
    const { screeningId } = await mkScreening(ctx.base, { rows: 1, cols: 2 });
    const d = await api(ctx.base, 'GET', `/api/screenings/${screeningId}`);
    const stale = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/reschedule`,
      { starts_at: iso(48), ends_at: iso(50), ticket_policy: 'migrate_all', version: d.data.version + 99 }, { admin: true });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.data.error.details.current_version, d.data.version);
    const ok = await api(ctx.base, 'POST', `/api/admin/screenings/${screeningId}/reschedule`,
      { starts_at: iso(48), ends_at: iso(50), ticket_policy: 'migrate_all', version: d.data.version }, { admin: true });
    assert.equal(ok.status, 200);
  } finally { await stopApp(ctx); }
});

test('VersionGuard：乱序到达的旧响应不覆盖新状态', () => {
  const g = createGuard();
  const t1 = g.begin(), t2 = g.begin(), t3 = g.begin();
  assert.equal(g.accept(t2), true);   // 较新的响应先应用
  assert.equal(g.accept(t1), false);  // 旧响应随后到达 => 丢弃
  assert.equal(g.accept(t3), true);   // 更新的仍可应用
  assert.equal(g.accept(t2), false);  // 重复到达 => 丢弃
  assert.equal(g.acceptRow('SC-1', 5), true);
  assert.equal(g.acceptRow('SC-1', 4), false, '行级版本不回退');
  assert.equal(g.acceptRow('SC-1', 6), true);
});

/* ============ 9. 列表直接显示 改期/取消/满额 ============ */
test('列表接口直接给出 rescheduled / cancelled / full 标志', async () => {
  const ctx = await startApp();
  try {
    const f = await api(ctx.base, 'POST', '/api/admin/films', { title: '片', duration_min: 90 }, { admin: true });
    const v = await api(ctx.base, 'POST', '/api/admin/venues', { name: '场', rows: 1, cols: 2 }, { admin: true });
    const mk = (a, b, cap) => api(ctx.base, 'POST', '/api/admin/screenings',
      { film_id: f.data.id, venue_id: v.data.id, starts_at: iso(a), ends_at: iso(b), ...(cap ? { capacity: cap } : {}) }, { admin: true });
    const s1 = await mk(24, 26);                 // 将改期
    const s2 = await mk(30, 32);                 // 将取消
    const s3 = await mk(36, 38, 1);              // 将满额

    let d = await api(ctx.base, 'GET', `/api/screenings/${s1.data.id}`);
    await api(ctx.base, 'POST', `/api/admin/screenings/${s1.data.id}/reschedule`,
      { starts_at: iso(48), ends_at: iso(50), ticket_policy: 'migrate_all', version: d.data.version }, { admin: true });
    d = await api(ctx.base, 'GET', `/api/screenings/${s2.data.id}`);
    await api(ctx.base, 'POST', `/api/admin/screenings/${s2.data.id}/cancel`, { version: d.data.version }, { admin: true });
    const seatId = ctx.app.db.prepare('SELECT id FROM seats LIMIT 1').get().id;
    await bookOne(ctx.base, s3.data.id, seatId, '满');

    const list = await api(ctx.base, 'GET', '/api/screenings');
    const byId = Object.fromEntries(list.data.items.map(i => [i.id, i]));
    assert.equal(byId[s1.data.id].flags.rescheduled, true);
    assert.ok(byId[s1.data.id].original_starts_at, '改期场次带原时间');
    assert.equal(byId[s2.data.id].flags.cancelled, true);
    assert.equal(byId[s3.data.id].flags.full, true);
    assert.equal(byId[s3.data.id].seats_available, 0);
  } finally { await stopApp(ctx); }
});
