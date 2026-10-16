import type pg from 'pg';
import { conflict, notFound } from '../domain/errors';
import { periodLabel, periodOf, type Clock } from '../domain/period';
import { describe, evaluate, remainingUnits, type Level, type Limits, type RuleName, type Violation } from '../domain/rules';
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

export const report = (planId: string, planName: string, limits: Limits, used: number): SideReport => ({
  planId, planName, monthlyAllowance: limits.monthlyAllowance, maxPerRequest: limits.maxPerRequest,
  used, remaining: remainingUnits({ limits, used }),
});

/**
 * Decide and (if accepted) record a consumption, atomically. See docs/CONCURRENCY.md.
 *
 * One transaction, READ COMMITTED, five round trips:
 *   BEGIN
 *   1. lock the account's counter row         -> all of this account's consumption queues here, in order
 *   2. read user, usage, plans, earlier decision for this requestId   (a NEW statement: sees everything
 *      the previous lock holder committed)
 *   3. evaluate (pure)
 *   4. one statement: log the decision + add units to both counters if accepted
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
    const processedIn = periodOf(clock());
    if (processedIn !== period) {
      period = processedIn;
      accountUsed = await usage.lockAccount(tx, accountId, period);
    }
    const ctx = await usage.readContext(tx, accountId, input.userId, input.requestId, period);

    if (ctx.stored) return replay(ctx.stored, input);
    if (!ctx.uid || !ctx.user) throw notFound('User'); // unknown here, which also covers other accounts' users

    const violations = evaluate(
      input.units,
      { limits: ctx.user.limits, used: ctx.userUsed },
      { limits: ctx.account.limits, used: accountUsed },
    );
    const accepted = violations.length === 0;
    const added = accepted ? input.units : 0;

    const applied = {
      account: report(ctx.account.planId, ctx.account.planName, ctx.account.limits, accountUsed + added),
      user: report(ctx.user.planId, ctx.user.planName, ctx.user.limits, ctx.userUsed + added),
    };
    await usage.record(tx, {
      accountId, uid: ctx.uid, requestId: input.requestId, units: input.units, period, accepted,
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

function result(
  r: { requestId: string; userId: string; units: number; period: string; accepted: boolean; violations: Violation[]; applied: { account: SideReport; user: SideReport } },
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
    account: r.applied.account,
    user: r.applied.user,
    replayed,
  };
}
