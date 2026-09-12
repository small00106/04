import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import type { Windows } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

const ADMIN_URL =
  process.env.METERD_TEST_ADMIN_URL ??
  'postgres://postgres@127.0.0.1:5432/postgres';

function randomBytes6(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

export interface TestHarness {
  app: FastifyInstance;
  pool: pg.Pool;
  databaseUrl: string;
  /** Drop the database (called by teardown). */
  dbName: string;
}

export interface HarnessOptions {
  windows?: Windows;
  tag?: string;
}

export async function setupHarness(
  opts: HarnessOptions = {},
): Promise<TestHarness> {
  const dbName = `meterd_${opts.tag ?? 'test'}_${process.pid}_${randomBytes6()}`.replace(
    /[^a-zA-Z0-9_]/g,
    '_',
  );

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  const pool = createPool(databaseUrl);
  pool.on('error', (err) => console.error('idle pool error', err));
  await migrate(pool);
  const app = await buildApp({ pool, windows: opts.windows });
  return { app, pool, databaseUrl, dbName };
}

export async function teardownHarness(h: TestHarness): Promise<void> {
  await h.app.close();
  await h.pool.end();
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${h.dbName}`);
  await admin.end();
}
