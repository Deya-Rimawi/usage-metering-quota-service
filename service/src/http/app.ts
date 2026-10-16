import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { Config } from '../config';
import { apiKeyAuth } from './auth';
import { registerErrorHandling } from './errors';
import type { Clock } from '../domain/period';
import { createGate } from '../services/accountGate';
import { accountRoutes, adminRoutes } from './routes/accounts';
import { consumeRoutes } from './routes/consume';
import { planRoutes } from './routes/plans';
import { usageRoutes } from './routes/usage';
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
  const gate = createGate(config.ACCOUNT_CONCURRENCY);

  // OpenAPI is generated from the same zod schemas that validate requests, so the docs cannot drift.
  app.register(swagger, {
    openapi: {
      info: {
        title: 'Usage Metering & Quota Service',
        version: '1.0.0',
        description: 'Tracks usage and decides whether users may consume units under an account plan and a user plan. Errors always look like `{ "error": { "code", "message", "details?" } }`.',
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          adminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  // Registered as plugins (not directly on the root) so swagger, loaded first, sees every route.
  app.register(async (open) => {
    // Liveness: the process is up. Readiness: the database answers.
    open.get('/health', { schema: { tags: ['Health'], summary: 'Liveness', security: [] } }, async () => ({ status: 'ok' }));
    open.get('/ready', { schema: { tags: ['Health'], summary: 'Readiness (database reachable)', security: [] } }, async (_req, reply) => {
      try {
        await pool.query('SELECT 1');
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'database_unavailable' });
      }
    });

    adminRoutes(open, pool, config.ADMIN_TOKEN);
  });

  // Everything registered in this scope requires a valid X-API-Key.
  app.register(async (scope) => {
    scope.addHook('onRequest', apiKeyAuth(pool));
    accountRoutes(scope, pool);
    userRoutes(scope, pool);
    planRoutes(scope, pool);
    consumeRoutes(scope, pool, clock, gate);
    usageRoutes(scope, pool, clock);
  });

  return app;
}
