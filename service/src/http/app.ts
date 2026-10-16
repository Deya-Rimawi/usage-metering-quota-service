import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { Config } from '../config';
import { apiKeyAuth } from './auth';
import { registerErrorHandling } from './errors';
import type { Clock } from '../domain/period';
import { accountRoutes, adminRoutes } from './routes/accounts';
import { consumeRoutes } from './routes/consume';
import { planRoutes } from './routes/plans';
import { userRoutes } from './routes/users';

export interface AppDeps {
  pool: pg.Pool;
  config: Config;
  /** Injectable so tests can move time across month boundaries. */
  clock?: Clock;
}

export function buildApp({ pool, config, clock = () => new Date() }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 100_000 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

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

  adminRoutes(app, pool, config.ADMIN_TOKEN);

  // Everything registered in this scope requires a valid X-API-Key.
  app.register(async (scope) => {
    scope.addHook('onRequest', apiKeyAuth(pool));
    accountRoutes(scope, pool);
    userRoutes(scope, pool);
    planRoutes(scope, pool);
    consumeRoutes(scope, pool, clock);
  });

  return app;
}
