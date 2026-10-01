'use strict';
/**
 * 数据层：SQLite（better-sqlite3，同步驱动 => 单进程内天然串行，配合 BEGIN IMMEDIATE 获得写串行化）
 * 核心不变量由数据库强制：
 *  - seat_occupancy 主键 (screening_id, seat_id)：席位原子占用的唯一裁决者
 *  - schedule_revisions：改期 = 同一活动（screenings.id 不变）追加新排期版本，票永远指向 screenings.id，不失联
 *  - notification_receipts UNIQUE(task_id, receipt_token)：重复回执幂等
 *  - notification_tasks.idempotency_key UNIQUE：通知任务去重
 */
const Database = require('better-sqlite3');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS films (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  director TEXT,
  year INTEGER,
  duration_min INTEGER NOT NULL,
  synopsis TEXT,
  tone TEXT DEFAULT 'amber',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  row_label TEXT NOT NULL,
  col_no INTEGER NOT NULL,
  UNIQUE(venue_id, row_label, col_no)
);

-- 场次身份：改期/取消均不改变 id；version 用于乐观并发控制
CREATE TABLE IF NOT EXISTS screenings (
  id TEXT PRIMARY KEY,
  film_id INTEGER NOT NULL REFERENCES films(id),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','cancelled','weather_cancelled','completed')),
  sale_state TEXT NOT NULL DEFAULT 'open'
    CHECK(sale_state IN ('open','paused','closed')),
  capacity INTEGER NOT NULL,            -- 有效容量快照（可被缩减/恢复）
  taken_count INTEGER NOT NULL DEFAULT 0, -- 已占用数（活跃占位+有效票），原子计数器
  seq_counter INTEGER NOT NULL DEFAULT 0, -- 确认顺序号发生器（缩减容量按此保留先到者）
  current_revision_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 排期版本：改期是“同一活动的新安排”，追加修订而非重建活动
CREATE TABLE IF NOT EXISTS schedule_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_id TEXT NOT NULL REFERENCES screenings(id),
  rev_no INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT,
  ticket_policy TEXT CHECK(ticket_policy IN ('migrate_all','opt_in','void_all')),
  created_by TEXT DEFAULT 'admin',
  created_at TEXT NOT NULL,
  UNIQUE(screening_id, rev_no)
);

-- 占位记录（预留）：有明确过期时间，超时由清扫回收
CREATE TABLE IF NOT EXISTS seat_holds (
  id TEXT PRIMARY KEY,
  screening_id TEXT NOT NULL REFERENCES screenings(id),
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  attendee_name TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','converted','expired','released')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holds_screening ON seat_holds(screening_id, status);

-- 票：screening_id 永远指向活动身份；revision_id 记录购票时/迁移后的排期版本
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  screening_id TEXT NOT NULL REFERENCES screenings(id),
  revision_id INTEGER NOT NULL REFERENCES schedule_revisions(id),
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  hold_id TEXT REFERENCES seat_holds(id),
  attendee_name TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK(status IN ('confirmed','migrate_pending','displaced','cancelled')),
  confirm_seq INTEGER NOT NULL,          -- 全场次确认顺序（FIFO 依据）
  confirmed_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancel_reason TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(screening_id, confirm_seq)
);
CREATE INDEX IF NOT EXISTS idx_tickets_screening ON tickets(screening_id, status);

-- 席位占用登记表：hold 与 ticket 共用的一张“席位锁表”，主键即原子占用保证
CREATE TABLE IF NOT EXISTS seat_occupancy (
  screening_id TEXT NOT NULL,
  seat_id INTEGER NOT NULL,
  occupant_type TEXT NOT NULL CHECK(occupant_type IN ('hold','ticket')),
  occupant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (screening_id, seat_id)
);

CREATE TABLE IF NOT EXISTS weather_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  observed_at TEXT NOT NULL,
  condition TEXT NOT NULL,
  precipitation_mm REAL DEFAULT 0,
  wind_kph REAL DEFAULT 0,
  source TEXT DEFAULT 'mock_feed',
  created_at TEXT NOT NULL
);

-- 天气预案：天气数据只能把预案推到 pending_decision；公开状态只在运营决策后改变
CREATE TABLE IF NOT EXISTS contingency_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_id TEXT NOT NULL REFERENCES screenings(id),
  trigger_observation_id INTEGER REFERENCES weather_observations(id),
  kind TEXT NOT NULL DEFAULT 'cancel' CHECK(kind IN ('cancel','postpone')),
  status TEXT NOT NULL DEFAULT 'pending_decision'
    CHECK(status IN ('pending_decision','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_screening ON contingency_plans(screening_id, status);

-- 天气处置审计：迟到/终态/陈旧数据为何被忽略，全部留痕
CREATE TABLE IF NOT EXISTS weather_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_id TEXT,
  observation_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  screening_id TEXT,
  ticket_id TEXT,
  recipient TEXT NOT NULL,
  payload TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'local_mock',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','delivered','failed')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS mock_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  task_id INTEGER UNIQUE NOT NULL REFERENCES notification_tasks(id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'local_mock',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES notification_tasks(id),
  receipt_token TEXT NOT NULL,
  status TEXT NOT NULL,
  raw TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, receipt_token)
);

CREATE TABLE IF NOT EXISTS meta_counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

function openDb(dbPath) {
  const db = new Database(dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** 嵌套安全的事务：外层 BEGIN IMMEDIATE，内层退化为 SAVEPOINT */
function makeTx(db) {
  let depth = 0;
  return function tx(fn) {
    if (depth > 0) {
      const sp = `sp_${depth}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const r = fn();
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw e;
      }
    }
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
}

function nextNo(db, key) {
  db.prepare('INSERT INTO meta_counters(key,value) VALUES(?,0) ON CONFLICT(key) DO NOTHING').run(key);
  const row = db.prepare('UPDATE meta_counters SET value = value + 1 WHERE key = ? RETURNING value').get(key);
  return row.value;
}

module.exports = { openDb, makeTx, nextNo };
