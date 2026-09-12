import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Windows } from '../config.js';
import { ErrorCode, MeterError } from '../errors.js';
import { IngestService } from '../ingest/service.js';
import { QueryService, type Granularity } from '../query/service.js';
import { TenantService } from '../tenants/service.js';

export interface RouteDeps {
  pool: Pool;
  windows?: Windows;
}

const GRANULARITIES = new Set(['hourly', 'daily', 'cycle']);

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const ingest = new IngestService(deps.pool, deps.windows);
  const query = new QueryService(deps.pool);
  const tenants = new TenantService(deps.pool);

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Provisioning (no admin UI yet; kept minimal and machine-facing).
  app.put('/v1/tenants/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = await tenants.upsert({
      id: params.id,
      displayName: body.displayName as string,
      timezone: body.timezone as string,
      billingAnchorDay: body.billingAnchorDay as number | undefined,
    });
    return reply.code(200).send({
      id: row.id,
      displayName: row.display_name,
      timezone: row.timezone,
      billingAnchorDay: row.billing_anchor_day,
    });
  });

  // Usage event ingestion.
  app.post('/v1/usage-events', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await ingest.ingest({
      tenantId: body.tenantId as string,
      metric: body.metric as string,
      value: body.value as number,
      occurredAt: body.occurredAt as string,
      idempotencyKey: body.idempotencyKey as string,
    });
    return reply
      .code(result.status === 'accepted' ? 202 : 200)
      .send({
        status: result.status,
        ...(result.eventId ? { eventId: result.eventId } : {}),
      });
  });

  // Read pre-computed rollups only; never aggregates raw events at query time.
  app.get('/v1/usage', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const granularity = (q.granularity ?? 'hourly') as Granularity;
    if (!GRANULARITIES.has(granularity)) {
      throw new MeterError(
        ErrorCode.VALIDATION_ERROR,
        'granularity must be one of: hourly, daily, cycle',
        400,
        { field: 'granularity' },
      );
    }
    return query.usage({
      tenantId: String(q.tenantId ?? ''),
      metric: String(q.metric ?? ''),
      granularity,
      from: q.from,
      to: q.to,
    });
  });
}
