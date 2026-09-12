import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const app = await buildApp({ pool });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`meterd listening on ${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
