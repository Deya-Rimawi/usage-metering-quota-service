import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import * as plans from '../../services/plans';
import { allowanceSchema, perRequestSchema, planSchema } from '../schemas';

export function planRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ planId: z.string() });

  r.get('/plans', { schema: { response: { 200: z.object({ plans: z.array(planSchema) }) } } }, async (req) => ({
    plans: await plans.listPlans(pool, req.account.id),
  }));

  r.post(
    '/plans',
    {
      schema: {
        body: z.object({
          kind: z.enum(['account', 'user']),
          name: z.string().min(1).max(100),
          monthlyAllowance: allowanceSchema.default(null),
          maxPerRequest: perRequestSchema.default(null),
        }),
        response: { 201: planSchema },
      },
    },
    async (req, reply) => reply.code(201).send(await plans.createPlan(pool, req.account.id, req.body)),
  );

  r.get('/plans/:planId', { schema: { params, response: { 200: planSchema } } }, (req) =>
    plans.getPlan(pool, req.account.id, req.params.planId),
  );

  // Partial update. `null` means "unlimited"; omitting a field leaves it unchanged.
  r.patch(
    '/plans/:planId',
    {
      schema: {
        params,
        body: z.object({ name: z.string().min(1).max(100), monthlyAllowance: allowanceSchema, maxPerRequest: perRequestSchema }).partial(),
        response: { 200: planSchema },
      },
    },
    (req) => plans.updatePlan(pool, req.account.id, req.params.planId, req.body),
  );
}
