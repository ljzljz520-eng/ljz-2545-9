'use strict';
/** 种子数据：首次启动时填充片单/场地/四种典型状态的场次（正常、已改期、满额、已取消） */
const { makeTx } = require('./db');
const { fmtLocal, uid } = require('./util');

function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) c FROM films').get().c > 0) return false;
  const tx = makeTx(db);
  tx(() => {
    const now = new Date();
    const at = (dayOffset, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return fmtLocal(d); };
    const nowStr = fmtLocal(now);

    const film = db.prepare('INSERT INTO films(title, director, year, duration_min, synopsis, tone, created_at) VALUES(?,?,?,?,?,?,?)');
    const f1 = film.run('夏夜行车', '陆之遥', 2024, 106, '一辆夜班公交车穿过整座失眠的城市。', 'amber', nowStr).lastInsertRowid;
    const f2 = film.run('河口往事', '陈槐', 2022, 124, '三代人的渡口，水涨水落之间。', 'teal', nowStr).lastInsertRowid;
    const f3 = film.run('纸飞机电台', '阿禾', 2025, 98, '天台上的海盗电台，只播给星星听。', 'violet', nowStr).lastInsertRowid;

    const mkVenue = (name, rows, cols, note) => {
      const id = db.prepare('INSERT INTO venues(name, capacity, rows, cols, note, created_at) VALUES(?,?,?,?,?,?)')
        .run(name, rows * cols, rows, cols, note, nowStr).lastInsertRowid;
      const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const ins = db.prepare('INSERT INTO seats(venue_id, row_label, col_no) VALUES(?,?,?)');
      for (let r = 0; r < rows; r++) for (let c = 1; c <= cols; c++) ins.run(Number(id), labels[r], c);
      return Number(id);
    };
    const v1 = mkVenue('滨江草坪', 4, 10, '主银幕 8m，请自备野餐垫');
    const v2 = mkVenue('天台花园', 3, 6, '雨天备用场地，容量较小');

    const mkScreening = (filmId, venueId, starts, ends, capacity) => {
      const seq = db.prepare(`INSERT INTO meta_counters(key, value) VALUES('screening', 0)
                              ON CONFLICT(key) DO NOTHING RETURNING value`).get();
      db.prepare(`UPDATE meta_counters SET value = value + 1 WHERE key='screening'`).run();
      const n = db.prepare(`SELECT value FROM meta_counters WHERE key='screening'`).get().value;
      const id = `SC-${String(n).padStart(4, '0')}`;
      db.prepare(`INSERT INTO screenings(id, film_id, venue_id, status, sale_state, capacity, taken_count, seq_counter, version, created_at, updated_at)
                  VALUES(?,?,?, 'scheduled', 'open', ?, 0, 0, 1, ?, ?)`).run(id, filmId, venueId, capacity, nowStr, nowStr);
      const revId = db.prepare(`INSERT INTO schedule_revisions(screening_id, rev_no, starts_at, ends_at, reason, created_at)
                                VALUES(?, 1, ?, ?, '初始排期', ?)`).run(id, starts, ends, nowStr).lastInsertRowid;
      db.prepare('UPDATE screenings SET current_revision_id=? WHERE id=?').run(revId, id);
      return id;
    };
    const mkTicket = (screeningId, venueId, seatIdx, name) => {
      const seat = db.prepare('SELECT * FROM seats WHERE venue_id=? ORDER BY row_label, col_no LIMIT 1 OFFSET ?').get(venueId, seatIdx);
      const s = db.prepare('SELECT * FROM screenings WHERE id=?').get(screeningId);
      const seq = db.prepare('UPDATE screenings SET seq_counter = seq_counter + 1 WHERE id=? RETURNING seq_counter').get(screeningId).seq_counter;
      const tid = uid('TK');
      db.prepare(`INSERT INTO tickets(id, screening_id, revision_id, seat_id, attendee_name, contact, status, confirm_seq, confirmed_at, updated_at)
                  VALUES(?,?,?,?,?,?, 'confirmed', ?, ?, ?)`)
        .run(tid, screeningId, s.current_revision_id, seat.id, name, `${name}@example.com`, seq, nowStr, nowStr);
      db.prepare(`INSERT INTO seat_occupancy(screening_id, seat_id, occupant_type, occupant_id, created_at) VALUES(?,?, 'ticket', ?, ?)`)
        .run(screeningId, seat.id, tid, nowStr);
      db.prepare('UPDATE screenings SET taken_count = taken_count + 1 WHERE id=?').run(screeningId);
      return tid;
    };

    // S1 正常场次
    const s1 = mkScreening(f1, v1, at(1, 19, 30), at(1, 21, 30), 40);
    mkTicket(s1, v1, 0, '王小满'); mkTicket(s1, v1, 1, '李望舒');

    // S2 已改期（rev1 19:00 -> rev2 21:00，migrate_all）
    const s2 = mkScreening(f2, v1, at(2, 19, 0), at(2, 21, 10), 40);
    const t2 = mkTicket(s2, v1, 10, '赵青禾');
    const rev2 = db.prepare(`INSERT INTO schedule_revisions(screening_id, rev_no, starts_at, ends_at, reason, ticket_policy, created_at)
                             VALUES(?, 2, ?, ?, '设备检修，顺延两小时', 'migrate_all', ?)`)
      .run(s2, at(2, 21, 0), at(2, 23, 10), nowStr).lastInsertRowid;
    db.prepare('UPDATE screenings SET current_revision_id=?, version=2 WHERE id=?').run(rev2, s2);
    db.prepare('UPDATE tickets SET revision_id=? WHERE id=?').run(rev2, t2);

    // S3 满额场次（小容量 + 全部订出）
    const s3 = mkScreening(f3, v2, at(3, 20, 0), at(3, 21, 45), 4);
    for (let i = 0; i < 4; i++) mkTicket(s3, v2, i, `观众${i + 1}`);

    // S4 已取消场次
    const s4 = mkScreening(f1, v2, at(4, 19, 30), at(4, 21, 30), 18);
    db.prepare(`UPDATE screenings SET status='cancelled', sale_state='closed', version=2 WHERE id=?`).run(s4);
  });
  console.log('[seed] 已写入示例数据：4 个场次（正常/已改期/满额/已取消）');
  return true;
}

if (require.main === module) {
  const { openDb } = require('./db');
  const db = openDb();
  seedIfEmpty(db);
  db.close();
}

module.exports = { seedIfEmpty };
