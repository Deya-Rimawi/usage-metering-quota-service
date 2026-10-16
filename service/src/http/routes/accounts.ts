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
        tags: ['Accounts'], summary: 'Create an account and issue its API key (admin only); idempotent with externalId',
        description: 'Requires `X-Admin-Token`. The `apiKey` in the response is shown once and never stored in plain form. If you pass `externalId` (your own id for the customer), creating it again returns the existing account with HTTP 200, `created: false` and `apiKey: null` instead of a duplicate; use the admin rotate endpoint if the first response was lost. Other fields only apply on first creation.',
        security: [{ adminToken: [] }],
        body: z.object({ name: text(200), planId: planIdSchema.default('starter'), externalId: text(200).optional() }),
        response: {
          201: z.object({ created: z.literal(true), account: accountSchema, apiKey: z.string() }),
          200: z.object({ created: z.literal(false), account: accountSchema, apiKey: z.null() }),
        },
      },
    },
    async (req, reply) => {
      const out = await accounts.createAccount(pool, req.body);
      return out.created ? reply.code(201).send(out) : reply.code(200).send(out);
    },
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
