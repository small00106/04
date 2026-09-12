import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, 'schema.sql');

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
}
