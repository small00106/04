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

## 开发与运行

```bash
npm install
npm run migrate          # 需先设置 METERD_DATABASE_URL
npm run dev              # tsx watch
npm run build && npm start
```

环境变量：`METERD_DATABASE_URL`、`METERD_PORT`（默认 8080）、`METERD_HOST`（默认 0.0.0.0）。

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

测试库连接：`METERD_TEST_ADMIN_URL`（默认 `postgres://postgres@127.0.0.1:5432/postgres`，需建库权限），每次运行创建并删除独立数据库。
