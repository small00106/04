import type { Pool } from 'pg';
import { ErrorCode, MeterError } from '../errors.js';
import {
  dayKey,
  hourBucketKey,
  localParts,
} from '../time/buckets.js';

export type Granularity = 'hourly' | 'daily' | 'cycle';

export interface UsageQuery {
  tenantId: string;
  metric: string;
  granularity: Granularity;
  from?: string; // ISO 8601 inclusive
  to?: string; // ISO 8601 exclusive
}

interface BucketRow {
  bucket?: string;
  cycle_start?: string;
  cycle_end?: string;
  total: number | string;
  event_count: number;
}

export class QueryService {
  constructor(private pool: Pool) {}

  async usage(q: UsageQuery): Promise<unknown> {
    if (!q.tenantId) {
      throw new MeterError(ErrorCode.VALIDATION_ERROR, 'tenantId is required', 400, {
        field: 'tenantId',
      });
    }
    if (!q.metric) {
      throw new MeterError(ErrorCode.VALIDATION_ERROR, 'metric is required', 400, {
        field: 'metric',
      });
    }

    // Buckets were cut using the tenant's CONFIGURED timezone at ingest time;
    // query bounds must be interpreted in that same timezone. A client-supplied
    // timezone here would silently shift the boundary, so we never accept one.
    const tenantRes = await this.pool.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [q.tenantId],
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) {
      throw new MeterError(
        ErrorCode.UNKNOWN_TENANT,
        `unknown tenant: ${q.tenantId}`,
        404,
        { field: 'tenantId' },
      );
    }
    const timezone = tenant.timezone;

    const from = q.from ? new Date(Date.parse(q.from)) : undefined;
    const to = q.to ? new Date(Date.parse(q.to)) : undefined;
    if ((q.from && !from) || (q.to && !to)) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'from/to must be ISO 8601 timestamps',
        400,
      );
    }
    if (from && to && to <= from) {
      throw new MeterError(ErrorCode.VALIDATION_ERROR, 'to must be after from', 400);
    }

    // Bounds are converted to tenant-local bucket keys up front, so the
    // tz-free stored buckets compare correctly regardless of session TimeZone.
    const params: unknown[] = [q.tenantId, q.metric];
    let where = 'tenant_id = $1 AND metric = $2';

    if (q.granularity === 'hourly') {
      if (from) {
        params.push(hourBucketKey(localParts(from, timezone)));
        where += ` AND bucket_hour >= $${params.length}::timestamp`;
      }
      if (to) {
        params.push(hourBucketKey(localParts(to, timezone)));
        where += ` AND bucket_hour < $${params.length}::timestamp`;
      }
      const res = await this.pool.query<BucketRow>(
        `SELECT to_char(bucket_hour, 'YYYY-MM-DD HH24:00:00') AS bucket,
                total, event_count
           FROM usage_agg_hourly
          WHERE ${where}
          ORDER BY bucket_hour`,
        params,
      );
      return {
        tenantId: q.tenantId,
        metric: q.metric,
        granularity: 'hourly',
        timezone,
        buckets: res.rows.map((r) => ({
          bucket: r.bucket,
          total: r.total,
          eventCount: r.event_count,
        })),
      };
    }

    if (q.granularity === 'daily') {
      if (from) {
        params.push(dayKey(localParts(from, timezone)));
        where += ` AND bucket_day >= $${params.length}::date`;
      }
      if (to) {
        params.push(dayKey(localParts(to, timezone)));
        where += ` AND bucket_day < $${params.length}::date`;
      }
      const res = await this.pool.query<BucketRow>(
        `SELECT to_char(bucket_day, 'YYYY-MM-DD') AS bucket,
                total, event_count
           FROM usage_agg_daily
          WHERE ${where}
          ORDER BY bucket_day`,
        params,
      );
      return {
        tenantId: q.tenantId,
        metric: q.metric,
        granularity: 'daily',
        timezone,
        buckets: res.rows.map((r) => ({
          bucket: r.bucket,
          total: r.total,
          eventCount: r.event_count,
        })),
      };
    }

    // cycle: a cycle [start,end) overlaps instant range [from,to) when
    // end > localDate(from) AND start < localDate(to). Filtering is optional;
    // with no bounds all cycle rows for the key are returned.
    const cycleParams = params.slice();
    let cycleWhere = where;
    if (from) {
      cycleParams.push(dayKey(localParts(from, timezone)));
      cycleWhere += ` AND cycle_end > $${cycleParams.length}::date`;
    }
    if (to) {
      cycleParams.push(dayKey(localParts(to, timezone)));
      cycleWhere += ` AND cycle_start < $${cycleParams.length}::date`;
    }
    const res = await this.pool.query<BucketRow>(
      `SELECT to_char(cycle_start, 'YYYY-MM-DD') AS cycle_start,
              to_char(cycle_end, 'YYYY-MM-DD') AS cycle_end,
              total, event_count
         FROM usage_agg_cycle
        WHERE ${cycleWhere}
        ORDER BY cycle_start`,
      cycleParams,
    );
    return {
      tenantId: q.tenantId,
      metric: q.metric,
      granularity: 'cycle',
      timezone,
      buckets: res.rows.map((r) => ({
        cycleStart: r.cycle_start,
        cycleEnd: r.cycle_end,
        total: r.total,
        eventCount: r.event_count,
      })),
    };
  }
}
