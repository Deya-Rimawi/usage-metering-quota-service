import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import type { Clock } from '../../domain/period';
import { consume } from '../../services/consume';
import { MAX_PER_REQUEST, userIdSchema } from '../schemas';

const side = z.object({
  planId: z.string(), planName: z.string(),
  monthlyAllowance: z.number().nullable(), maxPerRequest: z.number().nullable(),
  used: z.number(), remaining: z.number().nullable(),
});

const response = z.object({
  requestId: z.string(), userId: z.string(), units: z.number(), period: z.string(),
  accepted: z.boolean(),
  rule: z.enum(['max_per_request', 'monthly_allowance']).nullable(),
  level: z.enum(['account', 'user']).nullable(),
  message: z.string(),
  violations: z.array(z.object({
    level: z.enum(['account', 'user']), rule: z.enum(['max_per_request', 'monthly_allowance']),
    limit: z.number(), requested: z.number(), remaining: z.number().nullable(),
  })),
  account: side, user: side, replayed: z.boolean(),
});

export function consumeRoutes(app: FastifyInstance, pool: pg.Pool, clock: Clock) {
  // A rejection is a normal business outcome, so it is HTTP 200 with accepted:false.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/consume',
    {
      schema: {
        body: z.object({
          userId: userIdSchema,
          units: z.number().int().min(1).max(MAX_PER_REQUEST),
          requestId: z.string().min(1).max(200),
        }),
        response: { 200: response },
      },
    },
    (req) => consume(pool, clock, req.account.id, req.body),
  );
}
