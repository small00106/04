import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { setupHarness, teardownHarness, type TestHarness } from './helpers.js';
import { cycleRange, localParts } from '../src/time/buckets.js';

// Dedicated harness with SHORT windows so the config wiring can be exercised
// without waiting 24h/72h. These tests prove the values in config actually
// drive behaviour (they were previously dead constants).
const WINDOWS = {
  maxLatenessMs: 10_000, // 10s
  idempotencyWindowMs: 2_000, // 2s
  futureGraceMs: 1_000, // 1s
};

let h: TestHarness;
let app: FastifyInstance;

interface Resp<T = any> {
  status: number;
  body: T;
}

async function call(
  method: 'POST' | 'GET' | 'PUT',
  url: string,
  body?: unknown,
): Promise<Resp> {
  const res = await app.inject({ method, url, payload: body as any });
  return { status: res.statusCode, body: res.json() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function putTenant(
  id: string,
  timezone: string,
  anchor: number,
  displayName = id,
): Promise<Resp> {
  return call('PUT', `/v1/tenants/${id}`, {
    displayName,
    timezone,
    billingAnchorDay: anchor,
  });
}

async function ingest(
  tenantId: string,
  metric: string,
  value: number,
  occurredAt: Date,
  key: string,
): Promise<Resp> {
  return call('POST', '/v1/usage-events', {
    tenantId,
    metric,
    value,
    occurredAt: occurredAt.toISOString(),
    idempotencyKey: key,
  });
}

async function cycles(tenantId: string, metric: string): Promise<any[]> {
  const res = await call(
    'GET',
    `/v1/usage?tenantId=${tenantId}&metric=${metric}&granularity=cycle`,
  );
  assert.equal(res.status, 200);
  return res.body.buckets;
}

before(async () => {
  h = await setupHarness({ windows: WINDOWS, tag: 'reg' });
  app = h.app;
});

after(async () => {
  await teardownHarness(h);
});

describe('regression: billing anchor change after usage', () => {
  test('changing anchor is rejected (409) and leaves no overlapping cycle rows', async () => {
    const t = 'r_anchor';
    assert.equal((await putTenant(t, 'UTC', 20)).status, 200);

    const now = new Date();
    const first = await ingest(t, 'api.calls', 100, now, 'a-1');
    assert.equal(first.status, 202);

    // The exact bug from the report: flipping 20 -> 1 must not be allowed.
    const blocked = await putTenant(t, 'UTC', 1);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'TENANT_CONFIG_IMMUTABLE');

    // A later event must still bucket under the ORIGINAL anchor=20, and there
    // must be no overlapping [..-01, ..) row that clients could double-sum.
    const second = await ingest(t, 'api.calls', 50, new Date(), 'a-2');
    assert.equal(second.status, 202);

    const expected = cycleRange(localParts(now, 'UTC'), 20);
    const rows = await cycles(t, 'api.calls');
    assert.equal(rows.length, 1, 'exactly one cycle row, no overlap');
    assert.equal(rows[0].cycleStart, expected.start);
    assert.equal(rows[0].cycleEnd, expected.end);
    assert.equal(rows[0].total, 150);
  });

  test('displayName remains editable after usage', async () => {
    const t = 'r_name';
    await putTenant(t, 'UTC', 1);
    await ingest(t, 'm', 1, new Date(), 'n-1');
    const res = await putTenant(t, 'UTC', 1, 'New Name');
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, 'New Name');
  });
});

describe('regression: timezone change after usage', () => {
  test('changing timezone is rejected (409) and rollups keep one labeling', async () => {
    const t = 'r_tz';
    assert.equal((await putTenant(t, 'Asia/Shanghai', 1)).status, 200);
    await ingest(t, 'api.calls', 7, new Date(), 'tz-1');

    const blocked = await putTenant(t, 'Pacific/Kiritimati', 1);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'TENANT_CONFIG_IMMUTABLE');

    // Query must still describe the data with the timezone it was cut under.
    const res = await call(
      'GET',
      `/v1/usage?tenantId=${t}&metric=api.calls&granularity=daily`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, 'Asia/Shanghai');
    assert.equal(res.body.buckets.length, 1);
    assert.equal(res.body.buckets[0].total, 7);
  });

  test('timezone and anchor CAN change before any usage exists', async () => {
    const t = 'r_fresh';
    assert.equal((await putTenant(t, 'UTC', 1)).status, 200);
    // No events ingested: reconfiguration is allowed.
    const changed = await putTenant(t, 'Asia/Shanghai', 15);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.timezone, 'Asia/Shanghai');
    assert.equal(changed.body.billingAnchorDay, 15);

    const r = await ingest(t, 'api.calls', 3, new Date(), 'f-1');
    assert.equal(r.status, 202);
    const rows = await cycles(t, 'api.calls');
    assert.ok(rows[0].cycleStart.endsWith('-15'), 'uses new anchor');
  });
});

describe('regression: database-level cycle overlap guard', () => {
  test('overlapping cycle rows for one (tenant, metric) are physically rejected', async () => {
    await putTenant('r_guard', 'UTC', 20);
    // Simulate the corrupt state the anchor flip would create, written directly.
    await h.pool.query(
      `INSERT INTO usage_agg_cycle
         (tenant_id, metric, cycle_start, cycle_end, total, event_count)
       VALUES ('r_guard','m','2026-08-20'::date,'2026-09-20'::date,100,1)`,
    );
    await assert.rejects(
      h.pool.query(
        `INSERT INTO usage_agg_cycle
           (tenant_id, metric, cycle_start, cycle_end, total, event_count)
         VALUES ('r_guard','m','2026-09-01'::date,'2026-10-01'::date,100,1)`,
      ),
      (err: any) => err.code === '23P01', // exclusion_violation
    );
  });

  test('adjacent (non-overlapping) cycles are allowed', async () => {
    await h.pool.query(
      `INSERT INTO usage_agg_cycle
         (tenant_id, metric, cycle_start, cycle_end, total, event_count)
       VALUES ('r_guard','m2','2026-08-20'::date,'2026-09-20'::date,1,1)`,
    );
    await h.pool.query(
      `INSERT INTO usage_agg_cycle
         (tenant_id, metric, cycle_start, cycle_end, total, event_count)
       VALUES ('r_guard','m2','2026-09-20'::date,'2026-10-20'::date,1,1)`,
    );
    const rows = await cycles('r_guard', 'm2');
    assert.equal(rows.length, 2);
  });
});

describe('regression: window config is actually wired', () => {
  test('maxLatenessMs rejects an event older than the configured 10s', async () => {
    await putTenant('r_late', 'UTC', 1);
    const tooOld = await ingest(
      'r_late',
      'm',
      1,
      new Date(Date.now() - 30_000),
      'late-1',
    );
    assert.equal(tooOld.status, 422);
    assert.equal(tooOld.body.error.code, 'EVENT_TOO_OLD');

    const fresh = await ingest('r_late', 'm', 1, new Date(), 'late-2');
    assert.equal(fresh.status, 202);
  });

  test('futureGraceMs rejects an event beyond the configured 1s skew', async () => {
    await putTenant('r_future', 'UTC', 1);
    const far = await ingest(
      'r_future',
      'm',
      1,
      new Date(Date.now() + 10_000),
      'fut-1',
    );
    assert.equal(far.status, 422);
    assert.equal(far.body.error.code, 'EVENT_IN_FUTURE');
  });

  test('idempotencyWindowMs parameterizes the 24h rule (reuse after 2s)', async () => {
    await putTenant('r_idem', 'UTC', 1);
    const when = new Date(Date.now() - 1_000);

    const first = await ingest('r_idem', 'm', 5, when, 'idem-1');
    assert.equal(first.status, 202);

    // Inside the configured 2s window -> still deduplicated.
    const replay = await ingest('r_idem', 'm', 5, when, 'idem-1');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 'duplicate');

    // Wait past the configured window; the SQL cutoff is now parameter-driven,
    // so the same key+body is accepted as a new event without any SQL aging.
    await sleep(2_300);
    const reused = await ingest('r_idem', 'm', 5, when, 'idem-1');
    assert.equal(reused.status, 202, JSON.stringify(reused.body));

    const res = await call(
      'GET',
      '/v1/usage?tenantId=r_idem&metric=m&granularity=hourly',
    );
    assert.equal(res.body.buckets[0].eventCount, 2);
    assert.equal(res.body.buckets[0].total, 10);
  });
});
