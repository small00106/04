import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { setupEmptyDb, dropDb } from './helpers.js';
import { cycleRange, localParts } from '../src/time/buckets.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGACY_SCHEMA = join(here, 'fixtures', 'legacy-schema.sql');

// Date arithmetic on test-defined UTC date CONSTANTS only. Never feed this a
// DATE column read from Postgres — node-pg parses those as local-midnight JS
// Dates and toISOString() would shift a day under a non-UTC TZ. DB dates are
// compared via SQL to_char(...) strings instead.
const isoFromUtcDate = (d: Date) => d.toISOString().slice(0, 10);
const datePlus = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromUtcDate(d);
};

let pool: Pool;
let dbName: string;

async function rows(sql: string, params: unknown[] = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

test('upgrade: a legacy DB with overlapping cycle rows self-heals and stays bootable', async (t) => {
  const empty = await setupEmptyDb('upg');
  pool = empty.pool;
  dbName = empty.dbName;

  t.after(async () => {
    await pool.end().catch(() => {});
    await dropDb(dbName);
  });

  // 1) lay down the PRE-constraint schema
  await pool.query(await readFile(LEGACY_SCHEMA, 'utf8'));

  // 2) reproduce the exact anchor-change bug shape against TODAY.
  //    Tenant is now configured anchor=1; a stale anchor=20 cycle row remains,
  //    and both cycles contain today, so they overlap.
  const now = new Date();
  const cur1 = cycleRange(localParts(now, 'UTC'), 1);
  const cur20 = cycleRange(localParts(now, 'UTC'), 20);
  await rows(
    `INSERT INTO tenants (id, display_name, timezone, billing_anchor_day)
     VALUES ('u_dirty','Dirty','UTC',1)`,
  );
  await rows(
    `INSERT INTO usage_agg_cycle
       (tenant_id, metric, cycle_start, cycle_end, total, event_count)
     VALUES ('u_dirty','m',$1::date,$2::date,100,1),
            ('u_dirty','m',$3::date,$4::date,100,1)`,
    [cur20.start, cur20.end, cur1.start, cur1.end],
  );

  // 3) a purely-historical overlap (does NOT cover today) -> union-range path
  await rows(
    `INSERT INTO tenants (id, display_name, timezone, billing_anchor_day)
     VALUES ('u_past','Past','UTC',1)`,
  );
  const pStart = '2025-01-01';
  await rows(
    `INSERT INTO usage_agg_cycle (tenant_id, metric, cycle_start, cycle_end, total, event_count)
     VALUES ('u_past','m',$1::date,$2::date,30,1),
            ('u_past','m',$3::date,$4::date,5,1)`,
    [pStart, datePlus(pStart, 30), datePlus(pStart, 10), datePlus(pStart, 40)],
  );

  // 4) a clean tenant with two ADJACENT (non-overlapping) cycles -> untouched
  await rows(
    `INSERT INTO tenants (id, display_name, timezone, billing_anchor_day)
     VALUES ('u_clean','Clean','UTC',1)`,
  );
  await rows(
    `INSERT INTO usage_agg_cycle (tenant_id, metric, cycle_start, cycle_end, total, event_count)
     VALUES ('u_clean','m','2026-07-01'::date,'2026-08-01'::date,3,1),
            ('u_clean','m','2026-08-01'::date,'2026-09-01'::date,4,1)`,
  );

  // 5) THE key assertion: migration MUST NOT crash on the dirty data.
  await assert.doesNotReject(() => migrate(pool));

  const cons = await rows(
    `SELECT 1 FROM pg_constraint WHERE conname = 'usage_agg_cycle_no_overlap'`,
  );
  assert.equal(cons.length, 1);

  // 6) dirty pair collapsed to the tenant's CURRENT anchor=1 cycle, total conserved
  const dirty = await rows(
    `SELECT to_char(cycle_start,'YYYY-MM-DD') AS cycle_start,
            to_char(cycle_end,'YYYY-MM-DD')   AS cycle_end,
            total, event_count
       FROM usage_agg_cycle WHERE tenant_id='u_dirty' AND metric='m' ORDER BY cycle_start`,
  );
  assert.equal(dirty.length, 1, 'overlapping pair must become a single row');
  assert.equal(dirty[0].cycle_start, cur1.start);
  assert.equal(dirty[0].cycle_end, cur1.end);
  assert.equal(Number(dirty[0].total), 200);
  assert.equal(Number(dirty[0].event_count), 2);

  // 7) audit trail records both superseded originals, pointing at the survivor
  const log = await rows(
    `SELECT to_char(old_cycle_start,'YYYY-MM-DD') AS old_cycle_start,
            old_total,
            to_char(merged_into_cycle_start,'YYYY-MM-DD') AS merged_into_cycle_start
       FROM usage_agg_cycle_repair_log
      WHERE tenant_id='u_dirty' ORDER BY old_cycle_start`,
  );
  assert.equal(log.length, 2);
  for (const l of log) {
    assert.equal(Number(l.old_total), 100);
    assert.equal(l.merged_into_cycle_start, cur1.start);
  }

  // 8) historical overlap collapsed to union range, sum conserved
  const past = await rows(
    `SELECT to_char(cycle_start,'YYYY-MM-DD') AS cycle_start,
            to_char(cycle_end,'YYYY-MM-DD')   AS cycle_end, total
       FROM usage_agg_cycle
      WHERE tenant_id='u_past' ORDER BY cycle_start`,
  );
  assert.equal(past.length, 1);
  assert.equal(past[0].cycle_start, pStart);
  assert.equal(past[0].cycle_end, datePlus(pStart, 40));
  assert.equal(Number(past[0].total), 35);

  // 9) adjacent clean rows left exactly as they were
  const clean = await rows(
    `SELECT total FROM usage_agg_cycle WHERE tenant_id='u_clean' ORDER BY cycle_start`,
  );
  assert.deepEqual(clean.map((c) => Number(c.total)), [3, 4]);

  // 10) service boots on the upgraded DB and keeps ingesting into the survivor
  const app = await buildApp({ pool });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/usage-events',
    payload: {
      tenantId: 'u_dirty',
      metric: 'm',
      value: 1,
      occurredAt: new Date().toISOString(),
      idempotencyKey: 'post-upgrade-1',
    },
  });
  assert.equal(res.statusCode, 202, res.body);
  const after = await rows(
    `SELECT total FROM usage_agg_cycle WHERE tenant_id='u_dirty' AND metric='m'`,
  );
  assert.equal(after.length, 1, 'new event upserts the survivor, no extra row');
  assert.equal(Number(after[0].total), 201);
  await app.close();

  // 11) migration is idempotent on the now-cleaned database
  await assert.doesNotReject(() => migrate(pool));
});
