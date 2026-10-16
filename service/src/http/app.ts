import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config';

export interface AppDeps {
  pool: pg.Pool;
  config: Config;
}

export function buildApp({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 100_000 });

  // Liveness: the process is up. Readiness: the database answers.
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' });
    }
  });

  return app;
}
