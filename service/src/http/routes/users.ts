import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import * as users from '../../services/users';
import { decodeCursor, encodeCursor } from '../pagination';
import { pageQuery, userIdSchema, userSchema } from '../schemas';

export function userRoutes(app: FastifyInstance, pool: pg.Pool) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ userId: userIdSchema });

  r.post(
    '/users',
    { schema: { tags: ['Users'], summary: 'Register a user under the account', body: z.object({ userId: userIdSchema, planId: z.string().default('basic') }), response: { 201: userSchema } } },
    async (req, reply) => reply.code(201).send(await users.createUser(pool, req.account.id, req.body)),
  );

  r.get(
    '/users',
    { schema: { tags: ['Users'], summary: 'List users (cursor-paginated)', querystring: pageQuery, response: { 200: z.object({ users: z.array(userSchema), nextCursor: z.string().nullable() }) } } },
    async (req) => {
      const { users: page, next } = await users.listUsers(pool, req.account.id, req.query.limit, decodeCursor(req.query.cursor));
      return { users: page, nextCursor: encodeCursor(next) };
    },
  );

  r.get('/users/:userId', { schema: { tags: ['Users'], summary: 'Get a user and their plan', params, response: { 200: userSchema } } }, (req) =>
    users.getUser(pool, req.account.id, req.params.userId),
  );

  r.put(
    '/users/:userId/plan',
    { schema: { tags: ['Users'], summary: "Change a user's plan (usage is preserved)", params, body: z.object({ planId: z.string() }), response: { 200: userSchema } } },
    (req) => users.setUserPlan(pool, req.account.id, req.params.userId, req.body.planId),
  );
}
