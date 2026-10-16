import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import * as accounts from '../../services/accounts';
import { adminAuth } from '../auth';
import { accountSchema } from '../schemas';

export function adminRoutes(app: FastifyInstance, pool: pg.Pool, adminToken: string) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/accounts',
    {
      onRequest: adminAuth(adminToken),
      schema: {
        body: z.object({ name: z.string().min(1).max(200), planId: z.string().default('starter') }),
        response: { 201: z.object({ account: accountSchema, apiKey: z.string() }) },
      },
    },
    async (req, reply) => reply.code(201).send(await accounts.createAccount(pool, req.body)),
  );
}

export function accountRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/account', { schema: { response: { 200: accountSchema } } }, (req) => accounts.getAccount(pool, req.account.id));
  r.put(
    '/account/plan',
    { schema: { body: z.object({ planId: z.string() }), response: { 200: accountSchema } } },
    (req) => accounts.setAccountPlan(pool, req.account.id, req.body.planId),
  );
  r.post('/account/api-key/rotate', { schema: { response: { 200: z.object({ apiKey: z.string() }) } } }, (req) =>
    accounts.rotateApiKey(pool, req.account.id),
  );
}
