const env = process.env;

export const config = {
  databaseUrl:
    env.METERD_DATABASE_URL ??
    'postgres://meterd:meterd@127.0.0.1:5432/meterd',
  port: Number(env.METERD_PORT ?? 8080),
  host: env.METERD_HOST ?? '0.0.0.0',
  // Events older than now - this window are rejected.
  maxLatenessMs: 72 * 60 * 60 * 1000,
  // Replays of an idempotency key inside this window are deduplicated.
  idempotencyWindowMs: 24 * 60 * 60 * 1000,
  // Small grace for client clock skew on future-dated events.
  futureGraceMs: 5 * 60 * 1000,
};
