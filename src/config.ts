const env = process.env;

export interface Windows {
  /** Events older than now - maxLateness are rejected. */
  maxLatenessMs: number;
  /** A claim stays dedup-active for this long, then the key is reusable. */
  idempotencyWindowMs: number;
  /** Allowed clock skew for future-dated events. */
  futureGraceMs: number;
}

export interface AppConfig extends Windows {
  databaseUrl: string;
  port: number;
  host: string;
}

function positiveIntMs(
  source: NodeJS.ProcessEnv,
  name: string,
  fallbackMs: number,
): number {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (milliseconds), got: ${raw}`);
  }
  return n;
}

const DEFAULTS = {
  maxLatenessMs: 72 * 60 * 60 * 1000,
  idempotencyWindowMs: 24 * 60 * 60 * 1000,
  futureGraceMs: 5 * 60 * 1000,
};

export function loadConfig(source: NodeJS.ProcessEnv = env): AppConfig {
  return {
    databaseUrl:
      source.METERD_DATABASE_URL ??
      'postgres://meterd:meterd@127.0.0.1:5432/meterd',
    port: Number(source.METERD_PORT ?? 8080),
    host: source.METERD_HOST ?? '0.0.0.0',
    maxLatenessMs: positiveIntMs(source, 'METERD_MAX_LATENESS_MS', DEFAULTS.maxLatenessMs),
    idempotencyWindowMs: positiveIntMs(
      source,
      'METERD_IDEMPOTENCY_WINDOW_MS',
      DEFAULTS.idempotencyWindowMs,
    ),
    futureGraceMs: positiveIntMs(source, 'METERD_FUTURE_GRACE_MS', DEFAULTS.futureGraceMs),
  };
}

export const config: AppConfig = loadConfig();
