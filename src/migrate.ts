#!/usr/bin/env tsx
import { config } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';

const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  console.log('migrations applied');
} finally {
  await pool.end();
}
