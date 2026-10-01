#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收测试：最后席位竞争 / 重复回执 / 预留超时 / 改期身份与冻结 / 容量缩减保序 /
场地冲突 / 天气双人确认与迟到更新 / 通知中心模拟渠道 / 版本守卫 / 锁策略对比。
运行：python3 tests/test_all.py
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'server.py')
REPORT = os.path.join(ROOT, 'static', 'strategy_report.json')

def http(port, method, path, body=None):
    url = 'http://127.0.0.1:%d%s' % (port, path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or '{}')
        except Exception:
            return e.code, {'raw': raw}

class Server:
    def __init__(self, port, strategy='seat'):
        self.port = port
        self.dir = tempfile.mkdtemp(prefix='cinema-it-')
        env = dict(os.environ, CINEMA_DATA_DIR=self.dir, BOOKING_STRATEGY=strategy)
        self.proc = subprocess.Popen([sys.executable, SERVER, '--port', str(port)],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        ok = False
        for _ in range(60):
            if self.proc.poll() is not None:
                break
            try:
                s, d = http(port, 'GET', '/api/health')
                if s == 200:
                    ok = True
                    break
            except Exception:
                pass
            time.sleep(0.15)
        if not ok:
            out = ''
            try:
                out = self.proc.stdout.read() if self.proc.stdout else ''
            except Exception:
                pass
            self.stop()
            raise RuntimeError('server failed to start\n' + out)

    def stop(self):
        try:
            self.proc.terminate(); self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        try:
            if self.proc.stdout:
                self.proc.stdout.close()
        except Exception:
            pass
        shutil.rmtree(self.dir, ignore_errors=True)

def make_session(port, cap=4, rows=1, cols=4, start='2026-11-01T19:30', dur=100):
    s, f = http(port, 'POST', '/api/admin/films', {'title': '测试片', 'duration_min': dur})
    fid = f['film']['id']
    s, v = http(port, 'POST', '/api/admin/venues', {'name': '测试场', 'rows': rows, 'cols': cols})
    vid = v['venue']['id']
    s, d = http(port, 'POST', '/api/admin/sessions',
                {'film_id': fid, 'venue_id': vid, 'start_time': start, 'capacity': cap})
    assert s == 201, d
    return d['session']['id'], vid

def book(port, sid, seat, user, key):
    st, d = http(port, 'POST', '/api/sessions/%d/holds' % sid,
                 {'seat': seat, 'user': user, 'idempotency_key': key})
    assert st == 201, (st, d)
    st, d = http(port, 'POST', '/api/holds/confirm', {'idempotency_key': key})
    assert st == 201, (st, d)
    return d['reservation']

class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = Server(8171, 'seat')
        cls.port = 8171

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_01_seed_badges_visible_in_list(self):
        """列表直接显示改期、取消、满额、预案待决。"""
        s, d = http(self.port, 'GET', '/api/sessions')
        self.assertEqual(s, 200)
        statuses = [x['display_status'] for x in d['sessions']]
        self.assertIn('cancelled', statuses, '应存在已取消场次')
        self.assertIn('full', statuses, '应存在满额场次')
        self.assertTrue(any(x['rescheduled'] for x in d['sessions']), '应存在改期场次')
        self.assertTrue(any(x['pending_weather_plan'] for x in d['sessions']), '应存在待决预案')

    def test_02_last_seat_contention_and_duplicate_receipt(self):
        """最后席位竞争：8 线程抢 1 座，恰好 1 个赢家；重复回执返回同一张票。"""
        sid, _ = make_session(self.port, cap=1, rows=1, cols=1)
        results = []
        def w(i):
            st, d = http(self.port, 'POST', '/api/sessions/%d/holds' % sid,
                         {'seat': 'A1', 'user': '竞者%d' % i, 'idempotency_key': 'race-%d' % i})
            results.append(st)
        ts = [threading.Thread(target=w, args=(i,)) for i in range(8)]
        for t in ts: t.start()
        for t in ts: t.join()
        self.assertEqual(results.count(201), 1, results)
        self.assertEqual(results.count(409), 7, results)
        # 确认：只有赢家的 key 能出票
        winner_key, winner_res = None, None
        for i in range(8):
            st, d = http(self.port, 'POST', '/api/holds/confirm', {'idempotency_key': 'race-%d' % i})
            if st == 201:
                winner_key, winner_res = 'race-%d' % i, d['reservation']
            else:
                self.assertIn(st, (404, 409, 410))
        self.assertIsNotNone(winner_res)
        # 重复回执：同 key 再确认 → 同一张票，不产生第二张
        st, d2 = http(self.port, 'POST', '/api/holds/confirm', {'idempotency_key': winner_key})
        self.assertEqual(st, 200)
        self.assertTrue(d2.get('idempotent'))
        self.assertEqual(d2['reservation']['id'], winner_res['id'])
        # 确认通知只有一条（dedupe）
        s, n = http(self.port, 'GET', '/api/admin/notifications')
        ded = [x for x in n['notifications'] if x.get('dedupe_key') == 'notif:confirm:%s' % winner_key]
        self.assertEqual(len(ded), 1)
        # 列表显示满额
        s, lst = http(self.port, 'GET', '/api/sessions')
        sess = [x for x in lst['sessions'] if x['id'] == sid][0]
        self.assertEqual(sess['display_status'], 'full')

    def test_03_hold_timeout(self):
        """预留超时：超时确认 410，座位回到可选池。"""
        sid, _ = make_session(self.port, cap=2, rows=1, cols=2, start='2026-11-02T19:30')
        st, d = http(self.port, 'POST', '/api/sessions/%d/holds' % sid,
                     {'seat': 'A1', 'user': '临时', 'idempotency_key': 'ttl-1', 'ttl_seconds': 1})
        self.assertEqual(st, 201)
        time.sleep(1.4)
        st, d = http(self.port, 'POST', '/api/holds/confirm', {'idempotency_key': 'ttl-1'})
        self.assertEqual(st, 410, d)
        st, d = http(self.port, 'GET', '/api/sessions/%d' % sid)
        seat = [x for x in d['seats'] if x['label'] == 'A1'][0]
        self.assertEqual(seat['state'], 'free')

    def test_04_reschedule_identity_freeze_and_migrate(self):
        """改期是同一活动的新安排：身份不变、老票迁移、改期过程冻结新报名。"""
        sid, _ = make_session(self.port, cap=3, rows=1, cols=3, start='2026-11-03T19:30')
        r1 = book(self.port, sid, 'A1', '老票观众', 'rs-1')
        st, before = http(self.port, 'GET', '/api/sessions/%d' % sid)
        code, ver = before['public_code'], before['version']
        # 过期版本写 → 409
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/reschedule' % sid,
                     {'new_start_time': '2026-11-04T20:00', 'ticket_policy': 'migrate',
                      'expected_version': ver + 9})
        self.assertEqual(st, 409)
        self.assertEqual(d['error'], 'STALE_VERSION')
        self.assertEqual(d['current_version'], ver)
        # 正确版本改期
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/reschedule' % sid,
                     {'new_start_time': '2026-11-04T20:00', 'ticket_policy': 'migrate',
                      'expected_version': ver})
        self.assertEqual(st, 200, d)
        s2 = d['session']
        self.assertEqual(s2['id'], sid, '改期不得重新生成活动')
        self.assertEqual(s2['public_code'], code, '场次身份不变，原预约不失联')
        self.assertEqual(s2['reschedule_count'], 1)
        self.assertEqual(s2['display_status'], 'frozen', '改期过程应冻结报名')
        # 冻结期间新报名被拒
        st, d = http(self.port, 'POST', '/api/sessions/%d/holds' % sid,
                     {'seat': 'A2', 'user': '新报名', 'idempotency_key': 'rs-2'})
        self.assertEqual(st, 409)
        self.assertEqual(d['error'], 'BOOKING_FROZEN')
        # 老票已迁移（仍 confirmed，挂在同一活动上）
        st, rr = http(self.port, 'GET', '/api/admin/sessions/%d/reservations' % sid)
        r = [x for x in rr['reservations'] if x['id'] == r1['id']][0]
        self.assertEqual(r['state'], 'confirmed')
        # 解冻后恢复报名
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/freeze' % sid,
                     {'frozen': False, 'expected_version': cur['version']})
        self.assertEqual(st, 200)
        st, d = http(self.port, 'POST', '/api/sessions/%d/holds' % sid,
                     {'seat': 'A2', 'user': '新报名', 'idempotency_key': 'rs-2'})
        self.assertEqual(st, 201)

    def test_05_reschedule_rebook_policy(self):
        """rebook 政策：确认票转待重订并通知，不丢记录。"""
        sid, _ = make_session(self.port, cap=2, rows=1, cols=2, start='2026-11-05T19:30')
        book(self.port, sid, 'A1', '重订观众', 'rb-1')
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/reschedule' % sid,
                     {'new_start_time': '2026-11-06T20:00', 'ticket_policy': 'rebook',
                      'expected_version': cur['version']})
        self.assertEqual(st, 200, d)
        st, rr = http(self.port, 'GET', '/api/admin/sessions/%d/reservations' % sid)
        self.assertEqual(rr['reservations'][0]['state'], 'rebook_pending')
        s, n = http(self.port, 'GET', '/api/admin/notifications')
        self.assertTrue(any(x['kind'] == 'rebook_required' for x in n['notifications']))

    def test_06_capacity_reduction_keeps_confirm_order(self):
        """缩减容量：保留原确认顺序，溢出者列入待处置名单，不随机撤销。"""
        sid, _ = make_session(self.port, cap=5, rows=1, cols=5, start='2026-11-07T19:30')
        for i in range(5):
            book(self.port, sid, 'A%d' % (i + 1), '观众%d' % i, 'cap-%d' % i)
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        self.assertEqual(cur['display_status'], 'full')
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/capacity' % sid,
                     {'new_capacity': 3, 'expected_version': cur['version']})
        self.assertEqual(st, 200, d)
        names = [x['user'] for x in d['displaced']]
        self.assertEqual(names, ['观众3', '观众4'], '应按确认顺序溢出最末两人')
        self.assertEqual([x['confirm_seq'] for x in d['displaced']], [4, 5])
        st, rr = http(self.port, 'GET', '/api/admin/sessions/%d/reservations' % sid)
        states = {r['user_name']: r['state'] for r in rr['reservations']}
        self.assertEqual(states['观众0'], 'confirmed')
        self.assertEqual(states['观众2'], 'confirmed')
        self.assertEqual(states['观众3'], 'displaced')
        self.assertEqual(states['观众4'], 'displaced')
        s, n = http(self.port, 'GET', '/api/admin/notifications')
        disp = [x for x in n['notifications'] if x['kind'] == 'seat_displaced']
        self.assertEqual(len(disp), 2)

    def test_07_venue_conflict(self):
        """场地冲突：重叠时段建场与改期均被拒。"""
        s, f = http(self.port, 'POST', '/api/admin/films', {'title': '冲突片', 'duration_min': 120})
        fid = f['film']['id']
        s, v = http(self.port, 'POST', '/api/admin/venues', {'name': '唯一草坪', 'rows': 2, 'cols': 4})
        vid = v['venue']['id']
        st, d1 = http(self.port, 'POST', '/api/admin/sessions',
                      {'film_id': fid, 'venue_id': vid, 'start_time': '2026-11-08T19:00'})
        self.assertEqual(st, 201)  # 19:00-21:30（含 30min 缓冲）
        st, d2 = http(self.port, 'POST', '/api/admin/sessions',
                      {'film_id': fid, 'venue_id': vid, 'start_time': '2026-11-08T20:30'})
        self.assertEqual(st, 409)
        self.assertEqual(d2['error'], 'VENUE_CONFLICT')
        self.assertEqual(d2['conflicts'][0]['public_code'], d1['session']['public_code'])
        st, d3 = http(self.port, 'POST', '/api/admin/sessions',
                      {'film_id': fid, 'venue_id': vid, 'start_time': '2026-11-08T22:00'})
        self.assertEqual(st, 201, d3)  # 不重叠：允许
        # 改期撞车同样被拒
        st, d = http(self.port, 'POST', '/api/admin/sessions/%d/reschedule' % d3['session']['id'],
                     {'new_start_time': '2026-11-08T20:00', 'ticket_policy': 'migrate',
                      'expected_version': d3['session']['version']})
        self.assertEqual(st, 409)
        self.assertEqual(d['error'], 'VENUE_CONFLICT')

    def test_08_weather_two_phase_and_late_update_after_cancel(self):
        """天气数据只触发待决定预案；运营确认才改变公开状态；取消后迟到更新不生效。"""
        sid, _ = make_session(self.port, cap=2, rows=1, cols=2, start='2026-11-09T19:30')
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-09T12:00', 'risk': 'heavy_rain'})
        self.assertTrue(d['created'])
        self.assertEqual(d['plan']['state'], 'pending')
        pid = d['plan']['id']
        # 公开状态未变
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        self.assertEqual(cur['status'], 'scheduled')
        self.assertEqual(cur['display_status'], 'open')
        # 运营确认取消 → 公开状态才改变
        st, d = http(self.port, 'POST', '/api/admin/weather-plans/%d/decide' % pid,
                     {'decision': 'confirm', 'action': 'cancel', 'operator': '老王'})
        self.assertEqual(st, 200, d)
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        self.assertEqual(cur['display_status'], 'cancelled')
        # 迟到更新（更早观测）→ superseded，不回溯
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-09T11:00', 'risk': 'rain'})
        self.assertEqual(d['plan']['state'], 'superseded')
        # 更晚更新 → 仍 superseded（场次已取消）
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-09T13:00', 'risk': 'gale'})
        self.assertEqual(d['plan']['state'], 'superseded')
        self.assertEqual(d['reason'], 'session_already_cancelled')
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        self.assertEqual(cur['display_status'], 'cancelled')
        # 同一数据重复注入 → 幂等去重
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-09T12:00', 'risk': 'heavy_rain'})
        self.assertFalse(d['created'])
        self.assertTrue(d['idempotent'])

    def test_09_weather_reject_then_late_update(self):
        """驳回后迟到更新记 superseded，场次继续售票。"""
        sid, _ = make_session(self.port, cap=2, rows=1, cols=2, start='2026-11-10T19:30')
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-10T12:00', 'risk': 'rain'})
        pid = d['plan']['id']
        st, d = http(self.port, 'POST', '/api/admin/weather-plans/%d/decide' % pid,
                     {'decision': 'reject', 'operator': '老王'})
        self.assertEqual(st, 200)
        self.assertEqual(d['plan']['state'], 'rejected')
        st, d = http(self.port, 'POST', '/api/weather/ingest',
                     {'session_id': sid, 'observed_at': '2026-11-10T11:30', 'risk': 'heavy_rain'})
        self.assertEqual(d['plan']['state'], 'superseded')
        self.assertEqual(d['reason'], 'late_update_after_decision')
        st, cur = http(self.port, 'GET', '/api/sessions/%d' % sid)
        self.assertEqual(cur['display_status'], 'open')

    def test_10_notification_center_mock_channel(self):
        """通知中心：待发送任务 → 本地模拟渠道投递 → 重复投递为空。"""
        sid, _ = make_session(self.port, cap=2, rows=1, cols=2, start='2026-11-11T19:30')
        book(self.port, sid, 'A1', '通知用户', 'nt-1')
        st, n = http(self.port, 'GET', '/api/admin/notifications?state=pending')
        self.assertGreater(len(n['notifications']), 0)
        st, d = http(self.port, 'POST', '/api/admin/notifications/drain', {})
        self.assertGreaterEqual(d['sent'], 1)
        st, m = http(self.port, 'GET', '/api/admin/mock-channel')
        kinds = [x['kind'] for x in m['messages']]
        self.assertIn('booking_confirmed', kinds)
        # 重复投递：无待发送 → 0
        st, d2 = http(self.port, 'POST', '/api/admin/notifications/drain', {})
        self.assertEqual(d2['sent'], 0)
        # 渠道消息数不变
        st, m2 = http(self.port, 'GET', '/api/admin/mock-channel')
        self.assertEqual(len(m2['messages']), len(m['messages']))

class StrategyCompare(unittest.TestCase):
    """全场次锁 vs 席位原子占用：两种策略都保证最后席位只有一个赢家，实测数据写入设计页。"""

    def test_both_strategies_single_winner(self):
        report = {'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'rounds': []}
        for strat, port in (('seat', 8172), ('session', 8173)):
            srv = Server(port, strat)
            try:
                winners, elapsed, rounds, contenders = 0, 0.0, 3, 8
                for r in range(rounds):
                    sid, _ = make_session(port, cap=1, rows=1, cols=1, start='2026-12-0%dT19:30' % (r + 1))
                    results = []
                    def w(i):
                        st, _ = http(port, 'POST', '/api/sessions/%d/holds' % sid,
                                     {'seat': 'A1', 'user': 'u%d' % i,
                                      'idempotency_key': 'cmp-%s-%d-%d' % (strat, r, i)})
                        results.append(st)
                    ts = [threading.Thread(target=w, args=(i,)) for i in range(contenders)]
                    t0 = time.monotonic()
                    for t in ts: t.start()
                    for t in ts: t.join()
                    elapsed += time.monotonic() - t0
                    self.assertEqual(results.count(201), 1, (strat, results))
                    winners += results.count(201)
                report['rounds'].append({'strategy': strat, 'rounds': rounds, 'contenders': contenders,
                                         'winners': winners, 'elapsed_ms': round(elapsed * 1000, 1)})
            finally:
                srv.stop()
        report['conclusion'] = ('两种策略均保证「最后席位只有一个赢家」。席位原子占用把冲突面收窄到单座'
                                '（唯一部分索引 + BEGIN IMMEDIATE），全场次锁在应用层串行化整场写入；'
                                'SQLite 单写者模型下吞吐接近，在行级锁数据库上席位级可并行不同座位。')
        with open(REPORT, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print('\n[strategy report]\n' + json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    unittest.main(verbosity=2)
