import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import type { FastifyInstance } from 'fastify';

const ADMIN_URL =
  process.env.METERD_TEST_ADMIN_URL ??
  'postgres://postgres@127.0.0.1:5432/postgres';
const TEST_DB =
  process.env.METERD_TEST_DB ?? `meterd_test_${process.pid}_${randomBytes6()}`;

function randomBytes6(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

export interface TestHarness {
  app: FastifyInstance;
  pool: pg.Pool;
  databaseUrl: string;
}

export async function setupHarness(): Promise<TestHarness> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const databaseUrl = url.toString();

  const pool = createPool(databaseUrl);
  pool.on('error', (err) => console.error('idle pool error', err));
  await migrate(pool);
  const app = await buildApp({ pool });
  return { app, pool, databaseUrl };
}

export async function teardownHarness(h: TestHarness): Promise<void> {
  await h.app.close();
  await h.pool.end();
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
}
