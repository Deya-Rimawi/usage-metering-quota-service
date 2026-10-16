import type pg from 'pg';
import { notFound, unauthorized } from '../domain/errors';
import type { Plan } from '../domain/types';
import * as accounts from '../repositories/accounts';
import { generateApiKey, hashApiKey } from './apiKeys';
import { getPlan, resolvePlan } from './plans';

export interface AccountView { id: string; name: string; externalId: string | null; plan: Plan; createdAt: string }

async function view(db: pg.Pool, row: accounts.AccountRow): Promise<AccountView> {
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
export async function createAccount(pool: pg.Pool, input: { name: string; planId: string; externalId?: string }): Promise<CreatedAccount> {
  const existing = async (): Promise<CreatedAccount | null> => {
    const row = input.externalId ? await accounts.findByExternalId(pool, input.externalId) : null;
    return row ? { created: false, account: await view(pool, row), apiKey: null } : null;
  };
  const already = await existing();
  if (already) return already;

  await resolvePlan(pool, null, input.planId, 'account'); // predefined only: the account does not exist yet
  const apiKey = generateApiKey();
  const row = await accounts.insert(pool, input.name, hashApiKey(apiKey), input.planId, input.externalId ?? null);
  if (!row) return (await existing())!; // two creations raced; the other one won
  return { created: true, account: await view(pool, row), apiKey };
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
