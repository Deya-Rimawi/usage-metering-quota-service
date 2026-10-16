import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { unauthorized } from '../domain/errors';
import type { AccountRow } from '../repositories/accounts';
import { authenticate } from '../services/accounts';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountRow;
    /** Set on the account-creation route: true if the caller presented the valid admin token. */
    isAdmin: boolean;
  }
}

/** Resolves X-API-Key to an account. Everything downstream scopes queries by `req.account.id`, never by client input. */
export const apiKeyAuth = (pool: pg.Pool) => async (req: FastifyRequest, _reply: FastifyReply) => {
  const header = req.headers['x-api-key'];
  req.account = await authenticate(pool, typeof header === 'string' ? header : undefined);
};

/** Constant-time comparison of a presented admin token with the real one. */
export function isAdminToken(given: unknown, token: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Guards the admin-only routes (key recovery). */
export const adminAuth = (token: string) => async (req: FastifyRequest) => {
  if (!isAdminToken(req.headers['x-admin-token'], token)) throw unauthorized('Missing or invalid admin token');
};

/**
 * Guards account creation. With a valid admin token the caller is an operator (`isAdmin`). With NO token the caller is
 * anonymous, which is allowed only when self-service signup is on. A token that is present but wrong is always
 * refused, never silently downgraded to a signup: an operator script with a typo should fail loudly.
 */
export const accountCreationAuth = (token: string, openSignup: boolean) => async (req: FastifyRequest) => {
  if (req.headers['x-admin-token'] !== undefined) {
    if (!isAdminToken(req.headers['x-admin-token'], token)) throw unauthorized('Missing or invalid admin token');
    req.isAdmin = true;
    return;
  }
  if (!openSignup) throw unauthorized('Missing or invalid admin token');
  req.isAdmin = false;
};
