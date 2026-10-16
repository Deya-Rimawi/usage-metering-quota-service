import type pg from 'pg';
import { forbidden, notFound, unauthorized } from '../domain/errors';
import type { Plan } from '../domain/types';
import * as accounts from '../repositories/accounts';
import { withTx, type Db } from '../repositories/db';
import { generateApiKey, hashApiKey } from './apiKeys';
import { getPlan, resolvePlan } from './plans';

export interface AccountView { id: string; name: string; externalId: string | null; plan: Plan; createdAt: string }

async function view(db: Db, row: accounts.AccountRow): Promise<AccountView> {
  return { id: row.id, name: row.name, externalId: row.externalId, plan: await getPlan(db, row.id, row.planId), createdAt: row.createdAt };
}

export type CreatedAccount =
  | { created: true; account: AccountView; apiKey: string }
  | { created: false; account: AccountView; apiKey: null };

/**
 * Admin operation. The plain key is returned exactly once; only its hash is stored.
 *
 * Idempotent when the caller supplies an `externalId` (its own id for the customer): creating the same
 * externalId again returns the existing account with `created: false` and no key, so a provisioning call that is
 * retried after a timeout cannot make a duplicate account. (The key cannot be shown twice; if the first response
 * was lost, the admin rotate endpoint issues a new one.) Other fields only apply on the first creation.
 */
export async function createAccount(
  pool: Db, input: { name: string; planId: string; externalId?: string }, source: 'admin' | 'self_service' = 'admin',
): Promise<CreatedAccount> {
  const existing = async (): Promise<CreatedAccount | null> => {
    const row = input.externalId ? await accounts.findByExternalId(pool, input.externalId) : null;
    return row ? { created: false, account: await view(pool, row), apiKey: null } : null;
  };
  const already = await existing();
  if (already) return already;

  await resolvePlan(pool, null, input.planId, 'account'); // predefined only: the account does not exist yet
  const apiKey = generateApiKey();
  const row = await accounts.insert(pool, input.name, hashApiKey(apiKey), input.planId, input.externalId ?? null, source);
  if (!row) return (await existing())!; // two creations raced; the other one won
  return { created: true, account: await view(pool, row), apiKey };
}

/**
 * Self-service signup (only reachable when OPEN_SIGNUP is on): anyone may create an account and receives its key in
 * the response, with no operator in between. Never idempotent (no externalId: that would let an anonymous caller probe
 * which customer ids exist), and capped so the database cannot be filled without limit.
 */
const SIGNUP_LOCK = 727002; // arbitrary constant, like the migration lock

export async function signUp(pool: pg.Pool, input: { name: string; planId: string }, cap: number): Promise<CreatedAccount> {
  // "Count, then insert" must be one step or a burst of simultaneous signups could all pass the count. A short
  // transaction-scoped advisory lock makes the cap exact; it is only taken on this (low-volume) anonymous path.
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SIGNUP_LOCK]);
    if ((await accounts.countSelfService(tx, cap)) >= cap) {
      throw forbidden('signup_closed', 'Self-service signup is closed: the limit on self-service accounts was reached. Contact the operator.');
    }
    return createAccount(tx, input, 'self_service');
  });
}

export async function authenticate(pool: pg.Pool, key: string | undefined) {
  if (!key) throw unauthorized();
  const row = await accounts.findByKeyHash(pool, hashApiKey(key));
  if (!row) throw unauthorized();
  return row;
}

export async function getAccount(pool: pg.Pool, id: string) {
  return view(pool, await accounts.get(pool, id));
}

export async function setAccountPlan(pool: pg.Pool, id: string, planId: string) {
  await resolvePlan(pool, id, planId, 'account');
  await accounts.setPlan(pool, id, planId); // usage is keyed by month, not plan: nothing is reset
  return getAccount(pool, id);
}

/** Lost-key recovery. The old key stops working immediately. */
export async function rotateApiKey(pool: pg.Pool, id: string) {
  const apiKey = generateApiKey();
  const done = await accounts.setKeyHash(pool, id, hashApiKey(apiKey));
  if (!done.rowCount) throw notFound('Account');
  return { apiKey };
}
