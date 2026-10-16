import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import type { Clock } from '../../domain/period';
import type { Gate } from '../../services/accountGate';
import { consume } from '../../services/consume';
import { consumeResponse, MAX_PER_REQUEST, requestIdSchema, userIdSchema } from '../schemas';

export function consumeRoutes(app: FastifyInstance, pool: pg.Pool, clock: Clock, gate: Gate) {
  // A rejection is a normal business outcome, so it is HTTP 200 with accepted:false.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/consume',
    {
      schema: {
        tags: ['Consume'], summary: 'Consume units for a user if every account and user rule allows it',
        description: 'Always HTTP 200 for a decision: check `accepted`. A rejection consumes nothing. Retrying the same `requestId` returns the stored decision with `replayed: true`; the same id with a different user or amount is a 409.',
        body: z.object({
          userId: userIdSchema,
          units: z.number().int().min(1).max(MAX_PER_REQUEST),
          requestId: requestIdSchema,
        }),
        response: { 200: consumeResponse },
      },
    },
    (req) => consume(pool, clock, gate, req.account.id, req.body),
  );
}
