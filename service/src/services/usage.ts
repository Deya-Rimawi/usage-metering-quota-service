import type pg from 'pg';
import { invalid, notFound } from '../domain/errors';
import { parsePeriod, periodLabel, periodOf, type Clock } from '../domain/period';
import { describe, type Limits, type Violation } from '../domain/rules';
import * as accounts from '../repositories/accounts';
import { withSnapshot, type Db } from '../repositories/db';
import * as plans from '../repositories/plans';
import * as requests from '../repositories/requests';
import * as usage from '../repositories/usage';
import * as users from '../repositories/users';
import { report, type SideReport } from './consume';

/** '2026-10' -> '2026-10-01'; defaults to the current month; the future has no usage and is refused. */
function resolvePeriod(clock: Clock, raw?: string): { period: string; current: boolean } {
  const now = periodOf(clock());
  if (raw === undefined) return { period: now, current: true };
  const period = parsePeriod(raw);
  if (!period) throw invalid('bad_period', "period must look like '2026-10'");
  if (period > now) throw invalid('future_period', 'period is in the future');
  return { period, current: period === now };
}

/**
 * Limits shown next to usage are the plans in force NOW. Only the current month has a meaningful
 * "remaining" (what can still be consumed); for past months it is null and `used` is the record.
 */
function side(planId: string, planName: string, plan: Limits, used: number, current: boolean): SideReport {
  const r = report(planId, planName, plan, used);
  return current ? r : { ...r, remaining: null };
}

async function accountSide(db: Db, accountId: string, period: string, current: boolean) {
  const acc = await accounts.get(db, accountId);
  const plan = (await plans.getVisible(db, accountId, acc.planId))!;
  return side(plan.id, plan.name, plan, await usage.accountUsed(db, accountId, period), current);
}

export async function accountUsage(
  pool: pg.Pool, clock: Clock, accountId: string, rawPeriod: string | undefined, limit: number, after?: { t: string; id: string },
) {
  const { period, current } = resolvePeriod(clock, rawPeriod);
  return withSnapshot(pool, async (db) => {
    const rows = await usage.listUsersWithUsage(db, accountId, period, limit + 1, after);
    const page = rows.slice(0, limit);
    const byId = new Map((await plans.listVisible(db, accountId)).map((p) => [p.id, p]));
    return {
      period: periodLabel(period),
      current,
      account: await accountSide(db, accountId, period, current),
      users: page.map((r) => ({ userId: r.userId, ...side(r.planId, byId.get(r.planId)!.name, byId.get(r.planId)!, r.used, current) })),
      next: rows.length > limit ? { t: page[page.length - 1]!.createdAtRaw, id: page[page.length - 1]!.uid } : null,
    };
  });
}

/** One user plus the account they draw from: everything needed to answer "what can this user do right now?". */
export async function userUsage(pool: pg.Pool, clock: Clock, accountId: string, userId: string, rawPeriod?: string) {
  const { period, current } = resolvePeriod(clock, rawPeriod);
  return withSnapshot(pool, async (db) => {
    const u = await users.find(db, accountId, userId);
    if (!u) throw notFound('User');
    const plan = (await plans.getVisible(db, accountId, u.planId))!;
    return {
      userId,
      period: periodLabel(period),
      current,
      account: await accountSide(db, accountId, period, current),
      user: side(plan.id, plan.name, plan, await usage.userUsed(db, u.uid, period), current),
    };
  });
}

export async function history(
  pool: pg.Pool, accountId: string,
  q: { limit: number; after?: { t: string; id: string }; userId?: string; period?: string; accepted?: boolean },
) {
  let uid: string | undefined;
  if (q.userId) {
    const u = await users.find(pool, accountId, q.userId);
    if (!u) throw notFound('User');
    uid = u.uid;
  }
  let period: string | undefined;
  if (q.period !== undefined) {
    period = parsePeriod(q.period) ?? undefined;
    if (!period) throw invalid('bad_period', "period must look like '2026-10'");
  }
  const rows = await requests.list(pool, accountId, { limit: q.limit + 1, after: q.after, uid, period, accepted: q.accepted });
  const page = rows.slice(0, q.limit);
  return {
    requests: page.map((r) => {
      const violations: Violation[] = r.violations ?? [];
      return {
        requestId: r.requestId, userId: r.userId, units: r.units, period: periodLabel(r.period), accepted: r.accepted,
        rule: (r.rejectedRule ?? null) as Violation['rule'] | null, level: (r.rejectedLevel ?? null) as Violation['level'] | null,
        message: violations[0] ? describe(violations[0]) : 'Accepted',
        violations, account: r.applied.account as SideReport, user: r.applied.user as SideReport, createdAt: r.createdAt,
      };
    }),
    next: rows.length > q.limit ? { t: page[page.length - 1]!.createdAtRaw, id: page[page.length - 1]!.id } : null,
  };
}
