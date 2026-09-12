import pg from 'pg';

const { Pool, types } = pg;

// BIGINT comes back as text by default. Return a JS number whenever the value
// fits exactly in a safe integer; beyond 2^53 (e.g. astronomical byte counts)
// we deliberately KEEP THE STRING rather than silently rounding. JSON cannot
// carry BigInt, so a string past 2^53 preserves exactness; callers must treat
// `total` as `number | string` on the wire. Minor-unit monetary totals never
// approach this bound.
types.setTypeParser(20 /* int8 */, (v) => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
