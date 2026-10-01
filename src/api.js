'use strict';
/** HTTP API 层：公共接口 + 管理接口（x-admin-token 简单鉴权）+ 模拟天气/回执通道 */
const { requireFields, requireTime, badRequest, notFound, conflict, nowStr, uid } = require('./util');

function registerRoutes(router, { db, tx, nextNo, svc, adminToken }) {
  const adminOnly = (req) => {
    if ((req.headers['x-admin-token'] || '') !== adminToken) {
      const e = new Error('需要管理员令牌'); e.status = 401; e.code = 'UNAUTHORIZED'; throw e;
    }
  };
  const P = (pattern, fn) => router.add('POST', pattern, fn);
  const G = (pattern, fn) => router.add('GET', pattern, fn);
  const D = (pattern, fn) => router.add('DELETE', pattern, fn);

  /* ---------- 公共 ---------- */
  G('/api/screenings', () => ({ server_time: nowStr(), strategy: svc.strategy, items: svc.listScreenings() }));
  G('/api/screenings/:id', ({ params }) => svc.screeningDetail(params.id));
  G('/api/tickets/:id', ({ params }) => svc.ticketView(params.id));

  P('/api/screenings/:id/holds', ({ params, body }) => {
    const hold = svc.holdSeat(params.id, body);
    return { hold, ttl_seconds: Number(process.env.HOLD_TTL_SECONDS || 300) };
  });
  P('/api/holds/:id/confirm', ({ params }) => ({ ticket: svc.confirmHold(params.id) }));
  D('/api/holds/:id', ({ params }) => ({ hold: svc.releaseHold(params.id) }));
  P('/api/tickets/:id/migration', ({ params, body }) => {
    if (typeof body.accept !== 'boolean') throw badRequest('accept 须为布尔值');
    return { ticket: svc.answerMigration(params.id, body.accept) };
  });

  /* ---------- 管理：片单 / 场地 ---------- */
  G('/api/admin/films', ({ req }) => { adminOnly(req); return { items: db.prepare('SELECT * FROM films ORDER BY id').all() }; });
  P('/api/admin/films', ({ req, body }) => {
    adminOnly(req);
    requireFields(body, ['title', 'duration_min']);
    const id = db.prepare('INSERT INTO films(title, director, year, duration_min, synopsis, tone, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(body.title, body.director || '', body.year || null, body.duration_min, body.synopsis || '', body.tone || 'amber', nowStr()).lastInsertRowid;
    return { id: Number(id) };
  });
  G('/api/admin/venues', ({ req }) => { adminOnly(req); return { items: db.prepare('SELECT * FROM venues ORDER BY id').all() }; });
  P('/api/admin/venues', ({ req, body }) => {
    adminOnly(req);
    requireFields(body, ['name', 'rows', 'cols']);
    return tx(() => {
      const rows = Number(body.rows), cols = Number(body.cols);
      const capacity = body.capacity !== undefined ? Number(body.capacity) : rows * cols;
      const id = db.prepare('INSERT INTO venues(name, capacity, rows, cols, note, created_at) VALUES(?,?,?,?,?,?)')
        .run(body.name, capacity, rows, cols, body.note || '', nowStr()).lastInsertRowid;
      const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const ins = db.prepare('INSERT INTO seats(venue_id, row_label, col_no) VALUES(?,?,?)');
      for (let r = 0; r < rows; r++) for (let c = 1; c <= cols; c++) ins.run(Number(id), labels[r], c);
      return { id: Number(id), seats: rows * cols };
    });
  });

  /* ---------- 管理：场次 ---------- */
  G('/api/admin/screenings/:id', ({ req, params }) => {
    adminOnly(req);
    const detail = svc.screeningDetail(params.id);
    const tickets = db.prepare('SELECT * FROM tickets WHERE screening_id=? ORDER BY confirm_seq').all(params.id);
    const holds = db.prepare(`SELECT * FROM seat_holds WHERE screening_id=? AND status='active'`).all(params.id);
    const plans = db.prepare('SELECT * FROM contingency_plans WHERE screening_id=? ORDER BY id DESC').all(params.id);
    return { ...detail, tickets, active_holds: holds, plans };
  });
  P('/api/admin/screenings', ({ req, body }) => {
    adminOnly(req);
    requireFields(body, ['film_id', 'venue_id', 'starts_at', 'ends_at']);
    const starts = requireTime(body.starts_at, 'starts_at');
    const ends = requireTime(body.ends_at, 'ends_at');
    if (ends <= starts) throw badRequest('ends_at 必须晚于 starts_at');
    return tx(() => {
      const venue = db.prepare('SELECT * FROM venues WHERE id=?').get(body.venue_id);
      if (!venue) throw notFound('场地不存在');
      if (!db.prepare('SELECT 1 FROM films WHERE id=?').get(body.film_id)) throw notFound('影片不存在');
      const clash = svc.venueConflict(body.venue_id, starts, ends, null);
      if (clash) throw conflict('VENUE_CONFLICT', `与场次 ${clash.id}（${clash.starts_at}~${clash.ends_at}）场地冲突`, clash);
      const id = `SC-${String(nextNo('screening')).padStart(4, '0')}`;
      const now = nowStr();
      const capacity = body.capacity !== undefined ? Number(body.capacity) : venue.capacity;
      db.prepare(`INSERT INTO screenings(id, film_id, venue_id, status, sale_state, capacity, taken_count, seq_counter, version, created_at, updated_at)
                  VALUES(?,?,?, 'scheduled', 'open', ?, 0, 0, 1, ?, ?)`)
        .run(id, body.film_id, body.venue_id, capacity, now, now);
      const revId = db.prepare(`INSERT INTO schedule_revisions(screening_id, rev_no, starts_at, ends_at, reason, ticket_policy, created_by, created_at)
                                VALUES(?, 1, ?, ?, ?, NULL, 'admin', ?)`)
        .run(id, starts, ends, body.reason || '初始排期', now).lastInsertRowid;
      db.prepare('UPDATE screenings SET current_revision_id=? WHERE id=?').run(revId, id);
      return { id, revision_id: Number(revId) };
    });
  });
  P('/api/admin/screenings/:id/reschedule', ({ req, params, body }) => {
    adminOnly(req);
    requireFields(body, ['starts_at', 'ends_at', 'ticket_policy']);
    return svc.reschedule(params.id, {
      starts_at: requireTime(body.starts_at, 'starts_at'), ends_at: requireTime(body.ends_at, 'ends_at'),
      reason: body.reason, ticket_policy: body.ticket_policy, version: body.version,
    });
  });
  P('/api/admin/screenings/:id/capacity', ({ req, params, body }) => {
    adminOnly(req);
    return svc.setCapacity(params.id, { capacity: body.capacity, version: body.version });
  });
  P('/api/admin/screenings/:id/cancel', ({ req, params, body }) => {
    adminOnly(req);
    return svc.cancelScreening(params.id, { reason: body.reason || 'manual', version: body.version });
  });
  P('/api/admin/screenings/:id/sale-state', ({ req, params, body }) => {
    adminOnly(req);
    if (!['open', 'paused', 'closed'].includes(body.sale_state)) throw badRequest('sale_state 非法');
    db.prepare('UPDATE screenings SET sale_state=?, updated_at=? WHERE id=?').run(body.sale_state, nowStr(), params.id);
    return { ok: true };
  });

  /* ---------- 管理：天气预案 ---------- */
  P('/api/admin/weather/observations', ({ req, body }) => {
    adminOnly(req);
    requireFields(body, ['venue_id', 'observed_at', 'condition']);
    return svc.ingestObservation({
      venue_id: Number(body.venue_id), observed_at: requireTime(body.observed_at, 'observed_at'),
      condition: body.condition, precipitation_mm: Number(body.precipitation_mm || 0), wind_kph: Number(body.wind_kph || 0),
    });
  });
  G('/api/admin/contingencies', ({ req, query }) => {
    adminOnly(req);
    const where = query.status ? 'WHERE p.status = ?' : '';
    const args = query.status ? [query.status] : [];
    return {
      items: db.prepare(
        `SELECT p.*, s.id AS screening_id, f.title AS film_title, v.name AS venue_name,
                r.starts_at, o.condition, o.precipitation_mm, o.wind_kph, o.observed_at
         FROM contingency_plans p
         JOIN screenings s ON s.id = p.screening_id
         JOIN films f ON f.id = s.film_id
         JOIN venues v ON v.id = s.venue_id
         JOIN schedule_revisions r ON r.id = s.current_revision_id
         LEFT JOIN weather_observations o ON o.id = p.trigger_observation_id
         ${where} ORDER BY p.id DESC`).all(...args),
      events: db.prepare('SELECT * FROM weather_events ORDER BY id DESC LIMIT 50').all(),
    };
  });
  P('/api/admin/contingencies/:id/decide', ({ req, params, body }) => {
    adminOnly(req);
    if (!['approve', 'reject'].includes(body.decision)) throw badRequest('decision 须为 approve|reject');
    return { plan: svc.decidePlan(Number(params.id), body) };
  });

  /* ---------- 管理：通知中心 + 模拟渠道 ---------- */
  G('/api/admin/notifications', ({ req, query }) => {
    adminOnly(req);
    const where = query.status ? 'WHERE status = ?' : '';
    const args = query.status ? [query.status] : [];
    return {
      items: db.prepare(`SELECT * FROM notification_tasks ${where} ORDER BY id DESC LIMIT 200`).all(...args),
      counts: db.prepare('SELECT status, COUNT(*) c FROM notification_tasks GROUP BY status').all(),
    };
  });
  P('/api/admin/notifications/dispatch', ({ req }) => { adminOnly(req); return { dispatched: svc.dispatchPending() }; });
  G('/api/admin/mock-outbox', ({ req }) => {
    adminOnly(req);
    return {
      items: db.prepare(`SELECT m.*, t.status AS task_status FROM mock_outbox m JOIN notification_tasks t ON t.id = m.task_id ORDER BY m.id DESC`).all(),
      receipts: db.prepare('SELECT * FROM notification_receipts ORDER BY id DESC').all(),
    };
  });
  P('/api/mock-channel/receipt', ({ body }) => {
    requireFields(body, ['message_id']);
    return svc.recordReceipt(body);
  });
}

module.exports = { registerRoutes };
