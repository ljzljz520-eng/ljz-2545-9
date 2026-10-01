# 星空放映厅 · 露天电影全栈排片系统

零依赖（Python 3 标准库）全栈应用：公开排片列表直接显示**改期 / 取消 / 满额**，
后台管理片单、场地与座位预约，SQLite 存储**场次身份、天气预案与占位记录**。

## 快速开始

```bash
python3 server.py --port 8000
# 前台  http://127.0.0.1:8000/        选座购票（占位 120s 倒计时）
# 后台  http://127.0.0.1:8000/admin   片单/场地/场次/天气预案/通知中心/审计
# 设计  http://127.0.0.1:8000/design  原创排版与设计说明（含并发策略实测）
```

首次启动自动建库并写入演示数据（含改期场、取消场、满额场、待决天气预案）。

## 验收测试

```bash
python3 tests/test_all.py
```

11 项用例：最后席位竞争（8 线程）、重复回执、预留超时、改期身份与冻结、
容量缩减保序、场地冲突、预案取消后迟到更新、驳回后迟到更新、通知中心模拟渠道、
版本守卫、双锁策略对比（结果写入 `static/strategy_report.json`，设计页自动展示）。

## 关键设计

| 需求 | 实现 |
| --- | --- |
| 改期=同一活动 | 只改 `sessions.start_time` 并写 `schedule_history`；`id/public_code` 终身不变，原预约不失联 |
| 旧票政策 | `ticket_policy`: `migrate` 自动迁移 / `rebook` 转待重订，均逐人通知 |
| 改期过程新报名约束 | 改期即 `booking_frozen=1`，占位返回 `409 BOOKING_FROZEN`，运营手动解冻 |
| 缩减容量 | 按 `confirm_seq` 保留先确认者，溢出者 `displaced` 并列名单返回，不随机撤销 |
| 天气双人确认 | 数据注入只生成 `pending` 预案；运营确认才改公开状态；迟到更新记 `superseded` |
| 席位原子占用 | 部分唯一索引 `(session_id, seat_label) WHERE state='active'` + `BEGIN IMMEDIATE` |
| 全场次锁对比 | `BOOKING_STRATEGY=session` 切换应用层 per-session 互斥锁，测试实测对比 |
| 预留超时 | `holds.expires_at`（默认 120s，`HOLD_TTL_SECONDS` 可调），惰性清扫，超时确认 410 |
| 幂等回执 | `idempotency_key` 唯一；重复确认返回同一张票；通知 `dedupe_key` 去重 |
| 通知中心 | `notifications` 待发送任务 → drain 投递到本地模拟渠道 `data/mock_channel.log` |
| 旧响应不覆盖 | 服务端 `expected_version` 乐观锁（409 STALE_VERSION）；前端请求序号+版本双重守卫 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOOKING_STRATEGY` | `seat` | `seat` 席位原子占用 / `session` 全场次锁 |
| `HOLD_TTL_SECONDS` | `120` | 占位超时时长 |
| `CINEMA_DATA_DIR` | `./data` | SQLite 与模拟渠道日志目录 |
| `PORT` | `8000` | 服务端口 |

## API 摘要

```
GET  /api/sessions                     场次列表（含 display_status / 余座 / version）
GET  /api/sessions/:id?key=            座位图 + 改期履历
POST /api/sessions/:id/holds           占位 {seat,user,idempotency_key,ttl_seconds?}
POST /api/holds/confirm                确认（幂等，重复回执返回同票）
POST /api/holds/release                释放占位
POST /api/weather/ingest               天气数据注入（只生成待决预案）
POST /api/admin/sessions               建场（场地冲突 409）
POST /api/admin/sessions/:id/reschedule   改期 {new_start_time,ticket_policy,expected_version}
POST /api/admin/sessions/:id/capacity     调容量（返回待处置名单）
POST /api/admin/sessions/:id/freeze       冻结/解冻报名
POST /api/admin/sessions/:id/cancel       取消场次
POST /api/admin/weather-plans/:id/decide  预案决策（确认才改公开状态）
GET  /api/admin/notifications          通知任务队列
POST /api/admin/notifications/drain    投递到本地模拟渠道
GET  /api/admin/mock-channel           模拟渠道回执
```

## 目录

```
server.py            单文件后端（路由 / 领域流程 / SQL schema / 种子数据）
static/              前台、后台、设计说明页（原创「夜幕放映」设计系统）
tests/test_all.py    验收测试（自动起 3 个临时实例，含双策略对比）
data/                运行时产物（cinema.db、mock_channel.log，不入库）
```
