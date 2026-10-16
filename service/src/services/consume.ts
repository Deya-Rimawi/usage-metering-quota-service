import type pg from 'pg';
import { conflict, notFound } from '../domain/errors';
import { dayOf, periodLabel, periodOf, type Clock } from '../domain/period';
import { describe, evaluate, remainingToday, remainingUnits, type Level, type Limits, type RuleName, type Violation } from '../domain/rules';
import { withTx } from '../repositories/db';
import type { Gate } from './accountGate';
import * as usage from '../repositories/usage';

export interface SideReport {
  planId: string;
  planName: string;
  monthlyAllowance: number | null;
  maxPerRequest: number | null;
  used: number;
  remaining: number | null;
  /** The daily allowance (extra rule): the limit, units used on this UTC day, and units left today. */
  dailyAllowance: number | null;
  usedToday: number | null;
  remainingToday: number | null;
}

export interface ConsumeResult {
  requestId: string;
  userId: string;
  units: number;
  period: string;
  accepted: boolean;
  rule: RuleName | null;
  level: Level | null;
  message: string;
  violations: Violation[];
  account: SideReport;
  user: SideReport;
  replayed: boolean;
}

export const report = (planId: string, planName: string, limits: Limits, used: number, usedToday: number): SideReport => ({
  planId, planName, monthlyAllowance: limits.monthlyAllowance, maxPerRequest: limits.maxPerRequest,
  used, remaining: remainingUnits({ limits, used, usedToday }),
  dailyAllowance: limits.dailyAllowance, usedToday, remainingToday: remainingToday({ limits, used, usedToday }),
});

/**
 * Decide and (if accepted) record a consumption, atomically. See docs/CONCURRENCY.md.
 *
 * One transaction, READ COMMITTED, five round trips:
 *   BEGIN
 *   1. lock the account's counter row         -> all of this account's consumption queues here, in order
 *   2. read user, usage (month and day), plans, earlier decision for this requestId   (a NEW statement:
 *      sees everything the previous lock holder committed)
 *   3. evaluate (pure)
 *   4. one statement: log the decision + add units to the four counters (account/user x month/day) if accepted
 *   COMMIT
 * A retry (same requestId) finds the stored decision in step 2 and replays it. A rejection writes only
 * the log row: counters are untouched.
 */
export async function consume(
  pool: pg.Pool, clock: Clock, gate: Gate,
  accountId: string, input: { userId: string; units: number; requestId: string },
): Promise<ConsumeResult> {
  return gate(accountId, () => withTx(pool, async (tx) => {
    let period = periodOf(clock());
    let accountUsed = await usage.lockAccount(tx, accountId, period);
    // A request can queue across midnight UTC on the 1st. "Processed" means now that we hold the lock, so
    // if the month turned while we waited, charge the new month (its row is locked too; no cycle is possible).
    // The UTC day is taken from the same instant. All of an account's counters (month AND day) are written
    // only while holding this account's monthly row, so one lock still serializes everything.
    const processedAt = clock();
    if (periodOf(processedAt) !== period) {
      period = periodOf(processedAt);
      accountUsed = await usage.lockAccount(tx, accountId, period);
    }
    const day = dayOf(processedAt);
    const ctx = await usage.readContext(tx, accountId, input.userId, input.requestId, period, day);

    if (ctx.stored) return replay(ctx.stored, input);
    if (!ctx.uid || !ctx.user) throw notFound('User'); // unknown here, which also covers other accounts' users

    const violations = evaluate(
      input.units,
      { limits: ctx.user.limits, used: ctx.userUsed, usedToday: ctx.userUsedToday },
      { limits: ctx.account.limits, used: accountUsed, usedToday: ctx.accountUsedToday },
    );
    const accepted = violations.length === 0;
    const added = accepted ? input.units : 0;

    const applied = {
      account: report(ctx.account.planId, ctx.account.planName, ctx.account.limits, accountUsed + added, ctx.accountUsedToday + added),
      user: report(ctx.user.planId, ctx.user.planName, ctx.user.limits, ctx.userUsed + added, ctx.userUsedToday + added),
    };
    await usage.record(tx, {
      accountId, uid: ctx.uid, requestId: input.requestId, units: input.units, period, day, accepted,
      rule: violations[0]?.rule, level: violations[0]?.level, violations, applied,
    });

    return result({ ...input, period, accepted, violations, applied }, false);
  }));
}

/** A retry gets the original decision back, unchanged, and never counts twice. */
function replay(s: usage.StoredDecision, input: { userId: string; units: number; requestId: string }) {
  if (s.userId !== input.userId || s.units !== input.units) {
    throw conflict('idempotency_conflict', `requestId '${input.requestId}' was already used with a different user or amount`);
  }
  return result(
    { requestId: input.requestId, userId: s.userId, units: s.units, period: s.period, accepted: s.accepted, violations: s.violations, applied: s.applied },
    true,
  );
}

/** Decisions stored before the daily allowance existed have no daily fields; show them as "no daily limit". */
export const withDaily = (s: usage.SideSnapshot): SideReport => ({ dailyAllowance: null, usedToday: null, remainingToday: null, ...s });

function result(
  r: { requestId: string; userId: string; units: number; period: string; accepted: boolean; violations: Violation[]; applied: { account: usage.SideSnapshot; user: usage.SideSnapshot } },
  replayed: boolean,
): ConsumeResult {
  const primary = r.violations[0];
  return {
    requestId: r.requestId, userId: r.userId, units: r.units, period: periodLabel(r.period),
    accepted: r.accepted,
    rule: primary?.rule ?? null,
    level: primary?.level ?? null,
    message: primary ? describe(primary) : 'Accepted',
    violations: r.violations,
    account: withDaily(r.applied.account),
    user: withDaily(r.applied.user),
    replayed,
  };
}
