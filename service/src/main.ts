import { DEMO_ADMIN_TOKEN, loadConfig } from './config';
import { createPool, waitForDatabase } from './db/pool';
import { migrate } from './db/migrate';
import { seedPlans } from './db/seed';
import { buildApp } from './http/app';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.PG_POOL_MAX);
  const app = buildApp({ pool, config });
  pool.on('error', (err) => app.log.error({ err }, 'idle database connection error (pool recovers by itself)'));

  await waitForDatabase(pool, { onRetry: (err, attempt) => app.log.warn({ attempt, reason: (err as Error).message }, 'waiting for the database') });
  const applied = await migrate(pool);
  await seedPlans(pool);
  app.log.info({ applied }, 'database ready');

  if (config.ADMIN_TOKEN === DEMO_ADMIN_TOKEN) {
    app.log.warn('ADMIN_TOKEN is the published demo value: anyone who can reach this port can create accounts. Set ADMIN_TOKEN before exposing the service.');
  }

  if (config.OPEN_SIGNUP) {
    app.log.warn('OPEN_SIGNUP is on: anyone who can reach this service can create an account and get an API key (rate-limited and capped). Make sure that is intended.');
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // Graceful shutdown: stop accepting requests, let in-flight transactions finish, close the pool.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
