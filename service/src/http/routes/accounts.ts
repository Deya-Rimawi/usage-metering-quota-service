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
        tags: ['Accounts'], summary: 'Create an account and issue its API key (admin only)',
        description: 'Requires `X-Admin-Token`. The `apiKey` in the response is shown once and never stored in plain form.',
        security: [{ adminToken: [] }],
        body: z.object({ name: z.string().min(1).max(200), planId: z.string().default('starter') }),
        response: { 201: z.object({ account: accountSchema, apiKey: z.string() }) },
      },
    },
    async (req, reply) => reply.code(201).send(await accounts.createAccount(pool, req.body)),
  );
}

export function accountRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/account', { schema: { tags: ['Accounts'], summary: 'The calling account, its plan and limits', response: { 200: accountSchema } } }, (req) => accounts.getAccount(pool, req.account.id));
  r.put(
    '/account/plan',
    { schema: { tags: ['Accounts'], summary: "Change the account's plan (usage is preserved)", body: z.object({ planId: z.string() }), response: { 200: accountSchema } } },
    (req) => accounts.setAccountPlan(pool, req.account.id, req.body.planId),
  );
  r.post('/account/api-key/rotate', { schema: { tags: ['Accounts'], summary: 'Issue a new API key; the old one stops working immediately', response: { 200: z.object({ apiKey: z.string() }) } } }, (req) =>
    accounts.rotateApiKey(pool, req.account.id),
  );
}
