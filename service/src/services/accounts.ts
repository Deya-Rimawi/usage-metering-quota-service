import type pg from 'pg';
import { notFound, unauthorized } from '../domain/errors';
import type { Plan } from '../domain/types';
import * as accounts from '../repositories/accounts';
import { generateApiKey, hashApiKey } from './apiKeys';
import { getPlan, resolvePlan } from './plans';

export interface AccountView { id: string; name: string; plan: Plan; createdAt: string }

async function view(db: pg.Pool, row: accounts.AccountRow): Promise<AccountView> {
  return { id: row.id, name: row.name, plan: await getPlan(db, row.id, row.planId), createdAt: row.createdAt };
}

/** Admin operation. The plain key is returned exactly once; only its hash is stored. */
export async function createAccount(pool: pg.Pool, input: { name: string; planId: string }) {
  await resolvePlan(pool, null, input.planId, 'account'); // predefined only: the account does not exist yet
  const apiKey = generateApiKey();
  const row = await accounts.insert(pool, input.name, hashApiKey(apiKey), input.planId);
  return { account: await view(pool, row), apiKey };
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
