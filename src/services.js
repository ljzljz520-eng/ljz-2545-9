'use strict';
/**
 * 业务服务层。所有多步写入都在 tx() 内完成。
 *
 * 席位占用双策略（构造时可选，默认 atomic）：
 *  - atomic        席位原子占用：先原子递增场次计数器（带容量上界），再向 seat_occupancy
 *                  主键插入占位；冲突即失败。失败范围=单个席位，吞吐高，可平滑迁移到
 *                  Postgres 的行级唯一索引 + 条件 UPDATE。
 *  - screening_lock 全场次锁：进程内按场次串行化 + SELECT 校验后插入。语义最直观，
 *                  但同一场次的所有下单互斥，失败会波及不相干席位。
 * 两种策略共享同一份 SQL 不变量（唯一主键 + 计数器），正确性不依赖策略选择。
 */
const { nowStr, addSeconds, addHours, uid, badRequest, notFound, conflict } = require('./util');

const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 300);
const WEATHER_RULES = { precipitation_mm: 5, wind_kph: 40, conditions: ['storm', 'hail'] };
const AFFECT_WINDOW_BEFORE_H = 3; // 观测落在开场前 3h ~ 散场 之间视为相关

function createServices(db, tx, nextNo, opts = {}) {
  const strategy = opts.strategy || process.env.BOOKING_STRATEGY || 'atomic';
  const screeningLocks = new Map(); // screening_lock 策略的进程内互斥

  const q = {
    getScreening: db.prepare('SELECT * FROM screenings WHERE id = ?'),
    getRevision: db.prepare('SELECT * FROM schedule_revisions WHERE id = ?'),
    currentRev: db.prepare('SELECT * FROM schedule_revisions WHERE id = (SELECT current_revision_id FROM screenings WHERE id = ?)'),
    getVenue: db.prepare('SELECT * FROM venues WHERE id = ?'),
    getFilm: db.prepare('SELECT * FROM films WHERE id = ?'),
    venueSeats: db.prepare('SELECT * FROM seats WHERE venue_id = ? ORDER BY row_label, col_no'),
    occupancy: db.prepare('SELECT * FROM seat_occupancy WHERE screening_id = ?'),
    getHold: db.prepare('SELECT * FROM seat_holds WHERE id = ?'),
    getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  };

  /* ---------------- 占位超时清扫（读取路径上惰性执行 + 定时器主动执行） ---------------- */
  function sweepExpiredHolds(now = nowStr()) {
    return tx(() => {
      const expired = db.prepare(
        `SELECT h.*, o.occupant_type FROM seat_holds h
         LEFT JOIN seat_occupancy o ON o.screening_id = h.screening_id AND o.seat_id = h.seat_id
         WHERE h.status = 'active' AND h.expires_at <= ?`).all(now);
      for (const h of expired) {
        db.prepare(`UPDATE seat_holds SET status='expired' WHERE id=? AND status='active'`).run(h.id);
        const del = db.prepare(
          `DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='hold' AND occupant_id=?`
        ).run(h.screening_id, h.seat_id, h.id);
        if (del.changes > 0) {
          db.prepare('UPDATE screenings SET taken_count = taken_count - 1, updated_at=? WHERE id=?').run(now, h.screening_id);
        }
      }
      return expired.length;
    });
  }

  /* ---------------- 预订：占位 -> 确认 ---------------- */

  function assertBookable(s) {
    if (!s) throw notFound('场次不存在');
    if (s.status !== 'scheduled') throw conflict('SCREENING_NOT_OPEN', `场次状态为 ${s.status}，不可报名`);
    if (s.sale_state !== 'open') throw conflict('SALE_PAUSED', '该场次正在改期/维护中，暂停接受新报名');
  }

  function insertHoldRecord(s, seatId, name, contact) {
    const now = nowStr();
    const holdId = uid('HD');
    db.prepare(`INSERT INTO seat_holds(id, screening_id, seat_id, attendee_name, contact, status, expires_at, created_at)
                VALUES(?,?,?,?,?,'active',?,?)`)
      .run(holdId, s.id, seatId, name, contact || '', addSeconds(now, HOLD_TTL_SECONDS), now);
    db.prepare(`INSERT INTO seat_occupancy(screening_id, seat_id, occupant_type, occupant_id, created_at)
                VALUES(?,?, 'hold', ?, ?)`).run(s.id, seatId, holdId, now);
    return db.prepare('SELECT * FROM seat_holds WHERE id=?').get(holdId);
  }

  function holdSeatAtomic(screeningId, seatId, name, contact) {
    return tx(() => {
      sweepExpiredHolds();
      const s = q.getScreening.get(screeningId);
      assertBookable(s);
      const seat = db.prepare('SELECT * FROM seats WHERE id=? AND venue_id=?').get(seatId, s.venue_id);
      if (!seat) throw badRequest('座位不属于该场地');
      // 原子容量占位：计数器带上界条件，满额时 changes=0
      const bumped = db.prepare(
        `UPDATE screenings SET taken_count = taken_count + 1, updated_at=?
         WHERE id=? AND sale_state='open' AND status='scheduled' AND taken_count < capacity`
      ).run(nowStr(), screeningId);
      if (bumped.changes === 0) throw conflict('SCREENING_FULL', '本场已满额');
      try {
        return insertHoldRecord(s, seatId, name, contact);
      } catch (e) {
        if (String(e.message).includes('UNIQUE') || String(e.code || '').includes('SQLITE_CONSTRAINT')) {
          throw conflict('SEAT_TAKEN', '该座位刚被他人占位，请另选');
        }
        throw e;
      }
    });
  }

  function holdSeatWithScreeningLock(screeningId, seatId, name, contact) {
    if (screeningLocks.get(screeningId)) throw conflict('SCREENING_BUSY', '该场次有订单正在处理，请重试');
    screeningLocks.set(screeningId, true);
    try {
      return tx(() => {
        sweepExpiredHolds();
        const s = q.getScreening.get(screeningId);
        assertBookable(s);
        const seat = db.prepare('SELECT * FROM seats WHERE id=? AND venue_id=?').get(seatId, s.venue_id);
        if (!seat) throw badRequest('座位不属于该场地');
        const occupied = db.prepare('SELECT 1 FROM seat_occupancy WHERE screening_id=? AND seat_id=?').get(screeningId, seatId);
        if (occupied) throw conflict('SEAT_TAKEN', '该座位已被占用');
        if (s.taken_count >= s.capacity) throw conflict('SCREENING_FULL', '本场已满额');
        db.prepare('UPDATE screenings SET taken_count = taken_count + 1, updated_at=? WHERE id=?').run(nowStr(), screeningId);
        return insertHoldRecord(s, seatId, name, contact);
      });
    } finally {
      screeningLocks.delete(screeningId);
    }
  }

  function holdSeat(screeningId, { seat_id, attendee_name, contact }) {
    if (!attendee_name) throw badRequest('缺少 attendee_name');
    if (!Number.isInteger(seat_id)) throw badRequest('seat_id 须为整数');
    return strategy === 'screening_lock'
      ? holdSeatWithScreeningLock(screeningId, seat_id, attendee_name, contact)
      : holdSeatAtomic(screeningId, seat_id, attendee_name, contact);
  }

  function confirmHold(holdId) {
    return tx(() => {
      sweepExpiredHolds();
      const h = q.getHold.get(holdId);
      if (!h) throw notFound('占位不存在');
      if (h.status === 'expired') throw conflict('HOLD_EXPIRED', '占位已超时，请重新选座');
      if (h.status !== 'active') throw conflict('HOLD_NOT_ACTIVE', `占位状态为 ${h.status}`);
      const s = q.getScreening.get(h.screening_id);
      if (s.status !== 'scheduled') throw conflict('SCREENING_NOT_OPEN', '场次已不可确认');
      const now = nowStr();
      const seq = db.prepare('UPDATE screenings SET seq_counter = seq_counter + 1 WHERE id=? RETURNING seq_counter').get(s.id).seq_counter;
      const rev = q.currentRev.get(s.id);
      const ticketId = uid('TK');
      db.prepare(`INSERT INTO tickets(id, screening_id, revision_id, seat_id, hold_id, attendee_name, contact,
                                     status, confirm_seq, confirmed_at, updated_at)
                  VALUES(?,?,?,?,?,?,?, 'confirmed', ?, ?, ?)`)
        .run(ticketId, s.id, rev.id, h.seat_id, h.id, h.attendee_name, h.contact, seq, now, now);
      db.prepare(`UPDATE seat_holds SET status='converted' WHERE id=?`).run(h.id);
      db.prepare(`UPDATE seat_occupancy SET occupant_type='ticket', occupant_id=? WHERE screening_id=? AND seat_id=?`)
        .run(ticketId, s.id, h.seat_id);
      return q.getTicket.get(ticketId);
    });
  }

  function releaseHold(holdId) {
    return tx(() => {
      const h = q.getHold.get(holdId);
      if (!h) throw notFound('占位不存在');
      if (h.status !== 'active') return h;
      db.prepare(`UPDATE seat_holds SET status='released' WHERE id=?`).run(holdId);
      const del = db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='hold' AND occupant_id=?`)
        .run(h.screening_id, h.seat_id, holdId);
      if (del.changes > 0) db.prepare('UPDATE screenings SET taken_count = taken_count - 1, updated_at=? WHERE id=?').run(nowStr(), h.screening_id);
      return q.getHold.get(holdId);
    });
  }

  /* ---------------- 通知（幂等创建 + 本地模拟渠道派发 + 回执幂等） ---------------- */

  function enqueueNotification(kind, screeningId, ticket, payload, uniqSuffix) {
    // 幂等键 = 类型:场次[:事件后缀]:票号 —— 同一事件重复执行不产生重复任务；
    // 不同事件（如两次改期 rev2/rev3）通过后缀区分，各自生成新任务
    const key = `${kind}:${screeningId}${uniqSuffix ? ':' + uniqSuffix : ''}:${ticket ? ticket.id : 'broadcast'}`;
    const to = (ticket && (ticket.contact || ticket.attendee_name)) || 'all';
    db.prepare(`INSERT INTO notification_tasks(kind, screening_id, ticket_id, recipient, payload, channel, status, idempotency_key, created_at)
                VALUES(?,?,?,?,?, 'local_mock', 'pending', ?, ?)
                ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(kind, screeningId, ticket ? ticket.id : null, to, JSON.stringify(payload), key, nowStr());
    return key;
  }

  function dispatchPending() {
    return tx(() => {
      const tasks = db.prepare(`SELECT * FROM notification_tasks WHERE status='pending' AND channel='local_mock' ORDER BY id`).all();
      const sent = [];
      for (const t of tasks) {
        const messageId = uid('MSG');
        const p = JSON.parse(t.payload);
        const ins = db.prepare(`INSERT INTO mock_outbox(message_id, task_id, recipient, subject, body, channel, created_at)
                                VALUES(?,?,?,?,?, 'local_mock', ?) ON CONFLICT(task_id) DO NOTHING`)
          .run(messageId, t.id, t.recipient, p.subject || `[${t.kind}]`, p.body || JSON.stringify(p), nowStr());
        if (ins.changes > 0) {
          db.prepare(`UPDATE notification_tasks SET status='sent', sent_at=? WHERE id=?`).run(nowStr(), t.id);
          sent.push({ task_id: t.id, message_id: messageId });
        }
      }
      return sent;
    });
  }

  function recordReceipt({ message_id, receipt_token, status = 'delivered', raw }) {
    return tx(() => {
      const msg = db.prepare('SELECT * FROM mock_outbox WHERE message_id=?').get(message_id);
      if (!msg) throw notFound('模拟渠道无此消息');
      const token = receipt_token || `rcpt-${message_id}`;
      const ins = db.prepare(`INSERT INTO notification_receipts(task_id, receipt_token, status, raw, created_at)
                              VALUES(?,?,?,?,?) ON CONFLICT(task_id, receipt_token) DO NOTHING`)
        .run(msg.task_id, token, status, raw ? JSON.stringify(raw) : null, nowStr());
      const duplicate = ins.changes === 0;
      if (!duplicate && status === 'delivered') {
        db.prepare(`UPDATE notification_tasks SET status='delivered', delivered_at=? WHERE id=? AND status != 'delivered'`)
          .run(nowStr(), msg.task_id);
      }
      return { task_id: msg.task_id, receipt_token: token, duplicate };
    });
  }

  /* ---------------- 改期：同一活动追加排期版本，按政策处理旧票 ---------------- */

  function venueConflict(venueId, startsAt, endsAt, excludeScreeningId) {
    return db.prepare(
      `SELECT s.id, r.starts_at, r.ends_at FROM screenings s
       JOIN schedule_revisions r ON r.id = s.current_revision_id
       WHERE s.venue_id = ? AND s.status = 'scheduled' AND s.id != ?
         AND r.starts_at < ? AND r.ends_at > ?`).get(venueId, excludeScreeningId || '', endsAt, startsAt);
  }

  function checkVersion(s, version) {
    if (version !== undefined && Number(version) !== s.version) {
      throw conflict('VERSION_CONFLICT', `数据已被他人修改（当前版本 ${s.version}），请刷新后重试`, { current_version: s.version });
    }
  }

  function reschedule(screeningId, { starts_at, ends_at, reason, ticket_policy = 'migrate_all', version, actor = 'admin' }) {
    return tx(() => {
      const s = q.getScreening.get(screeningId);
      if (!s) throw notFound('场次不存在');
      checkVersion(s, version);
      if (s.status !== 'scheduled') throw conflict('SCREENING_NOT_OPEN', `场次状态为 ${s.status}，不能改期`);
      if (!['migrate_all', 'opt_in', 'void_all'].includes(ticket_policy)) throw badRequest('ticket_policy 非法');
      const clash = venueConflict(s.venue_id, starts_at, ends_at, screeningId);
      if (clash) throw conflict('VENUE_CONFLICT', `与场次 ${clash.id}（${clash.starts_at}~${clash.ends_at}）场地冲突`, clash);

      const now = nowStr();
      // 改期过程约束：先暂停售票（同事务内，外部看到的是原子切换）
      db.prepare(`UPDATE screenings SET sale_state='paused', updated_at=? WHERE id=?`).run(now, screeningId);

      const maxRev = db.prepare('SELECT COALESCE(MAX(rev_no),0) AS m FROM schedule_revisions WHERE screening_id=?').get(screeningId).m;
      const revId = db.prepare(`INSERT INTO schedule_revisions(screening_id, rev_no, starts_at, ends_at, reason, ticket_policy, created_by, created_at)
                                VALUES(?,?,?,?,?,?,?,?)`)
        .run(screeningId, maxRev + 1, starts_at, ends_at, reason || '', ticket_policy, actor, now).lastInsertRowid;

      const affected = db.prepare(
        `SELECT * FROM tickets WHERE screening_id=? AND status IN ('confirmed','migrate_pending') ORDER BY confirm_seq`).all(screeningId);
      let migrated = 0, pending = 0, voided = 0;
      for (const t of affected) {
        if (ticket_policy === 'migrate_all') {
          db.prepare(`UPDATE tickets SET revision_id=?, status='confirmed', updated_at=? WHERE id=?`).run(revId, now, t.id);
          migrated++;
        } else if (ticket_policy === 'opt_in') {
          db.prepare(`UPDATE tickets SET status='migrate_pending', updated_at=? WHERE id=?`).run(now, t.id);
          pending++;
        } else { // void_all：作废并释放席位
          db.prepare(`UPDATE tickets SET status='cancelled', cancelled_at=?, cancel_reason='reschedule_void', updated_at=? WHERE id=?`).run(now, now, t.id);
          const del = db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='ticket' AND occupant_id=?`)
            .run(screeningId, t.seat_id, t.id);
          if (del.changes > 0) db.prepare('UPDATE screenings SET taken_count = taken_count - 1 WHERE id=?').run(screeningId);
          voided++;
        }
        enqueueNotification('reschedule_notice', screeningId, t, {
          subject: `【改期】您的场次已调整至 ${starts_at}`,
          body: `票号 ${t.id}：新时间 ${starts_at}，政策 ${ticket_policy}。原因：${reason || '未说明'}`,
        }, `rev${revId}`);
      }
      db.prepare(`UPDATE screenings SET current_revision_id=?, sale_state='open', version=version+1, updated_at=? WHERE id=?`)
        .run(revId, now, screeningId);
      return { revision_id: Number(revId), rev_no: maxRev + 1, affected: affected.length, migrated, pending, voided };
    });
  }

  function answerMigration(ticketId, accept) {
    return tx(() => {
      const t = q.getTicket.get(ticketId);
      if (!t) throw notFound('票不存在');
      if (t.status !== 'migrate_pending') throw conflict('TICKET_NOT_PENDING', '该票不在待确认迁移状态');
      const s = q.getScreening.get(t.screening_id);
      const rev = q.currentRev.get(t.screening_id);
      const now = nowStr();
      if (accept) {
        if (s.status !== 'scheduled') throw conflict('SCREENING_NOT_OPEN', '场次已取消，无法迁移');
        db.prepare(`UPDATE tickets SET status='confirmed', revision_id=?, updated_at=? WHERE id=?`).run(rev.id, now, ticketId);
      } else {
        db.prepare(`UPDATE tickets SET status='cancelled', cancelled_at=?, cancel_reason='migration_declined', updated_at=? WHERE id=?`).run(now, now, ticketId);
        const del = db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='ticket' AND occupant_id=?`)
          .run(t.screening_id, t.seat_id, t.id);
        if (del.changes > 0) db.prepare('UPDATE screenings SET taken_count = taken_count - 1, updated_at=? WHERE id=?').run(now, t.screening_id);
      }
      return q.getTicket.get(ticketId);
    });
  }

  /* ---------------- 容量调整：保留原确认顺序，显式列出需处置人群 ---------------- */

  function setCapacity(screeningId, { capacity, version }) {
    return tx(() => {
      capacity = Number(capacity);
      if (!Number.isInteger(capacity) || capacity < 0) throw badRequest('capacity 须为非负整数');
      sweepExpiredHolds();
      const s = q.getScreening.get(screeningId);
      if (!s) throw notFound('场次不存在');
      checkVersion(s, version);
      const now = nowStr();
      const displaced = [];
      const restored = [];

      if (capacity < s.capacity) {
        // 缩减：按 confirm_seq 升序保留先到者，超出者进入 displaced（不随机撤销）
        const actives = db.prepare(
          `SELECT * FROM tickets WHERE screening_id=? AND status IN ('confirmed','migrate_pending') ORDER BY confirm_seq ASC`).all(screeningId);
        const overflow = actives.slice(capacity);
        for (const t of overflow) {
          db.prepare(`UPDATE tickets SET status='displaced', updated_at=? WHERE id=?`).run(now, t.id);
          const del = db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='ticket' AND occupant_id=?`)
            .run(screeningId, t.seat_id, t.id);
          if (del.changes > 0) db.prepare('UPDATE screenings SET taken_count = taken_count - 1 WHERE id=?').run(screeningId);
          displaced.push(t);
          enqueueNotification('displacement_notice', screeningId, t, {
            subject: '【席位调整】您的票需要处置',
            body: `票号 ${t.id}：因场地容量缩减被列入待处置名单（确认顺序 #${t.confirm_seq}），运营将联系您改签或退款。`,
          }, `v${s.version}`);
        }
        // 活跃占位超出新容量时，按创建时间倒序回收（占位是临时态，新者先让位）
        const holds = db.prepare(`SELECT * FROM seat_holds WHERE screening_id=? AND status='active' ORDER BY created_at DESC`).all(screeningId);
        const fresh = q.getScreening.get(screeningId);
        let excess = fresh.taken_count - capacity;
        for (const h of holds) {
          if (excess <= 0) break;
          db.prepare(`UPDATE seat_holds SET status='expired' WHERE id=?`).run(h.id);
          const del = db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='hold' AND occupant_id=?`)
            .run(screeningId, h.seat_id, h.id);
          if (del.changes > 0) { db.prepare('UPDATE screenings SET taken_count = taken_count - 1 WHERE id=?').run(screeningId); excess--; }
        }
      } else if (capacity > s.capacity) {
        // 扩容：按 confirm_seq 顺序尝试恢复 displaced（原座位仍空闲才恢复，绝不挤占他人）
        const waiting = db.prepare(`SELECT * FROM tickets WHERE screening_id=? AND status='displaced' ORDER BY confirm_seq ASC`).all(screeningId);
        let room = capacity - s.taken_count;
        for (const t of waiting) {
          if (room <= 0) break;
          const seatFree = !db.prepare('SELECT 1 FROM seat_occupancy WHERE screening_id=? AND seat_id=?').get(screeningId, t.seat_id);
          if (!seatFree) continue;
          db.prepare(`UPDATE tickets SET status='confirmed', updated_at=? WHERE id=?`).run(now, t.id);
          db.prepare(`INSERT INTO seat_occupancy(screening_id, seat_id, occupant_type, occupant_id, created_at) VALUES(?,?, 'ticket', ?, ?)`)
            .run(screeningId, t.seat_id, t.id, now);
          db.prepare('UPDATE screenings SET taken_count = taken_count + 1 WHERE id=?').run(screeningId);
          room--; restored.push(t);
        }
      }
      db.prepare('UPDATE screenings SET capacity=?, version=version+1, updated_at=? WHERE id=?').run(capacity, now, screeningId);
      return { capacity, displaced, restored };
    });
  }

  /* ---------------- 取消场次 ---------------- */

  function cancelScreening(screeningId, { reason = 'cancelled', status = 'cancelled', version } = {}) {
    return tx(() => {
      sweepExpiredHolds();
      const s = q.getScreening.get(screeningId);
      if (!s) throw notFound('场次不存在');
      checkVersion(s, version);
      if (s.status !== 'scheduled') return { already: s.status };
      const now = nowStr();
      const tickets = db.prepare(`SELECT * FROM tickets WHERE screening_id=? AND status IN ('confirmed','migrate_pending','displaced')`).all(screeningId);
      for (const t of tickets) {
        db.prepare(`UPDATE tickets SET status='cancelled', cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?`).run(now, reason, now, t.id);
        db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='ticket' AND occupant_id=?`)
          .run(screeningId, t.seat_id, t.id);
        enqueueNotification('cancel_notice', screeningId, t, {
          subject: '【取消】您报名的放映已取消',
          body: `票号 ${t.id}：场次取消（${reason}），将为您办理退款。`,
        });
      }
      const holds = db.prepare(`SELECT * FROM seat_holds WHERE screening_id=? AND status='active'`).all(screeningId);
      for (const h of holds) {
        db.prepare(`UPDATE seat_holds SET status='released' WHERE id=?`).run(h.id);
        db.prepare(`DELETE FROM seat_occupancy WHERE screening_id=? AND seat_id=? AND occupant_type='hold' AND occupant_id=?`)
          .run(screeningId, h.seat_id, h.id);
      }
      db.prepare(`UPDATE screenings SET status=?, sale_state='closed', taken_count=0, version=version+1, updated_at=? WHERE id=?`)
        .run(status, now, screeningId);
      return { cancelled_tickets: tickets.length, released_holds: holds.length };
    });
  }

  /* ---------------- 天气：观测只触发“待决定”预案，运营确认才改变公开状态 ---------------- */

  function isSevere(o) {
    return WEATHER_RULES.conditions.includes(o.condition) ||
      (o.precipitation_mm || 0) >= WEATHER_RULES.precipitation_mm ||
      (o.wind_kph || 0) >= WEATHER_RULES.wind_kph;
  }

  function ingestObservation({ venue_id, observed_at, condition, precipitation_mm = 0, wind_kph = 0, source = 'mock_feed' }) {
    return tx(() => {
      const now = nowStr();
      const obsId = db.prepare(`INSERT INTO weather_observations(venue_id, observed_at, condition, precipitation_mm, wind_kph, source, created_at)
                                VALUES(?,?,?,?,?,?,?)`)
        .run(venue_id, observed_at, condition, precipitation_mm, wind_kph, source, now).lastInsertRowid;
      const obs = { condition, precipitation_mm, wind_kph };
      const events = [];
      const log = (screeningId, action, detail) => {
        db.prepare('INSERT INTO weather_events(screening_id, observation_id, action, detail, created_at) VALUES(?,?,?,?,?)')
          .run(screeningId, obsId, action, detail, now);
        events.push({ screening_id: screeningId, action });
      };
      if (!isSevere(obs)) return { observation_id: Number(obsId), severe: false, events };

      const candidates = db.prepare(
        `SELECT s.*, r.starts_at, r.ends_at FROM screenings s
         JOIN schedule_revisions r ON r.id = s.current_revision_id
         WHERE s.venue_id = ?`).all(venue_id);
      for (const s of candidates) {
        const inWindow = observed_at >= addHours(s.starts_at, -AFFECT_WINDOW_BEFORE_H) && observed_at <= s.ends_at;
        if (!inWindow) continue;
        if (s.status !== 'scheduled') { log(s.id, 'ignored_terminal', `场次已是 ${s.status}，迟到/后续观测不再改变公开状态`); continue; }
        const plan = db.prepare('SELECT * FROM contingency_plans WHERE screening_id=? ORDER BY id DESC LIMIT 1').get(s.id);
        if (!plan) {
          const pid = db.prepare(`INSERT INTO contingency_plans(screening_id, trigger_observation_id, kind, status, created_at)
                                  VALUES(?,?, 'cancel', 'pending_decision', ?)`).run(s.id, obsId, now).lastInsertRowid;
          log(s.id, 'plan_created', `生成待决定预案 #${pid}（公开状态不变，等待运营确认）`);
        } else if (plan.status === 'pending_decision') {
          db.prepare('UPDATE contingency_plans SET trigger_observation_id=?, version=version+1 WHERE id=?').run(obsId, plan.id);
          log(s.id, 'plan_updated', `预案 #${plan.id} 更新触发数据，仍为待决定`);
        } else if (observed_at <= plan.decided_at) {
          log(s.id, 'ignored_stale', `预案 #${plan.id} 已于 ${plan.decided_at} 决策，迟到的观测不推翻既有决定`);
        } else {
          const pid = db.prepare(`INSERT INTO contingency_plans(screening_id, trigger_observation_id, kind, status, created_at)
                                  VALUES(?,?, 'cancel', 'pending_decision', ?)`).run(s.id, obsId, now).lastInsertRowid;
          log(s.id, 'plan_created', `决策后收到更新的恶劣天气，生成新待决定预案 #${pid}`);
        }
      }
      return { observation_id: Number(obsId), severe: true, events };
    });
  }

  function decidePlan(planId, { decision, note = '', actor = 'operator', postpone }) {
    return tx(() => {
      const p = db.prepare('SELECT * FROM contingency_plans WHERE id=?').get(planId);
      if (!p) throw notFound('预案不存在');
      if (p.status !== 'pending_decision') throw conflict('PLAN_DECIDED', `预案已是 ${p.status} 状态，不能重复决策`);
      const now = nowStr();
      if (decision === 'approve') {
        if (p.kind === 'cancel') {
          cancelScreening(p.screening_id, { reason: 'weather', status: 'weather_cancelled' });
        } else if (p.kind === 'postpone') {
          if (!postpone || !postpone.starts_at || !postpone.ends_at) throw badRequest('批准延期预案须携带 postpone.starts_at/ends_at');
          reschedule(p.screening_id, {
            starts_at: postpone.starts_at, ends_at: postpone.ends_at,
            reason: `天气延期（预案 #${p.id}）`, ticket_policy: postpone.ticket_policy || 'opt_in', actor,
          });
        }
      }
      db.prepare(`UPDATE contingency_plans SET status=?, decided_by=?, decided_at=?, decision_note=?, version=version+1 WHERE id=?`)
        .run(decision === 'approve' ? 'approved' : 'rejected', actor, now, note, planId);
      return db.prepare('SELECT * FROM contingency_plans WHERE id=?').get(planId);
    });
  }

  /* ---------------- 查询 ---------------- */

  function listScreenings() {
    sweepExpiredHolds();
    const rows = db.prepare(
      `SELECT s.*, r.starts_at, r.ends_at, r.rev_no,
              f.title AS film_title, f.duration_min, f.tone, v.name AS venue_name,
              (SELECT COUNT(*) FROM schedule_revisions x WHERE x.screening_id = s.id) AS rev_count,
              (SELECT MIN(x.starts_at) FROM schedule_revisions x WHERE x.screening_id = s.id) AS first_starts_at
       FROM screenings s
       JOIN schedule_revisions r ON r.id = s.current_revision_id
       JOIN films f ON f.id = s.film_id
       JOIN venues v ON v.id = s.venue_id
       ORDER BY r.starts_at`).all();
    return rows.map(s => ({
      id: s.id, version: s.version, status: s.status, sale_state: s.sale_state,
      film: { title: s.film_title, duration_min: s.duration_min, tone: s.tone },
      venue: { name: s.venue_name },
      starts_at: s.starts_at, ends_at: s.ends_at,
      capacity: s.capacity, taken: s.taken_count,
      seats_available: Math.max(0, s.capacity - s.taken_count),
      flags: {
        rescheduled: s.rev_count > 1,
        cancelled: s.status === 'cancelled' || s.status === 'weather_cancelled',
        full: s.status === 'scheduled' && s.taken_count >= s.capacity,
      },
      original_starts_at: s.rev_count > 1 ? s.first_starts_at : null,
      pending_plan: !!db.prepare(`SELECT 1 FROM contingency_plans WHERE screening_id=? AND status='pending_decision'`).get(s.id),
    }));
  }

  function screeningDetail(screeningId) {
    sweepExpiredHolds();
    const s = q.getScreening.get(screeningId);
    if (!s) throw notFound('场次不存在');
    const rev = q.currentRev.get(screeningId);
    const venue = q.getVenue.get(s.venue_id);
    const film = q.getFilm.get(s.film_id);
    const seats = q.venueSeats.all(s.venue_id);
    const occ = new Map(q.occupancy.all(screeningId).map(o => [o.seat_id, o]));
    const seatList = seats.map(seat => {
      const o = occ.get(seat.id);
      const beyondCapacity = false; // 容量缩减只通过 displaced 体现，不隐藏座位
      return {
        id: seat.id, row: seat.row_label, col: seat.col_no,
        state: !o ? 'available' : (o.occupant_type === 'hold' ? 'held' : 'taken'),
        beyond_capacity: beyondCapacity,
      };
    });
    const revisions = db.prepare('SELECT * FROM schedule_revisions WHERE screening_id=? ORDER BY rev_no').all(screeningId);
    return {
      id: s.id, version: s.version, status: s.status, sale_state: s.sale_state,
      capacity: s.capacity, taken: s.taken_count, seats_available: Math.max(0, s.capacity - s.taken_count),
      film, venue: { id: venue.id, name: venue.name, rows: venue.rows, cols: venue.cols },
      starts_at: rev.starts_at, ends_at: rev.ends_at, rev_no: rev.rev_no,
      revisions, seats: seatList,
    };
  }

  function ticketView(ticketId) {
    const t = q.getTicket.get(ticketId);
    if (!t) throw notFound('票不存在');
    const s = q.getScreening.get(t.screening_id);
    const rev = q.currentRev.get(t.screening_id); // 始终展示“当前排期”——改期后票不失联
    const film = q.getFilm.get(s.film_id);
    const venue = q.getVenue.get(s.venue_id);
    const seat = db.prepare('SELECT * FROM seats WHERE id=?').get(t.seat_id);
    return {
      ...t, screening_status: s.status, film_title: film.title, venue_name: venue.name,
      seat_label: `${seat.row_label}${seat.col_no}`,
      current_starts_at: rev.starts_at, current_ends_at: rev.ends_at,
      screening_rev_count: db.prepare('SELECT COUNT(*) c FROM schedule_revisions WHERE screening_id=?').get(t.screening_id).c,
    };
  }

  return {
    strategy,
    sweepExpiredHolds, holdSeat, confirmHold, releaseHold,
    reschedule, answerMigration, setCapacity, cancelScreening,
    ingestObservation, decidePlan,
    enqueueNotification, dispatchPending, recordReceipt,
    listScreenings, screeningDetail, ticketView,
    venueConflict, checkVersion,
  };
}

module.exports = { createServices, HOLD_TTL_SECONDS, WEATHER_RULES };
