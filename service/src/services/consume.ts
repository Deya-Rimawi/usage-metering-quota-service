import type pg from 'pg';
import { conflict, notFound } from '../domain/errors';
import { periodLabel, periodOf, type Clock } from '../domain/period';
import { describe, evaluate, remainingUnits, type Level, type Limits, type RuleName, type Violation } from '../domain/rules';
import { withTx } from '../repositories/db';
import * as requests from '../repositories/requests';
import * as usage from '../repositories/usage';
import * as users from '../repositories/users';

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

const report = (planId: string, planName: string, limits: Limits, used: number): SideReport => ({
  planId, planName, ...limits, used, remaining: remainingUnits({ limits, used }),
});

/**
 * Decide and (if accepted) record a consumption, atomically. See docs/CONCURRENCY.md.
 *
 * One transaction, READ COMMITTED:
 *   1. claim (account, requestId)        -> duplicates stop here and replay the stored decision
 *   2. lock user counter, then account   -> fixed order everywhere, so no deadlocks; hot row last
 *   3. read the plans in force NOW       -> an edit committed before this point applies to this request
 *   4. evaluate (pure) -> add to both counters only if accepted
 *   5. store the decision + snapshot     -> commit
 * A rejection writes only the request row: counters are untouched.
 */
export async function consume(
  pool: pg.Pool, clock: Clock,
  accountId: string, input: { userId: string; units: number; requestId: string },
): Promise<ConsumeResult> {
  const user = await users.find(pool, accountId, input.userId);
  if (!user) throw notFound('User'); // also covers users of other accounts
  const period = periodOf(clock());

  return withTx(pool, async (tx) => {
    const claimed = await requests.claim(tx, accountId, input.requestId, user.uid, input.units, period);
    if (!claimed) return replay(tx, accountId, input);

    await usage.ensure(tx, user.uid, accountId, period);
    const userUsed = await usage.lockUser(tx, user.uid, period);
    const accountUsed = await usage.lockAccount(tx, accountId, period);
    const plans = await usage.currentLimits(tx, user.uid, accountId);

    const violations = evaluate(
      input.units,
      { limits: plans.user.limits, used: userUsed },
      { limits: plans.account.limits, used: accountUsed },
    );
    const accepted = violations.length === 0;
    if (accepted) await usage.add(tx, user.uid, accountId, period, input.units);

    const applied = {
      account: report(plans.account.planId, plans.account.planName, plans.account.limits, accountUsed + (accepted ? input.units : 0)),
      user: report(plans.user.planId, plans.user.planName, plans.user.limits, userUsed + (accepted ? input.units : 0)),
    };
    await requests.finalize(tx, claimed, { accepted, rule: violations[0]?.rule, level: violations[0]?.level, violations, applied });

    return result({ ...input, period, accepted, violations, applied }, false);
  });
}

/** A retry gets the original decision back, unchanged, and never counts twice. */
async function replay(tx: pg.PoolClient, accountId: string, input: { userId: string; units: number; requestId: string }) {
  const s = await requests.findStored(tx, accountId, input.requestId);
  if (s.userId !== input.userId || s.units !== input.units) {
    throw conflict('idempotency_conflict', `requestId '${input.requestId}' was already used with a different user or amount`);
  }
  return result(
    { requestId: input.requestId, userId: s.userId, units: s.units, period: s.period, accepted: s.accepted, violations: s.violations ?? [], applied: s.applied },
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
