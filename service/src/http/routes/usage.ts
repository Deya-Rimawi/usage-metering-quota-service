import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import type { Clock } from '../../domain/period';
import * as usage from '../../services/usage';
import { decodeCursor, encodeCursor } from '../pagination';
import { historyItem, pageQuery, periodQuery, usageResponse, userIdSchema, userUsageResponse } from '../schemas';

export function usageRoutes(app: FastifyInstance, pool: pg.Pool, clock: Clock) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ userId: userIdSchema });

  r.get(
    '/usage',
    {
      schema: {
        tags: ['Usage'], summary: 'Account usage for a UTC month, with every user',
        description: 'Defaults to the current month. `remaining` is only reported for the current month (null for past months).',
        querystring: pageQuery.extend({ period: periodQuery.optional() }), response: { 200: usageResponse },
      },
    },
    async (req) => {
      const out = await usage.accountUsage(pool, clock, req.account.id, req.query.period, req.query.limit, decodeCursor(req.query.cursor));
      const { next, ...rest } = out;
      return { ...rest, nextCursor: encodeCursor(next) };
    },
  );

  r.get(
    '/users/:userId/usage',
    {
      schema: {
        tags: ['Usage'], summary: "One user's usage for a UTC month, plus the account they draw from",
        params, querystring: z.object({ period: periodQuery.optional() }), response: { 200: userUsageResponse },
      },
    },
    (req) => usage.userUsage(pool, clock, req.account.id, req.params.userId, req.query.period),
  );

  r.get(
    '/users/:userId/limits',
    {
      schema: {
        tags: ['Usage'], summary: 'Plans and limits currently applied to a user and their account, with remaining units this month',
        params, response: { 200: userUsageResponse },
      },
    },
    (req) => usage.userUsage(pool, clock, req.account.id, req.params.userId),
  );

  r.get(
    '/requests',
    {
      schema: {
        tags: ['History'], summary: 'Request history, newest first',
        description: 'Every decision, accepted or rejected, with the limits that applied when it was made. Cursor-paginated.',
        querystring: pageQuery.extend({
          userId: userIdSchema.optional(),
          period: periodQuery.optional(),
          accepted: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        }),
        response: { 200: z.object({ requests: z.array(historyItem), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const { limit, cursor, ...filters } = req.query;
      const { requests, next } = await usage.history(pool, req.account.id, { limit, after: decodeCursor(cursor), ...filters });
      return { requests, nextCursor: encodeCursor(next) };
    },
  );
}
