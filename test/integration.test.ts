import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { setupHarness, teardownHarness, type TestHarness } from './helpers.js';
import { cycleRange, localParts } from '../src/time/buckets.js';

let h: TestHarness;
let app: FastifyInstance;

interface Resp<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: 'POST' | 'GET' | 'PUT',
  url: string,
  body?: unknown,
): Promise<Resp<T>> {
  const res = await app.inject({ method, url, payload: body as any });
  return { status: res.statusCode, body: res.json() as T };
}

const HOUR = 60 * 60 * 1000;

async function provisionTenant(
  id: string,
  opts: { timezone?: string; anchor?: number } = {},
): Promise<void> {
  const res = await call('PUT', `/v1/tenants/${id}`, {
    displayName: id,
    timezone: opts.timezone ?? 'UTC',
    billingAnchorDay: opts.anchor ?? 1,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function ingest(
  tenantId: string,
  metric: string,
  value: number,
  occurredAt: Date,
  idempotencyKey: string,
): Promise<Resp> {
  return call('POST', '/v1/usage-events', {
    tenantId,
    metric,
    value,
    occurredAt: occurredAt.toISOString(),
    idempotencyKey,
  });
}

async function usage(
  tenantId: string,
  metric: string,
  granularity: string,
  extra = '',
): Promise<any> {
  const res = await call(
    'GET',
    `/v1/usage?tenantId=${tenantId}&metric=${metric}&granularity=${granularity}${extra}`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  h = await setupHarness();
  app = h.app;
});

after(async () => {
  await teardownHarness(h);
});

describe('validation & lateness window', () => {
  test('rejects events older than 72h with EVENT_TOO_OLD (422)', async () => {
    await provisionTenant('t_old');
    const res = await ingest(
      't_old',
      'api.calls',
      10,
      new Date(Date.now() - (72 * HOUR + 60_000)),
      'k-old-1',
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'EVENT_TOO_OLD');
    assert.ok(res.body.error.details.oldestAllowed, 'includes oldestAllowed hint');
  });

  test('accepts an event just inside the 72h window as a late backfill', async () => {
    await provisionTenant('t_late');
    const res = await ingest(
      't_late',
      'api.calls',
      7,
      new Date(Date.now() - (72 * HOUR - 5 * 60_000)),
      'k-late-1',
    );
    assert.equal(res.status, 202, JSON.stringify(res.body));

    const agg = await usage('t_late', 'api.calls', 'hourly');
    assert.equal(agg.buckets[0].total, 7);
  });

  test('rejects float and negative values — integer minor units only', async () => {
    await provisionTenant('t_int');
    const float = await ingest('t_int', 'api.calls', 1.5, new Date(), 'k-float');
    assert.equal(float.status, 400);
    assert.equal(float.body.error.code, 'VALIDATION_ERROR');

    const neg = await ingest('t_int', 'api.calls', -1, new Date(), 'k-neg');
    assert.equal(neg.status, 400);
  });

  test('rejects unknown tenant with UNKNOWN_TENANT (404)', async () => {
    const res = await ingest('nope', 'api.calls', 1, new Date(), 'k-x');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'UNKNOWN_TENANT');
  });
});

describe('idempotency: same key within 24h counts once', () => {
  test('replays return duplicate and rollups are unaffected', async () => {
    await provisionTenant('t_dup');
    const when = new Date(Date.now() - 30 * 60_000);

    const first = await ingest('t_dup', 'api.calls', 100, when, 'dup-key');
    assert.equal(first.status, 202);

    for (let i = 0; i < 2; i++) {
      const replay = await ingest('t_dup', 'api.calls', 100, when, 'dup-key');
      assert.equal(replay.status, 200);
      assert.equal(replay.body.status, 'duplicate');
    }

    const agg = await usage('t_dup', 'api.calls', 'hourly');
    assert.equal(agg.buckets.length, 1);
    assert.equal(agg.buckets[0].total, 100);
    assert.equal(agg.buckets[0].eventCount, 1);
  });

  test('same key with a DIFFERENT payload within 24h is IDEMPOTENCY_CONFLICT (409)', async () => {
    await provisionTenant('t_conf');
    const when = new Date(Date.now() - 10 * 60_000);
    const a = await ingest('t_conf', 'api.calls', 100, when, 'conf-key');
    assert.equal(a.status, 202);
    const b = await ingest('t_conf', 'api.calls', 250, when, 'conf-key');
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'IDEMPOTENCY_CONFLICT');

    // The conflicting value must not have been counted.
    const agg = await usage('t_conf', 'api.calls', 'hourly');
    assert.equal(agg.buckets[0].total, 100);
  });

  test('8 concurrent submissions of one key are counted exactly once', async () => {
    await provisionTenant('t_race');
    const when = new Date(Date.now() - 5 * 60_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ingest('t_race', 'api.calls', 42, when, 'race-key'),
      ),
    );
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.equal(
      results.filter((r) => r.status === 200 && r.body.status === 'duplicate')
        .length,
      7,
    );

    const agg = await usage('t_race', 'api.calls', 'hourly');
    assert.equal(agg.buckets[0].total, 42);
    assert.equal(agg.buckets[0].eventCount, 1);
  });

  test('key becomes reusable once its claim ages past 24h', async () => {
    await provisionTenant('t_reuse');
    const when = new Date(Date.now() - 60 * 60_000);
    const first = await ingest('t_reuse', 'api.calls', 5, when, 'reuse-key');
    assert.equal(first.status, 202);

    // Age the claim beyond the 24h dedup window directly.
    await h.pool.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '25 hours'
        WHERE tenant_id = 't_reuse' AND idempotency_key = 'reuse-key'`,
    );

    // Same key+payload is now accepted as a brand-new event and counted again.
    const second = await ingest('t_reuse', 'api.calls', 5, when, 'reuse-key');
    assert.equal(second.status, 202, JSON.stringify(second.body));

    const agg = await usage('t_reuse', 'api.calls', 'hourly');
    assert.equal(agg.buckets[0].total, 10);
    assert.equal(agg.buckets[0].eventCount, 2);
  });
});

describe('out-of-order ingestion', () => {
  test('events arriving in non-chronological order land in correct buckets at all three grains', async () => {
    await provisionTenant('t_ooo');
    const now = Date.now();
    // Occurrence order t0 < t2 < t1; submission order t1, t2, t0.
    const t0 = new Date(now - 26 * HOUR);
    const t1 = new Date(now - 2 * HOUR);
    const t2 = new Date(now - 25 * HOUR);

    await ingest('t_ooo', 'api.calls', 10, t1, 'ooo-1');
    await ingest('t_ooo', 'api.calls', 20, t2, 'ooo-2');
    await ingest('t_ooo', 'api.calls', 30, t0, 'ooo-3');

    const hourly = await usage('t_ooo', 'api.calls', 'hourly');
    assert.deepEqual(
      hourly.buckets.map((b: any) => b.total).sort((a: number, b: number) => a - b),
      [10, 20, 30],
    );

    for (const grain of ['daily', 'cycle'] as const) {
      const agg = await usage('t_ooo', 'api.calls', grain);
      const sum = agg.buckets.reduce((s: number, b: any) => s + b.total, 0);
      assert.equal(sum, 60, `${grain} grand total must be 60`);
    }
  });

  test('a late event for an existing bucket increments it rather than replacing it', async () => {
    await provisionTenant('t_latebucket');
    const now = Date.now();
    // Same hour bucket, second event arrives "late" (after a newer one).
    const onTime = new Date(now - 3 * HOUR);
    const late = new Date(now - 2 * HOUR - 50 * 60_000); // earlier hour
    await ingest('t_latebucket', 'api.calls', 100, onTime, 'lb-1');
    await ingest('t_latebucket', 'api.calls', 5, late, 'lb-2');

    const hourly = await usage('t_latebucket', 'api.calls', 'hourly');
    const sum = hourly.buckets.reduce((s: number, b: any) => s + b.total, 0);
    assert.equal(sum, 105);
  });
});

describe('tenant-local day boundaries (not UTC)', () => {
  test('Asia/Shanghai events around 16:00 UTC split into two local days', async () => {
    await provisionTenant('t_sh', { timezone: 'Asia/Shanghai' });

    // Compute the PREVIOUS UTC 16:00 (= Shanghai 00:00) and straddle it with
    // fresh past events, so the test is independent of wall clock when it runs
    // and no event is future-dated or older than 72h.
    const d = new Date();
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(16);
    // Ensure even the post-boundary event (midnight + 30m) is in the past.
    while (d.getTime() + 31 * 60_000 > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
    const shMidnightUtc = d.getTime();

    const e1 = new Date(shMidnightUtc - 30 * 60_000); // 23:30 Shanghai day N
    const e2 = new Date(shMidnightUtc + 30 * 60_000); // 00:30 Shanghai day N+1
    await ingest('t_sh', 'api.calls', 11, e1, 'sh-1');
    await ingest('t_sh', 'api.calls', 22, e2, 'sh-2');

    const daily = await usage('t_sh', 'api.calls', 'daily');
    assert.equal(daily.buckets.length, 2, 'two Shanghai-local days');
    assert.deepEqual(
      daily.buckets
        .map((b: any) => b.total)
        .sort((a: number, b: number) => a - b),
      [11, 22],
    );

    // The two stored local dates must be consecutive calendar days, and the
    // boundary corresponds to 16:00 UTC (Shanghai midnight), not 00:00 UTC.
    const labels = daily.buckets.map((b: any) => b.bucket).sort() as string[];
    assert.equal(
      (new Date(`${labels[1]}T00:00:00+08:00`).getTime() -
        new Date(`${labels[0]}T00:00:00+08:00`).getTime()) /
        HOUR,
      24,
    );
  });

  test('cycle row for a fresh event matches tenant anchor (anchor=20)', async () => {
    await provisionTenant('t_cyc', { timezone: 'UTC', anchor: 20 });
    const when = new Date(Date.now() - 2 * HOUR);
    await ingest('t_cyc', 'api.calls', 9, when, 'cyc-1');

    const cycle = await usage('t_cyc', 'api.calls', 'cycle');
    assert.equal(cycle.buckets.length, 1);
    const expected = cycleRange(localParts(when, 'UTC'), 20);
    assert.equal(cycle.buckets[0].cycleStart, expected.start);
    assert.equal(cycle.buckets[0].cycleEnd, expected.end);
    assert.equal(cycle.buckets[0].total, 9);
  });
});

describe('integer storage', () => {
  test('large integers add exactly with no float drift', async () => {
    await provisionTenant('t_bigint');
    const when = new Date(Date.now() - 20 * 60_000);
    await ingest('t_bigint', 'bytes', 9_007_199_254_740_000, when, 'bi-1');
    await ingest('t_bigint', 'bytes', 100, when, 'bi-2');
    const agg = await usage('t_bigint', 'bytes', 'hourly');
    assert.equal(agg.buckets[0].total, 9_007_199_254_740_100);
  });
});
