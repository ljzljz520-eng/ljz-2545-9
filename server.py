#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
露天电影排片系统 · Open Air Cinema（单文件后端，仅依赖 Python 标准库）

设计要点
- 场次身份稳定：改期 = 同一活动的新安排（public_code / id 不变），旧票按 ticket_policy 显式迁移或转待重订，
  绝不重新生成活动导致原预约失联。
- 天气数据只生成「待决定」预案（weather_plans.state=pending），运营确认后才改变公开状态；
  取消/驳回后的迟到天气更新只记录为 superseded，不回溯公开状态。
- 席位原子占用（唯一部分索引 + BEGIN IMMEDIATE，BOOKING_STRATEGY=seat）与
  全场次锁（应用层 per-session 互斥锁，BOOKING_STRATEGY=session）两种策略可切换对比。
- 预留超时：holds.expires_at，惰性清扫；超时确认返回 410。
- 幂等：holds/reservations.idempotency_key 唯一；notifications.dedupe_key 去重；重复回执返回同一结果。
- 乐观版本：sessions.version，变更请求带 expected_version，过期写返回 409 STALE_VERSION；
  前端以「请求序号 + 版本号」双重守卫，旧响应不覆盖新状态。
"""
import json, os, re, sqlite3, sys, threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('CINEMA_DATA_DIR', os.path.join(BASE, 'data'))
STATIC_DIR = os.path.join(BASE, 'static')
DB_PATH = os.path.join(DATA_DIR, 'cinema.db')
MOCK_LOG = os.path.join(DATA_DIR, 'mock_channel.log')
STRATEGY = os.environ.get('BOOKING_STRATEGY', 'seat')   # seat=席位原子占用 | session=全场次锁
HOLD_TTL = int(os.environ.get('HOLD_TTL_SECONDS', '120'))
SETUP_BUFFER_MIN = 30                                    # 场间装台/清场缓冲
APP_VERSION = '1.0.0'

os.makedirs(DATA_DIR, exist_ok=True)

# ---------------- 基础工具 ----------------
_local = threading.local()
_locks = {}
_locks_guard = threading.Lock()

def session_lock(sid):
    with _locks_guard:
        return _locks.setdefault(int(sid), threading.Lock())

def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

def parse_iso(s):
    s = (s or '').strip()
    if s.endswith('Z'):
        s = s[:-1]
    for fmt in ('%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M'):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError('无法解析时间: %r' % (s,))

def to_iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

# ---------------- 数据库 ----------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS films(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  synopsis TEXT DEFAULT '',
  rating TEXT DEFAULT '普',
  palette TEXT DEFAULT '#f5b942'
);
CREATE TABLE IF NOT EXISTS venues(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT DEFAULT '',
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  capacity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_code TEXT NOT NULL UNIQUE,          -- 稳定身份：改期不变
  film_id INTEGER NOT NULL REFERENCES films(id),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  original_start_time TEXT NOT NULL,         -- 首次排期留档
  capacity INTEGER NOT NULL,                 -- 本场有效容量（<= 场地容量）
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | cancelled
  booking_frozen INTEGER NOT NULL DEFAULT 0, -- 改期过程中冻结新报名
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  weather_state TEXT NOT NULL DEFAULT 'clear',
  version INTEGER NOT NULL DEFAULT 1,        -- 乐观并发版本
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_history( -- 改期履历：同一活动的新安排
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  old_start TEXT NOT NULL,
  new_start TEXT NOT NULL,
  ticket_policy TEXT NOT NULL,               -- migrate | rebook
  reason TEXT DEFAULT 'manual',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weather_plans(    -- 天气预案：数据只触发 pending，运营确认才生效
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,                 -- 观测时间：识别迟到更新
  risk TEXT NOT NULL,
  proposal TEXT NOT NULL,                    -- cancel | postpone
  state TEXT NOT NULL DEFAULT 'pending',     -- pending | confirmed | rejected | superseded
  decided_by TEXT, decided_at TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holds(            -- 占位记录（预留）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  seat_label TEXT NOT NULL,
  user_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',      -- active | consumed | expired | released
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_holds_active_seat
  ON holds(session_id, seat_label) WHERE state='active';
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  seat_label TEXT NOT NULL,
  user_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | displaced | rebook_pending | cancelled
  confirm_seq INTEGER NOT NULL,              -- 确认顺序：缩减容量时按此保留
  idempotency_key TEXT NOT NULL UNIQUE,
  hold_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_active_seat
  ON reservations(session_id, seat_label) WHERE state='confirmed';
CREATE TABLE IF NOT EXISTS notifications(    -- 通知中心：待发送任务
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  payload TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'mock_local',
  state TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed
  dedupe_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
"""

def get_db():
    con = getattr(_local, 'con', None)
    if con is None:
        con = sqlite3.connect(DB_PATH, timeout=10)
        con.row_factory = sqlite3.Row
        con.isolation_level = None  # autocommit；多语句写用显式 BEGIN IMMEDIATE
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('PRAGMA foreign_keys=ON')
        con.execute('PRAGMA busy_timeout=5000')
        _local.con = con
    return con

def q(sql, args=()):
    return get_db().execute(sql, args).fetchall()

def q1(sql, args=()):
    return get_db().execute(sql, args).fetchone()

def run(sql, args=()):
    return get_db().execute(sql, args)

def audit(entity, eid, action, detail=None):
    run('INSERT INTO audit_log(entity,entity_id,action,detail,created_at) VALUES(?,?,?,?,?)',
        (entity, str(eid), action, json.dumps(detail or {}, ensure_ascii=False), now_iso()))

def enqueue_notif(kind, recipient, payload, session_id=None, dedupe_key=None):
    run("""INSERT OR IGNORE INTO notifications(session_id,kind,recipient,payload,channel,state,dedupe_key,created_at)
           VALUES(?,?,?,?, 'mock_local','pending',?,?)""",
        (session_id, kind, recipient, json.dumps(payload, ensure_ascii=False), dedupe_key, now_iso()))

def sweep_holds(session_id=None):
    """惰性清扫过期占位（读路径触发，确定性可测）。"""
    if session_id:
        run("UPDATE holds SET state='expired' WHERE state='active' AND expires_at < ? AND session_id=?",
            (now_iso(), int(session_id)))
    else:
        run("UPDATE holds SET state='expired' WHERE state='active' AND expires_at < ?", (now_iso(),))

def seat_labels(rows, cols):
    out = []
    for r in range(min(int(rows), 26)):
        for c in range(1, int(cols) + 1):
            out.append('%s%d' % (chr(65 + r), c))
    return out

def session_view(s):
    sid = s['id']
    confirmed = q1("SELECT COUNT(*) c FROM reservations WHERE session_id=? AND state='confirmed'", (sid,))['c']
    held = q1("SELECT COUNT(*) c FROM holds WHERE session_id=? AND state='active'", (sid,))['c']
    cap = s['capacity']
    if s['status'] == 'cancelled':
        display = 'cancelled'
    elif s['booking_frozen']:
        display = 'frozen'
    elif confirmed >= cap:
        display = 'full'
    else:
        display = 'open'
    film = dict(q1('SELECT * FROM films WHERE id=?', (s['film_id'],)))
    venue = dict(q1('SELECT * FROM venues WHERE id=?', (s['venue_id'],)))
    plan = q1("SELECT * FROM weather_plans WHERE session_id=? AND state='pending' ORDER BY id DESC LIMIT 1", (sid,))
    d = dict(s)
    d.update({'film': film, 'venue': venue, 'confirmed': confirmed, 'held': held,
              'seats_left': max(0, cap - confirmed - held),
              'display_status': display, 'rescheduled': bool(s['reschedule_count']),
              'pending_weather_plan': dict(plan) if plan else None})
    return d

# ---------------- 领域流程 ----------------
def venue_conflicts(venue_id, start_iso, end_iso, exclude_id=None):
    sql = """SELECT id, public_code, start_time, end_time FROM sessions
             WHERE venue_id=? AND status!='cancelled' AND start_time < ? AND end_time > ?"""
    args = [venue_id, end_iso, start_iso]
    if exclude_id:
        sql += ' AND id != ?'
        args.append(exclude_id)
    return q(sql, args)

def cancel_session_tx(s, reason, operator='system', weather_state=None):
    """取消场次：释放占位、确认票转 cancelled、逐人通知（去重）。"""
    sid = s['id']
    con = get_db()
    con.execute('BEGIN IMMEDIATE')
    try:
        if weather_state:
            con.execute("UPDATE sessions SET status='cancelled', weather_state=?, version=version+1, updated_at=? WHERE id=?",
                        (weather_state, now_iso(), sid))
        else:
            con.execute("UPDATE sessions SET status='cancelled', version=version+1, updated_at=? WHERE id=?",
                        (now_iso(), sid))
        affected = con.execute("SELECT * FROM reservations WHERE session_id=? AND state='confirmed'", (sid,)).fetchall()
        con.execute("UPDATE reservations SET state='cancelled', updated_at=? WHERE session_id=? AND state='confirmed'",
                    (now_iso(), sid))
        con.execute("UPDATE holds SET state='released' WHERE session_id=? AND state='active'", (sid,))
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    for r in affected:
        enqueue_notif('session_cancelled', r['user_name'],
                      {'session': s['public_code'], 'seat': r['seat_label'], 'reason': reason},
                      session_id=sid, dedupe_key='notif:cancel:%s' % r['id'])
    audit('session', sid, 'cancel', {'reason': reason, 'by': operator, 'affected': len(affected)})
    return affected

def reschedule_session_tx(s, new_start_dt, policy, reason='manual', note='', operator='admin'):
    """改期：同一活动的新安排。id/public_code 不变；票按 policy 显式处理；改期过程冻结新报名。"""
    sid = s['id']
    film = q1('SELECT * FROM films WHERE id=?', (s['film_id'],))
    new_start = to_iso(new_start_dt)
    new_end = to_iso(new_start_dt + timedelta(minutes=film['duration_min'] + SETUP_BUFFER_MIN))
    conflicts = venue_conflicts(s['venue_id'], new_start, new_end, exclude_id=sid)
    if conflicts:
        return None, conflicts
    con = get_db()
    con.execute('BEGIN IMMEDIATE')
    try:
        con.execute("""UPDATE sessions SET start_time=?, end_time=?, reschedule_count=reschedule_count+1,
                       booking_frozen=1, version=version+1, updated_at=? WHERE id=?""",
                    (new_start, new_end, now_iso(), sid))
        con.execute("""INSERT INTO schedule_history(session_id,old_start,new_start,ticket_policy,reason,note,created_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (sid, s['start_time'], new_start, policy, reason, note, now_iso()))
        affected = con.execute("SELECT * FROM reservations WHERE session_id=? AND state='confirmed'", (sid,)).fetchall()
        if policy == 'rebook':
            con.execute("UPDATE reservations SET state='rebook_pending', updated_at=? WHERE session_id=? AND state='confirmed'",
                        (now_iso(), sid))
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    rc = q1('SELECT reschedule_count c FROM sessions WHERE id=?', (sid,))['c']
    kind = 'session_rescheduled' if policy == 'migrate' else 'rebook_required'
    for r in affected:
        enqueue_notif(kind, r['user_name'],
                      {'session': s['public_code'], 'seat': r['seat_label'], 'new_start': new_start, 'policy': policy},
                      session_id=sid, dedupe_key='notif:resched:%s:%s' % (r['id'], rc))
    audit('session', sid, 'reschedule',
          {'new_start': new_start, 'policy': policy, 'reason': reason, 'by': operator, 'affected': len(affected)})
    return {'new_start': new_start, 'new_end': new_end, 'affected': len(affected)}, None

# ---------------- HTTP 框架 ----------------
class Ctx:
    def __init__(self, body, query):
        self.body = body
        self.query = query

def err(code, msg, **kw):
    d = {'error': msg}
    d.update(kw)
    return code, d

ROUTES = []
def route(method, pattern):
    rx = re.compile('^' + pattern + '$')
    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco

# ---------------- 公开接口 ----------------
@route('GET', r'/api/health')
def h_health(ctx):
    return 200, {'ok': True, 'version': APP_VERSION, 'strategy': STRATEGY,
                 'hold_ttl_seconds': HOLD_TTL, 'time': now_iso()}

@route('GET', r'/api/films')
def h_films(ctx):
    return 200, {'films': [dict(r) for r in q('SELECT * FROM films ORDER BY id')]}

@route('GET', r'/api/venues')
def h_venues(ctx):
    out = []
    for v in q('SELECT * FROM venues ORDER BY id'):
        d = dict(v)
        d['seats'] = seat_labels(v['rows'], v['cols'])
        out.append(d)
    return 200, {'venues': out}

@route('GET', r'/api/sessions')
def h_sessions(ctx):
    sweep_holds()
    return 200, {'sessions': [session_view(s) for s in q('SELECT * FROM sessions ORDER BY start_time, id')],
                 'server_time': now_iso()}

@route('GET', r'/api/sessions/(\d+)')
def h_session(ctx, sid):
    sid = int(sid)
    sweep_holds(sid)
    s = q1('SELECT * FROM sessions WHERE id=?', (sid,))
    if not s:
        return err(404, 'NOT_FOUND')
    v = session_view(s)
    venue = q1('SELECT * FROM venues WHERE id=?', (s['venue_id'],))
    labels = seat_labels(venue['rows'], venue['cols'])
    confirmed = {r['seat_label'] for r in q(
        "SELECT seat_label FROM reservations WHERE session_id=? AND state='confirmed'", (sid,))}
    holds = {r['seat_label']: r for r in q(
        "SELECT * FROM holds WHERE session_id=? AND state='active'", (sid,))}
    key = (ctx.query.get('key') or [None])[0]
    seats = []
    for i, label in enumerate(labels):
        if i >= s['capacity']:
            st = 'na'
        elif label in confirmed:
            st = 'taken'
        elif label in holds:
            st = 'held'
        else:
            st = 'free'
        seat = {'label': label, 'state': st}
        if st == 'held' and key and holds[label]['idempotency_key'] == key:
            seat['mine'] = True
            seat['expires_at'] = holds[label]['expires_at']
        seats.append(seat)
    v['seats'] = seats
    v['history'] = [dict(r) for r in q('SELECT * FROM schedule_history WHERE session_id=? ORDER BY id', (sid,))]
    return 200, v

@route('POST', r'/api/sessions/(\d+)/holds')
def h_hold(ctx, sid):
    sid = int(sid)
    b = ctx.body
    seat = (b.get('seat') or '').strip()
    user = (b.get('user') or '').strip()
    key = (b.get('idempotency_key') or '').strip()
    try:
        ttl = int(b.get('ttl_seconds') or HOLD_TTL)
    except Exception:
        ttl = HOLD_TTL
    ttl = max(1, min(ttl, 900))
    if not seat or not user or not key:
        return err(400, 'MISSING_FIELDS', detail='seat / user / idempotency_key 必填')
    sweep_holds(sid)
    s = q1('SELECT * FROM sessions WHERE id=?', (sid,))
    if not s:
        return err(404, 'NOT_FOUND')
    if s['status'] == 'cancelled':
        return err(409, 'SESSION_CANCELLED')
    if s['booking_frozen']:
        return err(409, 'BOOKING_FROZEN', detail='改期处理中，暂停新报名')
    old = q1('SELECT * FROM holds WHERE idempotency_key=?', (key,))
    if old:  # 幂等重试：返回原占位
        return 200, {'hold': dict(old), 'idempotent': True}
    venue = q1('SELECT * FROM venues WHERE id=?', (s['venue_id'],))
    labels = seat_labels(venue['rows'], venue['cols'])
    if seat not in labels:
        return err(400, 'BAD_SEAT')
    if seat not in labels[:s['capacity']]:
        return err(409, 'SEAT_OUT_OF_CAPACITY', detail='该座位不在本场开放容量内')
    expires = to_iso(datetime.now(timezone.utc) + timedelta(seconds=ttl))
    if STRATEGY == 'session':  # 全场次锁：应用层串行化整场写入
        with session_lock(sid):
            return _insert_hold(s, seat, user, key, expires)
    return _insert_hold(s, seat, user, key, expires)  # 席位原子占用

def _insert_hold(s, seat, user, key, expires):
    """席位原子占用：BEGIN IMMEDIATE + 唯一部分索引，冲突面收窄到单个座位。"""
    con = get_db()
    con.execute('BEGIN IMMEDIATE')
    try:
        clash = con.execute("SELECT 1 x FROM reservations WHERE session_id=? AND seat_label=? AND state='confirmed'",
                            (s['id'], seat)).fetchone()
        if clash:
            con.execute('ROLLBACK')
            return err(409, 'SEAT_TAKEN')
        con.execute("INSERT INTO holds(session_id,seat_label,user_name,state,idempotency_key,expires_at,created_at)"
                    " VALUES(?,?,?,'active',?,?,?)",
                    (s['id'], seat, user, key, expires, now_iso()))
        con.execute('COMMIT')
    except sqlite3.IntegrityError:
        con.execute('ROLLBACK')
        return err(409, 'SEAT_TAKEN')
    except Exception:
        con.execute('ROLLBACK')
        raise
    h = q1('SELECT * FROM holds WHERE idempotency_key=?', (key,))
    audit('hold', h['id'], 'create', {'session': s['id'], 'seat': seat, 'user': user})
    return 201, {'hold': dict(h)}

@route('POST', r'/api/holds/confirm')
def h_confirm(ctx):
    key = (ctx.body.get('idempotency_key') or '').strip()
    if not key:
        return err(400, 'MISSING_FIELDS')
    dup = q1('SELECT * FROM reservations WHERE idempotency_key=?', (key,))
    if dup:  # 重复回执：返回同一张票，不产生第二张
        return 200, {'reservation': dict(dup), 'idempotent': True}
    h = q1('SELECT * FROM holds WHERE idempotency_key=?', (key,))
    if not h:
        return err(404, 'HOLD_NOT_FOUND')
    if h['state'] != 'active':
        return err(409, 'HOLD_NOT_ACTIVE', state=h['state'])
    if h['expires_at'] < now_iso():
        run("UPDATE holds SET state='expired' WHERE id=?", (h['id'],))
        return err(410, 'HOLD_EXPIRED')
    con = get_db()
    con.execute('BEGIN IMMEDIATE')
    try:
        h2 = con.execute('SELECT * FROM holds WHERE id=?', (h['id'],)).fetchone()
        if h2['state'] != 'active' or h2['expires_at'] < now_iso():
            con.execute('ROLLBACK')
            return err(410, 'HOLD_EXPIRED')
        clash = con.execute("SELECT 1 x FROM reservations WHERE session_id=? AND seat_label=? AND state='confirmed'",
                            (h2['session_id'], h2['seat_label'])).fetchone()
        if clash:
            con.execute('ROLLBACK')
            return err(409, 'SEAT_TAKEN')
        seq = con.execute('SELECT COALESCE(MAX(confirm_seq),0)+1 s FROM reservations WHERE session_id=?',
                          (h2['session_id'],)).fetchone()['s']
        con.execute("UPDATE holds SET state='consumed' WHERE id=?", (h2['id'],))
        con.execute("""INSERT INTO reservations(session_id,seat_label,user_name,state,confirm_seq,idempotency_key,hold_id,created_at,updated_at)
                       VALUES(?,?,?,'confirmed',?,?,?,?,?)""",
                    (h2['session_id'], h2['seat_label'], h2['user_name'], seq, key, h2['id'], now_iso(), now_iso()))
        con.execute("""INSERT OR IGNORE INTO notifications(session_id,kind,recipient,payload,channel,state,dedupe_key,created_at)
                       VALUES(?, 'booking_confirmed', ?, ?, 'mock_local','pending', ?, ?)""",
                    (h2['session_id'], h2['user_name'],
                     json.dumps({'seat': h2['seat_label'], 'seq': seq}, ensure_ascii=False),
                     'notif:confirm:%s' % key, now_iso()))
        con.execute('COMMIT')
    except sqlite3.IntegrityError:
        con.execute('ROLLBACK')
        dup = q1('SELECT * FROM reservations WHERE idempotency_key=?', (key,))
        if dup:
            return 200, {'reservation': dict(dup), 'idempotent': True}
        return err(409, 'SEAT_TAKEN')
    except Exception:
        con.execute('ROLLBACK')
        raise
    r = q1('SELECT * FROM reservations WHERE idempotency_key=?', (key,))
    audit('reservation', r['id'], 'confirm', {'key': key, 'seat': r['seat_label']})
    return 201, {'reservation': dict(r)}

@route('POST', r'/api/holds/release')
def h_release(ctx):
    key = (ctx.body.get('idempotency_key') or '').strip()
    h = q1('SELECT * FROM holds WHERE idempotency_key=?', (key,))
    if not h:
        return err(404, 'HOLD_NOT_FOUND')
    if h['state'] == 'active':
        run("UPDATE holds SET state='released' WHERE id=?", (h['id'],))
    return 200, {'ok': True}

RISK_PROPOSAL = {'rain': 'postpone', 'heavy_rain': 'cancel', 'gale': 'cancel', 'storm': 'cancel'}

@route('POST', r'/api/weather/ingest')
def h_wx_ingest(ctx):
    """模拟天气数据源。只生成「待决定」预案；取消/驳回后的迟到更新记为 superseded，不动公开状态。"""
    b = ctx.body
    sid = b.get('session_id')
    observed = (b.get('observed_at') or '').strip()
    risk = (b.get('risk') or '').strip()
    source = (b.get('source') or 'sim-feed').strip()
    s = q1('SELECT * FROM sessions WHERE id=?', (sid,))
    if not s:
        return err(404, 'NOT_FOUND')
    if not observed or not risk:
        return err(400, 'MISSING_FIELDS')
    parse_iso(observed)  # 校验可解析
    if risk in ('none', 'clear'):
        return 200, {'created': False, 'reason': 'no_risk'}
    dedupe = 'wx:%s:%s:%s' % (sid, observed, risk)
    existing = q1('SELECT * FROM weather_plans WHERE dedupe_key=?', (dedupe,))
    if existing:
        return 200, {'created': False, 'plan': dict(existing), 'idempotent': True}
    proposal = RISK_PROPOSAL.get(risk, 'postpone')
    state, reason = 'pending', None
    if s['status'] == 'cancelled':
        state, reason = 'superseded', 'session_already_cancelled'
    else:
        decided = q1("""SELECT * FROM weather_plans WHERE session_id=? AND state IN ('confirmed','rejected')
                        ORDER BY observed_at DESC, id DESC LIMIT 1""", (sid,))
        if decided and observed <= decided['observed_at']:
            state, reason = 'superseded', 'late_update_after_decision'
    cur = run("""INSERT INTO weather_plans(session_id,source,observed_at,risk,proposal,state,dedupe_key,created_at)
                 VALUES(?,?,?,?,?,?,?,?)""",
              (sid, source, observed, risk, proposal, state, dedupe, now_iso()))
    plan = q1('SELECT * FROM weather_plans WHERE id=?', (cur.lastrowid,))
    if state == 'pending':
        enqueue_notif('weather_plan_pending', 'operations',
                      {'session': s['public_code'], 'risk': risk, 'proposal': proposal, 'plan_id': plan['id']},
                      session_id=sid, dedupe_key='notif:%s' % dedupe)
    audit('weather_plan', plan['id'], 'ingest', {'state': state, 'reason': reason, 'risk': risk})
    return 200, {'created': True, 'plan': dict(plan), 'reason': reason}

# ---------------- 后台接口 ----------------
def check_version(s, b):
    ev = b.get('expected_version')
    if ev is not None and int(ev) != s['version']:
        return err(409, 'STALE_VERSION', current_version=s['version'])
    return None

@route('POST', r'/api/admin/films')
def h_film_create(ctx):
    b = ctx.body
    title = (b.get('title') or '').strip()
    try:
        dur = int(b.get('duration_min'))
        assert dur > 0
    except Exception:
        return err(400, 'BAD_DURATION')
    if not title:
        return err(400, 'MISSING_FIELDS')
    cur = run('INSERT INTO films(title,duration_min,synopsis,rating,palette) VALUES(?,?,?,?,?)',
              (title, dur, b.get('synopsis') or '', b.get('rating') or '普', b.get('palette') or '#f5b942'))
    audit('film', cur.lastrowid, 'create', {'title': title})
    return 201, {'film': dict(q1('SELECT * FROM films WHERE id=?', (cur.lastrowid,)))}

@route('POST', r'/api/admin/venues')
def h_venue_create(ctx):
    b = ctx.body
    name = (b.get('name') or '').strip()
    try:
        rows, cols = int(b.get('rows')), int(b.get('cols'))
    except Exception:
        return err(400, 'BAD_VENUE')
    if not name or rows < 1 or cols < 1 or rows > 26:
        return err(400, 'BAD_VENUE', detail='rows 1..26, cols >= 1')
    cur = run('INSERT INTO venues(name,location,rows,cols,capacity) VALUES(?,?,?,?,?)',
              (name, b.get('location') or '', rows, cols, rows * cols))
    audit('venue', cur.lastrowid, 'create', {'name': name})
    return 201, {'venue': dict(q1('SELECT * FROM venues WHERE id=?', (cur.lastrowid,)))}

def gen_public_code(start_dt):
    prefix = 'EV-%s' % start_dt.strftime('%Y%m%d')
    n = q1('SELECT COUNT(*) c FROM sessions WHERE public_code LIKE ?', (prefix + '-%',))['c'] + 1
    code = '%s-%03d' % (prefix, n)
    while q1('SELECT 1 x FROM sessions WHERE public_code=?', (code,)):
        n += 1
        code = '%s-%03d' % (prefix, n)
    return code

@route('POST', r'/api/admin/sessions')
def h_session_create(ctx):
    b = ctx.body
    film = q1('SELECT * FROM films WHERE id=?', (b.get('film_id'),))
    venue = q1('SELECT * FROM venues WHERE id=?', (b.get('venue_id'),))
    if not film or not venue:
        return err(400, 'BAD_REF', detail='film_id / venue_id 无效')
    start = parse_iso(b.get('start_time'))
    end = start + timedelta(minutes=film['duration_min'] + SETUP_BUFFER_MIN)
    try:
        cap = int(b.get('capacity') or venue['capacity'])
    except Exception:
        cap = venue['capacity']
    cap = max(1, min(cap, venue['capacity']))
    conflicts = venue_conflicts(venue['id'], to_iso(start), to_iso(end))
    if conflicts:
        return err(409, 'VENUE_CONFLICT', conflicts=[dict(c) for c in conflicts])
    code = gen_public_code(start)
    cur = run("""INSERT INTO sessions(public_code,film_id,venue_id,start_time,end_time,original_start_time,capacity,status,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,'scheduled',?,?)""",
              (code, film['id'], venue['id'], to_iso(start), to_iso(end), to_iso(start), cap, now_iso(), now_iso()))
    audit('session', cur.lastrowid, 'create', {'code': code})
    return 201, {'session': session_view(q1('SELECT * FROM sessions WHERE id=?', (cur.lastrowid,)))}

@route('POST', r'/api/admin/sessions/(\d+)/reschedule')
def h_reschedule(ctx, sid):
    s = q1('SELECT * FROM sessions WHERE id=?', (int(sid),))
    if not s:
        return err(404, 'NOT_FOUND')
    if s['status'] == 'cancelled':
        return err(409, 'SESSION_CANCELLED')
    vc = check_version(s, ctx.body)
    if vc:
        return vc
    policy = ctx.body.get('ticket_policy') or 'migrate'
    if policy not in ('migrate', 'rebook'):
        return err(400, 'BAD_POLICY', detail='ticket_policy ∈ {migrate, rebook}')
    new_start = parse_iso(ctx.body.get('new_start_time'))
    res, conflicts = reschedule_session_tx(s, new_start, policy, reason='manual',
                                           note=ctx.body.get('note') or '',
                                           operator=ctx.body.get('operator') or 'admin')
    if conflicts:
        return err(409, 'VENUE_CONFLICT', conflicts=[dict(c) for c in conflicts])
    return 200, {'session': session_view(q1('SELECT * FROM sessions WHERE id=?', (s['id'],))), 'result': res}

@route('POST', r'/api/admin/sessions/(\d+)/freeze')
def h_freeze(ctx, sid):
    s = q1('SELECT * FROM sessions WHERE id=?', (int(sid),))
    if not s:
        return err(404, 'NOT_FOUND')
    vc = check_version(s, ctx.body)
    if vc:
        return vc
    frozen = 1 if ctx.body.get('frozen') else 0
    run('UPDATE sessions SET booking_frozen=?, version=version+1, updated_at=? WHERE id=?',
        (frozen, now_iso(), s['id']))
    audit('session', sid, 'freeze' if frozen else 'unfreeze', {})
    return 200, {'session': session_view(q1('SELECT * FROM sessions WHERE id=?', (s['id'],)))}

@route('POST', r'/api/admin/sessions/(\d+)/capacity')
def h_capacity(ctx, sid):
    """缩减容量：保留原确认顺序（confirm_seq 升序保留前 N），溢出者列入待处置名单，绝不随机撤销。"""
    s = q1('SELECT * FROM sessions WHERE id=?', (int(sid),))
    if not s:
        return err(404, 'NOT_FOUND')
    vc = check_version(s, ctx.body)
    if vc:
        return vc
    if ctx.body.get('new_capacity') is None:
        return err(400, 'MISSING_FIELDS')
    venue = q1('SELECT * FROM venues WHERE id=?', (s['venue_id'],))
    new_cap = int(ctx.body.get('new_capacity'))
    if new_cap < 0 or new_cap > venue['capacity']:
        return err(400, 'BAD_CAPACITY', detail='0 .. 场地容量 %d' % venue['capacity'])
    confirmed = q("SELECT * FROM reservations WHERE session_id=? AND state='confirmed' ORDER BY confirm_seq ASC",
                  (s['id'],))
    displaced = confirmed[new_cap:] if new_cap < len(confirmed) else []
    allowed = set(seat_labels(venue['rows'], venue['cols'])[:new_cap])
    con = get_db()
    con.execute('BEGIN IMMEDIATE')
    try:
        con.execute('UPDATE sessions SET capacity=?, version=version+1, updated_at=? WHERE id=?',
                    (new_cap, now_iso(), s['id']))
        for r in displaced:
            con.execute("UPDATE reservations SET state='displaced', updated_at=? WHERE id=?", (now_iso(), r['id']))
        if new_cap < s['capacity']:
            for h in q("SELECT * FROM holds WHERE session_id=? AND state='active'", (s['id'],)):
                if h['seat_label'] not in allowed:
                    con.execute("UPDATE holds SET state='released' WHERE id=?", (h['id'],))
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    for r in displaced:
        enqueue_notif('seat_displaced', r['user_name'],
                      {'session': s['public_code'], 'seat': r['seat_label'],
                       'confirm_seq': r['confirm_seq'], 'new_capacity': new_cap},
                      session_id=s['id'], dedupe_key='notif:disp:%s' % r['id'])
    audit('session', sid, 'capacity_reduce' if new_cap < s['capacity'] else 'capacity_change',
          {'old': s['capacity'], 'new': new_cap, 'displaced': [r['user_name'] for r in displaced]})
    return 200, {'session': session_view(q1('SELECT * FROM sessions WHERE id=?', (s['id'],))),
                 'displaced': [{'user': r['user_name'], 'seat': r['seat_label'], 'confirm_seq': r['confirm_seq']}
                               for r in displaced],
                 'policy': 'keep_earliest_confirmed'}

@route('POST', r'/api/admin/sessions/(\d+)/cancel')
def h_cancel(ctx, sid):
    s = q1('SELECT * FROM sessions WHERE id=?', (int(sid),))
    if not s:
        return err(404, 'NOT_FOUND')
    vc = check_version(s, ctx.body)
    if vc:
        return vc
    if s['status'] == 'cancelled':
        return 200, {'session': session_view(s), 'idempotent': True}
    affected = cancel_session_tx(s, ctx.body.get('reason') or 'manual', ctx.body.get('operator') or 'admin')
    return 200, {'session': session_view(q1('SELECT * FROM sessions WHERE id=?', (s['id'],))),
                 'affected': len(affected)}

@route('GET', r'/api/admin/sessions/(\d+)/reservations')
def h_res_list(ctx, sid):
    rows = q('SELECT * FROM reservations WHERE session_id=? ORDER BY confirm_seq', (int(sid),))
    holds = q('SELECT * FROM holds WHERE session_id=? ORDER BY id DESC LIMIT 50', (int(sid),))
    return 200, {'reservations': [dict(r) for r in rows], 'holds': [dict(h) for h in holds]}

@route('GET', r'/api/admin/weather-plans')
def h_wx_list(ctx):
    state = (ctx.query.get('state') or [None])[0]
    rows = q('SELECT * FROM weather_plans WHERE state=? ORDER BY id DESC', (state,)) if state \
        else q('SELECT * FROM weather_plans ORDER BY id DESC')
    out = []
    for p in rows:
        d = dict(p)
        s = q1('SELECT public_code FROM sessions WHERE id=?', (p['session_id'],))
        d['session_code'] = s['public_code'] if s else None
        out.append(d)
    return 200, {'plans': out}

@route('POST', r'/api/admin/weather-plans/(\d+)/decide')
def h_wx_decide(ctx, pid):
    """运营确认：只有这里才改变公开状态。"""
    p = q1('SELECT * FROM weather_plans WHERE id=?', (int(pid),))
    if not p:
        return err(404, 'NOT_FOUND')
    if p['state'] != 'pending':
        return err(409, 'PLAN_ALREADY_DECIDED', state=p['state'])
    b = ctx.body
    decision = b.get('decision')
    operator = b.get('operator') or 'ops'
    s = q1('SELECT * FROM sessions WHERE id=?', (p['session_id'],))
    if decision == 'reject':
        run("UPDATE weather_plans SET state='rejected', decided_by=?, decided_at=? WHERE id=?",
            (operator, now_iso(), p['id']))
        audit('weather_plan', p['id'], 'reject', {'by': operator})
        return 200, {'plan': dict(q1('SELECT * FROM weather_plans WHERE id=?', (p['id'],)))}
    if decision != 'confirm':
        return err(400, 'BAD_DECISION')
    action = b.get('action') or ('cancel' if p['proposal'] == 'cancel' else 'postpone')
    if action == 'cancel':
        run("UPDATE weather_plans SET state='confirmed', decided_by=?, decided_at=? WHERE id=?",
            (operator, now_iso(), p['id']))
        affected = cancel_session_tx(s, 'weather:%s' % p['risk'], operator, weather_state='cancelled_by_weather')
        return 200, {'ok': True, 'action': 'cancel', 'affected': len(affected)}
    # postpone：按小时顺延，老票自动迁移；改期过程同样冻结新报名
    try:
        hours = float(b.get('postpone_hours') or 2)
    except Exception:
        return err(400, 'BAD_HOURS')
    new_start = parse_iso(s['start_time']) + timedelta(hours=hours)
    res, conflicts = reschedule_session_tx(s, new_start, 'migrate', reason='weather',
                                           note='天气预案 #%d' % p['id'], operator=operator)
    if conflicts:
        return err(409, 'VENUE_CONFLICT', conflicts=[dict(c) for c in conflicts])
    run("UPDATE weather_plans SET state='confirmed', decided_by=?, decided_at=? WHERE id=?",
        (operator, now_iso(), p['id']))
    run("UPDATE sessions SET weather_state='postponed_by_weather', version=version+1 WHERE id=?", (s['id'],))
    return 200, {'ok': True, 'action': 'postpone', 'result': res}

@route('GET', r'/api/admin/notifications')
def h_notifs(ctx):
    state = (ctx.query.get('state') or [None])[0]
    if state:
        rows = q('SELECT * FROM notifications WHERE state=? ORDER BY id DESC LIMIT 200', (state,))
    else:
        rows = q('SELECT * FROM notifications ORDER BY id DESC LIMIT 200')
    return 200, {'notifications': [dict(r) for r in rows]}

@route('POST', r'/api/admin/notifications/drain')
def h_drain(ctx):
    """投递待发送任务到本地模拟渠道（写 data/mock_channel.log），可重复执行不重复投递。"""
    pending = q("SELECT * FROM notifications WHERE state='pending' ORDER BY id")
    sent = []
    for n in pending:
        line = json.dumps({'id': n['id'], 'kind': n['kind'], 'recipient': n['recipient'],
                           'channel': 'mock_local', 'payload': json.loads(n['payload']),
                           'sent_at': now_iso()}, ensure_ascii=False)
        with open(MOCK_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
        run("UPDATE notifications SET state='sent', attempts=attempts+1, sent_at=? WHERE id=? AND state='pending'",
            (now_iso(), n['id']))
        sent.append(n['id'])
    return 200, {'sent': len(sent), 'ids': sent}

@route('GET', r'/api/admin/mock-channel')
def h_mock(ctx):
    msgs = []
    if os.path.exists(MOCK_LOG):
        with open(MOCK_LOG, encoding='utf-8') as f:
            msgs = [json.loads(l) for l in f if l.strip()][-200:]
    return 200, {'messages': msgs}

@route('GET', r'/api/admin/audit')
def h_audit(ctx):
    return 200, {'audit': [dict(r) for r in q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')]}

# ---------------- 请求分发 ----------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj, ctype='application/json; charset=utf-8'):
        if isinstance(obj, (dict, list)):
            data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        elif isinstance(obj, bytes):
            data = obj
        else:
            data = str(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _dispatch(self, method):
        u = urlparse(self.path)
        path = u.path
        if path.startswith('/api/'):
            body = {}
            if method in ('POST', 'PUT', 'PATCH'):
                n = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(n) if n else b''
                try:
                    body = json.loads(raw.decode('utf-8') or '{}')
                except Exception:
                    return self._send(400, {'error': 'BAD_JSON'})
            ctx = Ctx(body, parse_qs(u.query))
            for m, rx, fn in ROUTES:
                if m != method:
                    continue
                mt = rx.match(path)
                if not mt:
                    continue
                try:
                    code, obj = fn(ctx, *mt.groups())
                except ValueError as e:
                    code, obj = 400, {'error': 'BAD_REQUEST', 'detail': str(e)}
                except Exception as e:
                    code, obj = 500, {'error': 'INTERNAL', 'detail': str(e)}
                return self._send(code, obj)
            return self._send(404, {'error': 'NOT_FOUND'})
        if path == '/':
            path = '/index.html'
        elif path == '/admin':
            path = '/admin.html'
        elif path == '/design':
            path = '/design.html'
        safe = os.path.normpath(path).lstrip('/\\')
        fp = os.path.join(STATIC_DIR, safe)
        if not fp.startswith(STATIC_DIR) or not os.path.isfile(fp):
            return self._send(404, {'error': 'NOT_FOUND'})
        ctype = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
                 '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
                 '.svg': 'image/svg+xml'}.get(os.path.splitext(fp)[1], 'application/octet-stream')
        with open(fp, 'rb') as f:
            data = f.read()
        self._send(200, data, ctype)

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

# ---------------- 种子数据 ----------------
def seed():
    if q1('SELECT COUNT(*) c FROM films')['c']:
        return
    f1 = run("INSERT INTO films(title,duration_min,synopsis,rating,palette) VALUES(?,?,?,?,?)",
             ('海上钢琴师', 165, '弗吉尼亚号上的无名钢琴师，一生未曾踏上陆地。', '普', '#7fb3d5')).lastrowid
    f2 = run("INSERT INTO films(title,duration_min,synopsis,rating,palette) VALUES(?,?,?,?,?)",
             ('天堂电影院', 155, '西西里小镇的放映室，收藏了一代人的夏天。', '普', '#f5b942')).lastrowid
    f3 = run("INSERT INTO films(title,duration_min,synopsis,rating,palette) VALUES(?,?,?,?,?)",
             ('菊次郎的夏天', 121, '一个男孩和一个大叔的夏日公路。', '普', '#9ece6a')).lastrowid
    v1 = run("INSERT INTO venues(name,location,rows,cols,capacity) VALUES('滨江草坪','东岸滨江公园 B 区',4,8,32)").lastrowid
    v2 = run("INSERT INTO venues(name,location,rows,cols,capacity) VALUES('老厂房天台','纺织谷 7 号楼顶',3,6,18)").lastrowid

    def mk(film_id, venue_id, start, cap, status='scheduled'):
        dur = q1('SELECT duration_min d FROM films WHERE id=?', (film_id,))['d']
        st = parse_iso(start)
        en = st + timedelta(minutes=dur + SETUP_BUFFER_MIN)
        code = gen_public_code(st)
        cur = run("""INSERT INTO sessions(public_code,film_id,venue_id,start_time,end_time,original_start_time,capacity,status,created_at,updated_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?)""",
                  (code, film_id, venue_id, to_iso(st), to_iso(en), to_iso(st), cap, status, now_iso(), now_iso()))
        return cur.lastrowid

    a = mk(f1, v1, '2026-10-01T19:30', 32)
    b = mk(f2, v2, '2026-10-02T18:30', 18)
    # B 改期一日：同一活动，身份不变，老票迁移
    dur2 = q1('SELECT duration_min d FROM films WHERE id=?', (f2,))['d']
    new_st_dt = parse_iso('2026-10-03T19:30')
    run("UPDATE sessions SET start_time=?, end_time=?, reschedule_count=1, version=version+1 WHERE id=?",
        (to_iso(new_st_dt), to_iso(new_st_dt + timedelta(minutes=dur2 + SETUP_BUFFER_MIN)), b))
    run("""INSERT INTO schedule_history(session_id,old_start,new_start,ticket_policy,reason,note,created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (b, to_iso(parse_iso('2026-10-02T18:30')), to_iso(new_st_dt), 'migrate', 'manual',
         '与滨江市集档期冲突，顺延一日；已购票观众自动迁移。', now_iso()))
    mk(f3, v1, '2026-10-04T20:00', 32, status='cancelled')  # C 已取消
    d = mk(f1, v2, '2026-10-05T19:30', 2)                  # D 满额演示
    for i, (u, seat) in enumerate((('林晚', 'A1'), ('陈默', 'A2')), start=1):
        run("""INSERT INTO reservations(session_id,seat_label,user_name,state,confirm_seq,idempotency_key,created_at,updated_at)
               VALUES(?,?,?,'confirmed',?,?,?,?)""",
            (d, seat, u, i, 'seed-full-%d' % i, now_iso(), now_iso()))
    # A 待决定天气预案：公开状态不变，待运营确认
    run("""INSERT INTO weather_plans(session_id,source,observed_at,risk,proposal,state,dedupe_key,created_at)
           VALUES(?,?,?,?,?,'pending',?,?)""",
        (a, 'sim-feed', '2026-09-30T08:00', 'rain', 'postpone', 'wx:%d:2026-09-30T08:00:rain' % a, now_iso()))
    pid = q1('SELECT MAX(id) m FROM weather_plans')['m']
    enqueue_notif('weather_plan_pending', 'operations',
                  {'session': 'EV-20261001-001', 'risk': 'rain', 'proposal': 'postpone', 'plan_id': pid},
                  session_id=a, dedupe_key='notif:seed-wx')

# ---------------- 入口 ----------------
def main():
    port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else int(os.environ.get('PORT', '8000'))
    get_db().executescript(SCHEMA)
    seed()
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print('露天电影排片系统  http://127.0.0.1:%d  (strategy=%s, hold_ttl=%ss)' % (port, STRATEGY, HOLD_TTL))
    print('  前台 /  后台 /admin  设计说明 /design')
    srv.serve_forever()

if __name__ == '__main__':
    main()
