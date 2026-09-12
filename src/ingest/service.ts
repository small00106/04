import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { config, type Windows } from '../config.js';
import { ErrorCode, MeterError } from '../errors.js';
import {
  cycleRange,
  dayKey,
  hourBucketKey,
  localParts,
} from '../time/buckets.js';

export interface IngestEventInput {
  tenantId: string;
  metric: string;
  value: number;
  occurredAt: string; // ISO 8601
  idempotencyKey: string;
}

export interface IngestResult {
  status: 'accepted' | 'duplicate';
  eventId?: string;
}

interface TenantRow {
  timezone: string;
  billing_anchor_day: number;
}

const MAX_BIGINT = 9_223_372_036_854_775_807n;

// Canonical digest so a replay carrying a different metric/value/time is a
// conflict instead of being silently deduplicated.
function fingerprint(input: IngestEventInput, occurredAt: Date): string {
  const canonical = [
    input.tenantId,
    input.metric,
    input.value,
    occurredAt.toISOString(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export class IngestService {
  private readonly windows: Windows;

  constructor(
    private pool: Pool,
    windows: Windows = config,
  ) {
    this.windows = windows;
  }

  private validate(input: Partial<IngestEventInput>, now: Date): Date {
    if (typeof input.tenantId !== 'string' || !input.tenantId.trim()) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'tenantId is required',
        400,
        { field: 'tenantId' },
      );
    }
    if (
      typeof input.metric !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(input.metric)
    ) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'metric must be 1..128 chars: letters, digits, _ . : - and start with a letter',
        400,
        { field: 'metric' },
      );
    }
    // Integer minor units only. No floats, no negatives, bounded to BIGINT.
    if (
      typeof input.value !== 'number' ||
      !Number.isSafeInteger(input.value) ||
      input.value < 0 ||
      BigInt(input.value) > MAX_BIGINT
    ) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'value must be a non-negative integer in minor units (no floats)',
        400,
        { field: 'value' },
      );
    }
    if (
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 200
    ) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'idempotencyKey is required (max 200 chars)',
        400,
        { field: 'idempotencyKey' },
      );
    }
    if (typeof input.occurredAt !== 'string' || !input.occurredAt.trim()) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'occurredAt is required as an ISO 8601 timestamp',
        400,
        { field: 'occurredAt' },
      );
    }
    const ms = Date.parse(input.occurredAt);
    if (!Number.isFinite(ms)) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'occurredAt is not a valid ISO 8601 timestamp',
        400,
        { field: 'occurredAt' },
      );
    }
    const occurredAt = new Date(ms);
    const ageMs = now.getTime() - ms;
    if (ageMs > this.windows.maxLatenessMs) {
      throw new MeterError(
        ErrorCode.EVENT_TOO_OLD,
        'events older than the configured lateness window cannot be backfilled',
        422,
        {
          field: 'occurredAt',
          occurredAt: occurredAt.toISOString(),
          oldestAllowed: new Date(
            now.getTime() - this.windows.maxLatenessMs,
          ).toISOString(),
        },
      );
    }
    if (ms > now.getTime() + this.windows.futureGraceMs) {
      throw new MeterError(
        ErrorCode.EVENT_IN_FUTURE,
        'occurredAt is too far in the future',
        422,
        { field: 'occurredAt', occurredAt: occurredAt.toISOString() },
      );
    }
    return occurredAt;
  }

  async ingest(rawInput: Partial<IngestEventInput>): Promise<IngestResult> {
    const now = new Date();
    const input = rawInput as IngestEventInput;
    const occurredAt = this.validate(input, now);

    const client = await this.pool.connect();
    try {
      const tenantRes = await client.query<TenantRow>(
        'SELECT timezone, billing_anchor_day FROM tenants WHERE id = $1',
        [input.tenantId],
      );
      const tenant = tenantRes.rows[0];
      if (!tenant) {
        throw new MeterError(
          ErrorCode.UNKNOWN_TENANT,
          `unknown tenant: ${input.tenantId}`,
          404,
          { field: 'tenantId' },
        );
      }

      const parts = localParts(occurredAt, tenant.timezone);
      const hourKey = hourBucketKey(parts);
      const dKey = dayKey(parts);
      const cycle = cycleRange(parts, tenant.billing_anchor_day);
      const fp = fingerprint(input, occurredAt);

      try {
        await client.query('BEGIN');

        // 1) Record the raw event (rolled back if the dedup claim fails).
        const eventRes = await client.query<{ id: string }>(
          `INSERT INTO usage_events (tenant_id, metric, value, occurred_at, idempotency_key)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            input.tenantId,
            input.metric,
            BigInt(input.value),
            occurredAt.toISOString(),
            input.idempotencyKey,
          ],
        );
        const eventId = String(eventRes.rows[0]!.id);

        // 2) Reclaim an expired claim (older than the idempotency window) so
        //    the key can be reused. The cutoff is parameterized from config —
        //    no hard-coded SQL interval.
        const claimCutoff = new Date(
          now.getTime() - this.windows.idempotencyWindowMs,
        );
        await client.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id = $1
              AND idempotency_key = $2
              AND created_at < $3::timestamptz`,
          [input.tenantId, input.idempotencyKey, claimCutoff.toISOString()],
        );

        // 3) Claim the key. PK makes concurrent claims safe; a conflict means
        //    a live claim from the last 24h exists.
        const claimRes = await client.query(
          `INSERT INTO idempotency_keys (tenant_id, idempotency_key, fingerprint, event_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
          [input.tenantId, input.idempotencyKey, fp, eventId],
        );

        if (claimRes.rowCount === 0) {
          const existing = await client.query<{ fingerprint: string }>(
            `SELECT fingerprint FROM idempotency_keys
              WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenantId, input.idempotencyKey],
          );
          await client.query('ROLLBACK');
          if (existing.rows[0]?.fingerprint === fp) {
            // Same request replayed inside the 24h window: count once.
            return { status: 'duplicate' };
          }
          throw new MeterError(
            ErrorCode.IDEMPOTENCY_CONFLICT,
            'idempotency key was already used in the last 24 hours with a different payload',
            409,
            { field: 'idempotencyKey' },
          );
        }

        // 4) Incremental rollups — no read-time aggregation, ever.
        await this.applyRollups(
          client,
          input,
          hourKey,
          dKey,
          cycle.start,
          cycle.end,
        );

        await client.query('COMMIT');
        return { status: 'accepted', eventId };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  }

  private async applyRollups(
    client: PoolClient,
    input: IngestEventInput,
    hourKey: string,
    dayKeyVal: string,
    cycleStart: string,
    cycleEnd: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO usage_agg_hourly (tenant_id, metric, bucket_hour, total, event_count, updated_at)
       VALUES ($1, $2, $3::timestamp, $4, 1, now())
       ON CONFLICT (tenant_id, metric, bucket_hour) DO UPDATE SET
         total = usage_agg_hourly.total + EXCLUDED.total,
         event_count = usage_agg_hourly.event_count + 1,
         updated_at = now()`,
      [input.tenantId, input.metric, hourKey, BigInt(input.value)],
    );

    await client.query(
      `INSERT INTO usage_agg_daily (tenant_id, metric, bucket_day, total, event_count, updated_at)
       VALUES ($1, $2, $3::date, $4, 1, now())
       ON CONFLICT (tenant_id, metric, bucket_day) DO UPDATE SET
         total = usage_agg_daily.total + EXCLUDED.total,
         event_count = usage_agg_daily.event_count + 1,
         updated_at = now()`,
      [input.tenantId, input.metric, dayKeyVal, BigInt(input.value)],
    );

    await client.query(
      `INSERT INTO usage_agg_cycle (tenant_id, metric, cycle_start, cycle_end, total, event_count, updated_at)
       VALUES ($1, $2, $3::date, $4::date, $5, 1, now())
       ON CONFLICT (tenant_id, metric, cycle_start) DO UPDATE SET
         total = usage_agg_cycle.total + EXCLUDED.total,
         event_count = usage_agg_cycle.event_count + 1,
         updated_at = now()`,
      [
        input.tenantId,
        input.metric,
        cycleStart,
        cycleEnd,
        BigInt(input.value),
      ],
    );
  }
}
