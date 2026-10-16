import type pg from 'pg';
import { conflict, forbidden, notFound } from '../domain/errors';
import type { Plan } from '../domain/types';
import { isUniqueViolation } from '../repositories/db';
import * as plans from '../repositories/plans';
import * as users from '../repositories/users';
import { resolvePlan } from './plans';

/** Keeps one key holder from growing the database without bound (see docs/ASSUMPTIONS.md). */
export const MAX_USERS_PER_ACCOUNT = 100_000;

export interface UserView { userId: string; plan: Plan; createdAt: string }

async function requireUser(pool: pg.Pool, accountId: string, userId: string) {
  const row = await users.find(pool, accountId, userId);
  if (!row) throw notFound('User'); // also what a user of another account looks like: no existence leak
  return row;
}

async function toView(pool: pg.Pool, accountId: string, row: users.UserRow): Promise<UserView> {
  const plan = await plans.getVisible(pool, accountId, row.planId);
  return { userId: row.userId, plan: plan!, createdAt: row.createdAt };
}

export async function createUser(pool: pg.Pool, accountId: string, input: { userId: string; planId: string }) {
  await resolvePlan(pool, accountId, input.planId, 'user');
  if ((await users.countForAccount(pool, accountId, MAX_USERS_PER_ACCOUNT)) >= MAX_USERS_PER_ACCOUNT) {
    throw forbidden('account_limit_reached', `An account may have at most ${MAX_USERS_PER_ACCOUNT} users`);
  }
  try {
    return toView(pool, accountId, await users.insert(pool, accountId, input.userId, input.planId));
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('user_exists', `User '${input.userId}' already exists in this account`);
    throw e;
  }
}

export async function getUser(pool: pg.Pool, accountId: string, userId: string) {
  return toView(pool, accountId, await requireUser(pool, accountId, userId));
}

export async function listUsers(pool: pg.Pool, accountId: string, limit: number, after?: { t: string; id: string }) {
  const rows = await users.list(pool, accountId, limit + 1, after);
  const page = rows.slice(0, limit);
  const byId = new Map((await plans.listVisible(pool, accountId)).map((p) => [p.id, p]));
  return {
    users: page.map((r) => ({ userId: r.userId, plan: byId.get(r.planId)!, createdAt: r.createdAt })),
    next: rows.length > limit ? { t: page[page.length - 1]!.createdAtRaw, id: page[page.length - 1]!.uid } : null,
  };
}

export async function setUserPlan(pool: pg.Pool, accountId: string, userId: string, planId: string) {
  await requireUser(pool, accountId, userId);
  await resolvePlan(pool, accountId, planId, 'user');
  await users.setPlan(pool, accountId, userId, planId); // usage untouched: switching never grants a fresh allowance
  return getUser(pool, accountId, userId);
}
