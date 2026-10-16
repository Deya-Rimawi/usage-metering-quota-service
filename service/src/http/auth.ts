import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { unauthorized } from '../domain/errors';
import type { AccountRow } from '../repositories/accounts';
import { authenticate } from '../services/accounts';

declare module 'fastify' {
  interface FastifyRequest { account: AccountRow }
}

/** Resolves X-API-Key to an account. Everything downstream scopes queries by `req.account.id`, never by client input. */
export const apiKeyAuth = (pool: pg.Pool) => async (req: FastifyRequest, _reply: FastifyReply) => {
  const header = req.headers['x-api-key'];
  req.account = await authenticate(pool, typeof header === 'string' ? header : undefined);
};

/** Guards account creation, the only operation that has no account yet. */
export const adminAuth = (token: string) => async (req: FastifyRequest) => {
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw unauthorized('Missing or invalid admin token');
};
