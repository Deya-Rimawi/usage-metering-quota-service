import type pg from 'pg';
import { forbidden, invalid, notFound, conflict } from '../domain/errors';
import type { Plan, PlanKind } from '../domain/types';
import { isUniqueViolation, type Db } from '../repositories/db';
import * as plans from '../repositories/plans';

/** Loads a plan the account may use (predefined or its own) and checks it is the right kind for the target. */
/** `accountId` null = predefined plans only (an account being created has no custom plans yet). */
export async function resolvePlan(db: Db, accountId: string | null, planId: string, kind: PlanKind): Promise<Plan> {
  const plan = await plans.getVisible(db, accountId, planId);
  if (!plan) throw notFound('Plan');
  if (plan.kind !== kind) throw invalid('wrong_plan_kind', `Plan '${planId}' is a ${plan.kind} plan; a ${kind} plan is required`);
  return plan;
}

/** Keeps one key holder from growing the database without bound (see docs/ASSUMPTIONS.md). */
export const MAX_CUSTOM_PLANS_PER_ACCOUNT = 100;

export const listPlans = (db: Db, accountId: string) => plans.listVisible(db, accountId);

export async function getPlan(db: Db, accountId: string, planId: string): Promise<Plan> {
  const plan = await plans.getVisible(db, accountId, planId);
  if (!plan) throw notFound('Plan');
  return plan;
}

export async function createPlan(
  pool: pg.Pool, accountId: string,
  input: { kind: PlanKind; name: string; monthlyAllowance: number | null; maxPerRequest: number | null },
): Promise<Plan> {
  if ((await plans.countOwned(pool, accountId, MAX_CUSTOM_PLANS_PER_ACCOUNT)) >= MAX_CUSTOM_PLANS_PER_ACCOUNT) {
    throw forbidden('account_limit_reached', `An account may have at most ${MAX_CUSTOM_PLANS_PER_ACCOUNT} custom plans`);
  }
  try {
    return await plans.insert(pool, accountId, input);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('plan_name_taken', `You already have a plan named '${input.name}'`);
    throw e;
  }
}

/** Takes effect for the next consume: limits are read from this row on every request. */
export async function updatePlan(
  pool: pg.Pool, accountId: string, planId: string,
  patch: { name?: string; monthlyAllowance?: number | null; maxPerRequest?: number | null },
): Promise<Plan> {
  const existing = await getPlan(pool, accountId, planId); // 404 if not visible to this account
  if (existing.predefined) throw forbidden('predefined_plan_read_only', 'Predefined plans cannot be modified; create a custom plan instead');
  try {
    const updated = await plans.updateOwned(pool, accountId, planId, patch);
    if (!updated) throw notFound('Plan');
    return updated;
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('plan_name_taken', `You already have a plan named '${patch.name}'`);
    throw e;
  }
}
