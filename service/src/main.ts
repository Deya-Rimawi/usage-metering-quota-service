import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { seedPlans } from './db/seed';
import { buildApp } from './http/app';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.PG_POOL_MAX);
  const app = buildApp({ pool, config });

  const applied = await migrate(pool);
  await seedPlans(pool);
  app.log.info({ applied }, 'database ready');

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
