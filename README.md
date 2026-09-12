# meterd

多租户 API 平台的用量计量服务（独立服务，代号 **meterd**）。Node 20 + TypeScript + Fastify + PostgreSQL。
不含管理界面；提供机器可调用的租户配置接口、计量事件摄入接口和只读用量查询接口。

## 核心不变量

- **摄入时增量聚合**：写入事件时在同一事务内 upsert 小时 / 天 / 计费周期三张聚合表。查询只读聚合表，**绝不**对原始事件现算。
- **并发安全**：聚合用 `INSERT ... ON CONFLICT DO UPDATE SET total = total + EXCLUDED.total`，由 PostgreSQL 行锁保证并发正确；幂等用主键唯一约束兜底。
- **24 小时幂等**：`(tenant_id, idempotency_key)` 唯一，24 小时内同键同体只计一次，返回 `duplicate`；同键不同体返回 `409 IDEMPOTENCY_CONFLICT`。超过 24 小时的 claim 会被回收，键可重新使用。
- **72 小时补记窗口**：`occurredAt` 早于 `now - 72h` 拒绝，返回 `422 EVENT_TOO_OLD`（含 `oldestAllowed`）；过远的未来时间返回 `422 EVENT_IN_FUTURE`（默认 5 分钟时钟偏移宽限）。
- **租户时区切天**：天/小时边界按租户配置的 IANA 时区（如 `Asia/Shanghai`）计算，不写死 UTC。桶以无时区的本地墙钟时间存入，结果与数据库会话 `TimeZone` 无关。
- **整数最小单位**：用量一律 `BIGINT` 非负整数（如分、字节、毫秒），拒绝浮点与负数。超过 JS 安全整数（2^53）时接口以字符串原样返回，避免精度丢失。
- **租户分桶键一旦有用量即冻结**：`timezone` 与 `billingAnchorDay` 决定历史如何切桶。对已存在用量的租户修改这两项会被拒绝（`409 TENANT_CONFIG_IMMUTABLE`）；`displayName` 随时可改；尚无任何事件的新租户可自由调整。

## 设计决策：为什么禁止（而不是重算或只告警）修改时区 / 账期锚点

日桶、小时桶、周期桶都是在摄入时刻按租户当时的 `timezone` / `billingAnchorDay` 增量固化的。允许事后改这两个键会立刻产生自相矛盾的数据：

- **改锚点**：同一时刻的新事件按新锚点落桶，旧周期行原地保留，于是出现两条互相重叠、都覆盖"今天"的周期行；客户端对 cycle 行求和即**双算**。
- **改时区**：同一时刻可能被切到相邻的另一天，旧日桶不重切；而查询结果会用新时区统一标注整份历史，导致 09-11 的桶实际是按上海时间切的、却被标成 Pacific/Kiritimati。

三个选项里我们选择**禁止**：

- **重算（recut）**语义上可行，但它会改写已出账/已对账的历史周期，必须是带"生效日期、审批、留存旧快照"的独立受控操作，不该藏在一个幂等的 `PUT` 配置接口里静默发生。需要时应另建显式的回填作业。
- **只告警**不消除上面的矛盾数据，等于把双算风险转嫁给每个客户端。
- **禁止**把不可调和的变更挡在门外，并配合一道数据库层兜底（见下），是默认最安全的语义。真要改，正确路径是新建租户（新键）并在边界日切换，或走未来的显式重算流程。

数据库层另有兜底：`usage_agg_cycle` 上对 `(tenant_id, metric, daterange(cycle_start, cycle_end))` 的 **GiST 排他约束** `usage_agg_cycle_no_overlap`，即使绕过 API 直接写库，也无法插入互相重叠的周期行（违反返回 PG `23P01`）。

> 迁移注意：给已存在的库补这条排他约束时，如果历史数据里已经存在重叠周期行，`ALTER TABLE ... ADD CONSTRAINT` 会失败——这说明数据已处于双算状态，需先人工修复重叠行再迁移。

## 数据模型（`src/db/schema.sql`）

| 表 | 作用 |
|---|---|
| `tenants` | 租户：`timezone`（IANA）、`billing_anchor_day`（计费起算日 1..28） |
| `usage_events` | 原始事件，仅用于审计；不参与查询聚合 |
| `idempotency_keys` | 24h 幂等 claim（含请求体指纹），过期回收 |
| `usage_agg_hourly` | 按 `(租户, 指标, 本地小时)` 的增量聚合 |
| `usage_agg_daily` | 按 `(租户, 指标, 本地日期)` |
| `usage_agg_cycle` | 按 `(租户, 指标, 周期起始日)`，`[cycle_start, cycle_end)` |

计费周期：起算日限制在 1..28（保证每月都有该日，无需短月裁剪）。anchor=1 即自然月。

## API

### 租户配置（机器接口，非管理界面）
`PUT /v1/tenants/:id`
```json
{ "displayName": "Acme", "timezone": "Asia/Shanghai", "billingAnchorDay": 15 }
```

### 摄入计量事件
`POST /v1/usage-events`
```json
{
  "tenantId": "acme",
  "metric": "api.requests",
  "value": 1500,
  "occurredAt": "2026-09-12T10:18:00.000Z",
  "idempotencyKey": "evt-abc-1"
}
```
- 首次：`202 {"status":"accepted","eventId":"..."}`
- 24h 内同键重复：`200 {"status":"duplicate"}`
- 错误体：`{"error":{"code":"...","message":"...","details":{...}}}`

### 查询用量（只读聚合）
`GET /v1/usage?tenantId=acme&metric=api.requests&granularity=hourly|daily|cycle[&from=...&to=...]`

桶的时区始终取租户配置；`from`/`to` 为 ISO-8601，hourly/daily 按本地桶比较，cycle 按周期区间重叠过滤。

## 错误码

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 字段非法（含浮点 value、非法时区） |
| `UNKNOWN_TENANT` | 404 | 租户不存在 |
| `EVENT_TOO_OLD` | 422 | 超过 72h 补记窗口 |
| `EVENT_IN_FUTURE` | 422 | 发生时间过远于未来 |
| `IDEMPOTENCY_CONFLICT` | 409 | 24h 内同键不同体 |
| `TENANT_CONFIG_IMMUTABLE` | 409 | 租户已有用量后修改 timezone / billingAnchorDay |

## 开发与运行

```bash
npm install
npm run migrate          # 需先设置 METERD_DATABASE_URL
npm run dev              # tsx watch
npm run build && npm start
```

环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `METERD_DATABASE_URL` | `postgres://meterd:meterd@127.0.0.1:5432/meterd` | PG 连接串 |
| `METERD_PORT` / `METERD_HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `METERD_MAX_LATENESS_MS` | `259200000`（72h） | 允许补记的最大事件年龄 |
| `METERD_IDEMPOTENCY_WINDOW_MS` | `86400000`（24h） | 幂等 claim 有效期；过期后键可复用 |
| `METERD_FUTURE_GRACE_MS` | `300000`（5min） | 未来事件的时钟偏移宽限 |

这三个窗口不再有硬编码：摄入校验读 `METERD_MAX_LATENESS_MS` / `METERD_FUTURE_GRACE_MS`，幂等 claim 回收 cutoff 由 `METERD_IDEMPOTENCY_WINDOW_MS` 参数化传入 SQL（不再写死 `interval '24 hours'`）。非法（非正整数）配置在启动时即报错。

## 测试

```bash
npm test
```

- `test/buckets.test.ts`：时区墙钟换算、时区校验、计费周期边界（含跨年、anchor 前后归属）。
- `test/integration.test.ts`：对真实 PostgreSQL 的端到端测试，覆盖
  - **乱序**：事件不按发生顺序到达，正确落到各小时/天/周期桶；迟到事件增量并入已有桶而非覆盖；
  - **迟到**：72h 边界内接受、边界外 `EVENT_TOO_OLD`；
  - **重复**：24h 内同键只计一次、同键不同体冲突、8 并发恰好计一次、claim 满 24h 后键可复用；
  - 租户时区切天（上海按 16:00 UTC 跨界分两天）、anchor 周期行、大整数精确累加。
- `test/regression.test.ts`：用 10s/2s/1s 的短窗口独立 harness 连真实 PG，覆盖
  - 有用量后改锚点 20→1 被 `409` 拒绝，且只保留原锚点的单个周期行、不产生重叠；
  - 有用量后改时区被 `409` 拒绝，查询仍以原时区标注；无用量租户可自由改，`displayName` 始终可改；
  - 直接写库制造重叠周期行被排他约束以 `23P01` 拒绝，相邻（不重叠）周期行允许；
  - 三个窗口配置真实生效：超 10s 拒绝、超 1s 未来偏移拒绝、同键过 2s 后可复用（证明 SQL 已参数化）。

测试库连接：`METERD_TEST_ADMIN_URL`（默认 `postgres://postgres@127.0.0.1:5432/postgres`，需建库权限），每次运行创建并删除独立数据库。
