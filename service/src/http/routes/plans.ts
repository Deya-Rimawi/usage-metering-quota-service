import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import * as plans from '../../services/plans';
import { allowanceSchema, perRequestSchema, planIdSchema, planSchema, text } from '../schemas';

export function planRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ planId: planIdSchema });

  r.get('/plans', { schema: { tags: ['Plans'], summary: 'Predefined plans plus your custom plans', response: { 200: z.object({ plans: z.array(planSchema) }) } } }, async (req) => ({
    plans: await plans.listPlans(pool, req.account.id),
  }));

  r.post(
    '/plans',
    {
      schema: {
        tags: ['Plans'], summary: 'Create a custom plan',
        description: '`null` for a limit means unlimited. Any number of users may share one plan; each keeps separate usage.',
        body: z.object({
          kind: z.enum(['account', 'user']),
          name: text(100),
          monthlyAllowance: allowanceSchema.default(null),
          dailyAllowance: allowanceSchema.default(null),
          maxPerRequest: perRequestSchema.default(null),
        }),
        response: { 201: planSchema },
      },
    },
    async (req, reply) => reply.code(201).send(await plans.createPlan(pool, req.account.id, req.body)),
  );

  r.get('/plans/:planId', { schema: { tags: ['Plans'], summary: 'Get a plan', params, response: { 200: planSchema } } }, (req) =>
    plans.getPlan(pool, req.account.id, req.params.planId),
  );

  // Partial update. `null` means "unlimited"; omitting a field leaves it unchanged.
  r.patch(
    '/plans/:planId',
    {
      schema: {
        tags: ['Plans'], summary: 'Edit a custom plan (applies to the next request)',
        description: 'Partial update. Omitted fields are unchanged, `null` means unlimited. Predefined plans return 403.',
        params,
        body: z.object({ name: text(100), monthlyAllowance: allowanceSchema, dailyAllowance: allowanceSchema, maxPerRequest: perRequestSchema }).partial(),
        response: { 200: planSchema },
      },
    },
    (req) => plans.updatePlan(pool, req.account.id, req.params.planId, req.body),
  );
}
