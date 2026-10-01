# 星空放映厅 · Starlit Cinema

露天电影全栈排片网站：公共端浏览场次/选座订票，运营后台管理片单、场地、排期、
天气预案与通知中心。Node.js + SQLite（better-sqlite3）+ 原生 HTML/CSS/JS，零构建。

## 快速开始

```bash
npm install        # 安装唯一依赖 better-sqlite3
npm start          # 启动 http://localhost:3000（首次自动写入演示数据）
npm test           # 运行验收测试（内存 SQLite，14 个用例）
```

| 页面 | 地址 | 说明 |
|---|---|---|
| 场次列表 | `/` | 直接显示 **已改期 / 已取消 / 满额** 徽章 |
| 场次详情 | `/screening.html?id=SC-0001` | 座位图、占位倒计时、查票、改期确认 |
| 运营后台 | `/admin.html` | 令牌 `dev-admin-token` |
| 设计说明 | `/design.html` | 原创排版 + 并发与一致性设计文档 |

## 核心设计决策

**改期 = 同一活动的新安排。** `screenings.id` 终身不变，改期向 `schedule_revisions`
追加版本并前移指针；票永远外键指向活动身份，**旧票不会失联**。旧票处置由显式政策决定：
`migrate_all`（整体迁移）/ `opt_in`（观众确认）/ `void_all`（作废重报）。

**缩减容量保留原确认顺序。** 每张票确认时获得单调递增 `confirm_seq`；缩减时按序保留
先到者，超出者进入 `displaced` 并生成处置通知，接口返回**有序的需处置名单**——
绝不随机撤销。扩容时按同一顺序恢复（原座位仍空闲才恢复）。

**天气数据不直接改公开状态。** 恶劣天气观测只会把预案推到 `pending_decision`；
运营 `decide` 之后才改变场次公开状态。迟到（观测时间 ≤ 决定时间）与终态后的观测
记入 `weather_events` 审计并忽略。

**席位并发双策略**（`BOOKING_STRATEGY=atomic|screening_lock`，默认 atomic）：

- `atomic` 席位原子占用：条件 UPDATE 原子递增场次计数器（带容量上界）+
  `seat_occupancy(screening_id, seat_id)` 主键裁决席位冲突，失败范围=单席位；
- `screening_lock` 全场次锁：进程内按场次互斥 + 校验后插入，语义直观但同场次串行。

两种策略共享同一套 SQL 不变量，测试在双策略下各跑一轮「最后席位竞争」。
占位写入 `seat_holds`（含 `expires_at`），超时由惰性+定时清扫回收；
改期事务内 `sale_state=paused`，暂停期间新报名一律 409。

**通知中心幂等。** 任务以 `idempotency_key` 去重（改期按修订版本区分）；
派发走本地模拟渠道写入 `mock_outbox`；回执以 `UNIQUE(task_id, receipt_token)`
幂等，重复回执返回 `duplicate:true` 不重复登记。

**版本不被旧响应覆盖。** 服务端 `screenings.version` 乐观锁（失配 409 +
当前版本）；浏览器 `js/guard.js` 用递增令牌 + 行级版本号丢弃乱序旧响应。

## 测试矩阵（tests/test.js）

最后席位竞争（双策略）· 容量原子计数 · 占位超时回收 · 改期三政策不失联 ·
改期中报名约束 · 容量缩减顺序与恢复 · 场地冲突（创建+改期）· 天气预案与迟到更新 ·
重复回执幂等 · 乐观锁版本冲突 · VersionGuard 乱序响应 · 列表状态标志

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 服务端口 |
| `DB_PATH` | ./data.sqlite | SQLite 路径（测试用 `:memory:`） |
| `ADMIN_TOKEN` | dev-admin-token | 管理接口令牌 |
| `BOOKING_STRATEGY` | atomic | 席位占用策略 |
| `HOLD_TTL_SECONDS` | 300 | 占位超时时长 |

## 结构

```
src/      server.js(装配) router.js api.js services.js(业务) db.js(模式) seed.js util.js
public/   index/screening/admin/design 四个页面 + css/styles.css + js/*
tests/    test.js（node --test）
```
