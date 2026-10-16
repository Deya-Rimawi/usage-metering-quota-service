import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../../config';
import * as accounts from '../../services/accounts';
import { adminAuth } from '../auth';
import { accountSchema, planIdSchema, text } from '../schemas';

export function adminRoutes(app: FastifyInstance, pool: pg.Pool, config: Pick<Config, 'ADMIN_TOKEN' | 'ADMIN_RATE_LIMIT_PER_MIN'>) {
  const adminOnly = {
    // Order matters: the rate limiter is an `onRequest` hook and must see every attempt, including the ones the
    // token check rejects, otherwise guessing the token would not be throttled. So the check runs later.
    config: { rateLimit: { max: config.ADMIN_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
    preValidation: adminAuth(config.ADMIN_TOKEN),
  };
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/accounts',
    {
      ...adminOnly,
      schema: {
        tags: ['Accounts'], summary: 'Create an account and issue its API key (admin only)',
        description: 'Requires `X-Admin-Token`. The `apiKey` in the response is shown once and never stored in plain form.',
        security: [{ adminToken: [] }],
        body: z.object({ name: text(200), planId: planIdSchema.default('starter') }),
        response: { 201: z.object({ account: accountSchema, apiKey: z.string() }) },
      },
    },
    async (req, reply) => reply.code(201).send(await accounts.createAccount(pool, req.body)),
  );

  // Lost-key recovery: the account's own rotate endpoint needs the old key, so an admin needs a way in.
  r.post(
    '/accounts/:accountId/api-key/rotate',
    {
      ...adminOnly,
      schema: {
        tags: ['Accounts'], summary: "Issue a new API key for an account (admin only; for a lost key)",
        security: [{ adminToken: [] }],
        params: z.object({ accountId: z.string().uuid() }),
        response: { 200: z.object({ apiKey: z.string() }) },
      },
    },
    (req) => accounts.rotateApiKey(pool, req.params.accountId),
  );
}

export function accountRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/account', { schema: { tags: ['Accounts'], summary: 'The calling account, its plan and limits', response: { 200: accountSchema } } }, (req) => accounts.getAccount(pool, req.account.id));
  r.put(
    '/account/plan',
    { schema: { tags: ['Accounts'], summary: "Change the account's plan (usage is preserved)", body: z.object({ planId: planIdSchema }), response: { 200: accountSchema } } },
    (req) => accounts.setAccountPlan(pool, req.account.id, req.body.planId),
  );
  r.post('/account/api-key/rotate', { schema: { tags: ['Accounts'], summary: 'Issue a new API key; the old one stops working immediately', response: { 200: z.object({ apiKey: z.string() }) } } }, (req) =>
    accounts.rotateApiKey(pool, req.account.id),
  );
}
