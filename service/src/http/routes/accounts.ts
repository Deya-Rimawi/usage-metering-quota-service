import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../../config';
import { forbidden } from '../../domain/errors';
import * as accounts from '../../services/accounts';
import { accountCreationAuth, adminAuth, isAdminToken } from '../auth';
import { accountSchema, planIdSchema, text } from '../schemas';

type AdminConfig = Pick<Config, 'ADMIN_TOKEN' | 'ADMIN_RATE_LIMIT_PER_MIN' | 'OPEN_SIGNUP' | 'SIGNUP_RATE_LIMIT_PER_MIN' | 'SIGNUP_MAX_ACCOUNTS'>;

export function adminRoutes(app: FastifyInstance, pool: pg.Pool, config: AdminConfig) {
  // Per-IP rate limit. A caller with the VALID admin token gets the generous limit; everyone else (self-service
  // signups and anyone guessing the token) gets the strict one. Order matters: the limiter is an `onRequest` hook
  // and must see every attempt, including the ones the token check rejects, so that check runs later.
  const rateLimit = {
    max: (req: { headers: Record<string, unknown> }) =>
      isAdminToken(req.headers['x-admin-token'], config.ADMIN_TOKEN) ? config.ADMIN_RATE_LIMIT_PER_MIN : config.SIGNUP_RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
  };
  const adminOnly = { config: { rateLimit }, preValidation: adminAuth(config.ADMIN_TOKEN) };
  const creation = { config: { rateLimit }, preValidation: accountCreationAuth(config.ADMIN_TOKEN, config.OPEN_SIGNUP) };
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/accounts',
    {
      ...creation,
      schema: {
        tags: ['Accounts'], summary: 'Create an account and issue its API key (admin token, or self-service when enabled)',
        description: 'With `X-Admin-Token` (operators and provisioning backends): idempotent when you pass `externalId` (your own id for the customer): creating it again returns the existing account with HTTP 200, `created: false` and `apiKey: null` instead of a duplicate; use the admin rotate endpoint if the first response was lost. Without a token: allowed only when the service runs with `OPEN_SIGNUP=true` (otherwise 401); `externalId` is then refused (403) and the request is strictly rate-limited and capped. The `apiKey` in the response is shown once and never stored in plain form. Other fields only apply on first creation.',
        security: [{ adminToken: [] }, {}],
        body: z.object({ name: text(200), planId: planIdSchema.default('starter'), externalId: text(200).optional() }),
        response: {
          201: z.object({ created: z.literal(true), account: accountSchema, apiKey: z.string() }),
          200: z.object({ created: z.literal(false), account: accountSchema, apiKey: z.null() }),
        },
      },
    },
    async (req, reply) => {
      // Idempotent get-or-create is for trusted backends only: for an anonymous caller it would reveal whether a
      // customer id exists (and return that account's details).
      if (!req.isAdmin && req.body.externalId !== undefined) {
        throw forbidden('external_id_requires_admin', 'externalId (idempotent provisioning) needs the admin token');
      }
      const out = req.isAdmin ? await accounts.createAccount(pool, req.body) : await accounts.signUp(pool, req.body, config.SIGNUP_MAX_ACCOUNTS);
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
