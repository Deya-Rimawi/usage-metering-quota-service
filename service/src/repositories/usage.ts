import type { Violation } from '../domain/rules';
import type { Db } from './db';

/** What a decision stores about each side: plan, limits, and balance after the decision. */
export interface SideSnapshot {
  planId: string; planName: string; monthlyAllowance: number | null; maxPerRequest: number | null; used: number; remaining: number | null;
  // The daily allowance (extra rule). Absent in decisions stored before the rule existed.
  dailyAllowance?: number | null; usedToday?: number | null; remainingToday?: number | null;
}
export interface StoredDecision {
  userId: string; units: number; period: string; accepted: boolean; violations: Violation[];
  applied: { account: SideSnapshot; user: SideSnapshot };
}

/**
 * THE lock of the consume path: a row lock on the account's counter for this month, held until the
 * transaction ends. Every writer of any usage counter (the account's or its users') holds it first, so
 * this one lock serializes all of an account's consumption. Returns units used so far.
 * (The first request of a month finds no row yet: create it, then lock it.)
 */
export async function lockAccount(db: Db, accountId: string, period: string): Promise<number> {
  // Named = prepared once per connection: planning a query costs more than running it, and here it would
  // happen while holding the lock (see docs/PERFORMANCE.md).
  const lock = { name: 'lock_account', text: 'SELECT units FROM account_usage WHERE account_id = $1 AND period = $2 FOR UPDATE', values: [accountId, period] };
  let { rows } = await db.query(lock);
  if (!rows[0]) {
    await db.query('INSERT INTO account_usage (account_id, period) VALUES ($1, $2) ON CONFLICT DO NOTHING', [accountId, period]);
    ({ rows } = await db.query(lock));
  }
  return rows[0].units;
}

/**
 * Everything the decision needs, in ONE statement, run AFTER the lock was granted. That ordering matters:
 * a statement's snapshot is taken when it starts, so reading these in the same statement as the lock wait
 * could miss rows committed by the transaction we were waiting for.
 *   - the user (null = unknown in this account) and its usage this month
 *   - both plans in force now
 *   - an earlier decision for this requestId, if any (a retry)
 */
export async function readContext(db: Db, accountId: string, userId: string, requestId: string, period: string, day: string) {
  const { rows } = await db.query({
    name: 'read_context',
    text: `SELECT u.id AS uid, COALESCE(uu.units, 0) AS user_used, COALESCE(ud.units, 0) AS user_used_today, COALESCE(ad.units, 0) AS account_used_today,
            ap.id AS a_id, ap.name AS a_name, ap.monthly_allowance AS a_month, ap.daily_allowance AS a_day, ap.max_per_request AS a_req,
            up.id AS u_id, up.name AS u_name, up.monthly_allowance AS u_month, up.daily_allowance AS u_day, up.max_per_request AS u_req,
            r.units AS r_units, r.period AS r_period, r.accepted AS r_accepted, r.violations AS r_violations,
            r.applied AS r_applied, ru.external_id AS r_user
     FROM accounts a
     JOIN plans ap ON ap.id = a.plan_id
     LEFT JOIN users u ON u.account_id = a.id AND u.external_id = $2
     LEFT JOIN plans up ON up.id = u.plan_id
     LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period = $4
     LEFT JOIN user_daily_usage ud ON ud.user_id = u.id AND ud.day = $5
     LEFT JOIN account_daily_usage ad ON ad.account_id = a.id AND ad.day = $5
     LEFT JOIN requests r ON r.account_id = a.id AND r.request_id = $3
     LEFT JOIN users ru ON ru.id = r.user_id
     WHERE a.id = $1`,
    values: [accountId, userId, requestId, period, day],
  });
  const r = rows[0];
  return {
    uid: r.uid as string | null,
    userUsed: r.user_used as number,
    userUsedToday: r.user_used_today as number,
    accountUsedToday: r.account_used_today as number,
    account: { planId: r.a_id as string, planName: r.a_name as string, limits: { monthlyAllowance: r.a_month as number | null, dailyAllowance: r.a_day as number | null, maxPerRequest: r.a_req as number | null } },
    user: r.u_id ? { planId: r.u_id as string, planName: r.u_name as string, limits: { monthlyAllowance: r.u_month as number | null, dailyAllowance: r.u_day as number | null, maxPerRequest: r.u_req as number | null } } : null,
    stored: r.r_user
      ? { userId: r.r_user as string, units: r.r_units as number, period: r.r_period as string, accepted: r.r_accepted as boolean, violations: (r.r_violations ?? []) as Violation[], applied: r.r_applied as StoredDecision['applied'] }
      : null,
  };
}

/**
 * Records the decision and, if accepted, adds the units to all four counters (account and user, month and
 * day): one statement, so counters and log can never disagree. Caller holds the account lock. A rejection only inserts the log row.
 */
// created_at uses clock_timestamp(), not now(): now() is the transaction START, i.e. before we waited for the
// lock, which would make history order differ from decision order (and break cursors that rely on it).
export async function record(
  db: Db,
  d: {
    accountId: string; uid: string; requestId: string; units: number; period: string; day: string; accepted: boolean;
    rule?: string; level?: string; violations: unknown[]; applied: unknown;
  },
): Promise<void> {
  await db.query({
    name: 'record_decision',
    text: `WITH a AS (UPDATE account_usage SET units = units + $4 WHERE account_id = $1 AND period = $5 AND $6::boolean),
          u AS (INSERT INTO user_usage (user_id, period, units) SELECT $2, $5, $4 WHERE $6::boolean
                ON CONFLICT (user_id, period) DO UPDATE SET units = user_usage.units + EXCLUDED.units),
          ad AS (INSERT INTO account_daily_usage (account_id, day, units) SELECT $1, $11::date, $4 WHERE $6::boolean
                 ON CONFLICT (account_id, day) DO UPDATE SET units = account_daily_usage.units + EXCLUDED.units),
          ud AS (INSERT INTO user_daily_usage (user_id, day, units) SELECT $2, $11::date, $4 WHERE $6::boolean
                 ON CONFLICT (user_id, day) DO UPDATE SET units = user_daily_usage.units + EXCLUDED.units)
     INSERT INTO requests (account_id, request_id, user_id, units, period, day, accepted, rejected_rule, rejected_level, violations, applied, created_at)
     VALUES ($1, $3, $2, $4, $5, $11, $6, $7, $8, $9, $10, clock_timestamp())`,
    values: [d.accountId, d.uid, d.requestId, d.units, d.period, d.accepted, d.rule ?? null, d.level ?? null, JSON.stringify(d.violations), JSON.stringify(d.applied), d.day],
  });
}

/** Units used this month by an account (0 if it has not consumed anything yet). Read without locking. */
export async function accountUsed(db: Db, accountId: string, period: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM account_usage WHERE account_id = $1 AND period = $2', [accountId, period]);
  return rows[0]?.units ?? 0;
}

export async function userUsed(db: Db, uid: string, period: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM user_usage WHERE user_id = $1 AND period = $2', [uid, period]);
  return rows[0]?.units ?? 0;
}

/** Units used on a UTC day (0 if none). Read without locking. */
export async function accountUsedOn(db: Db, accountId: string, day: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM account_daily_usage WHERE account_id = $1 AND day = $2', [accountId, day]);
  return rows[0]?.units ?? 0;
}

export async function userUsedOn(db: Db, uid: string, day: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM user_daily_usage WHERE user_id = $1 AND day = $2', [uid, day]);
  return rows[0]?.units ?? 0;
}

/** Every user of the account with that month's usage (0 for users who did not consume). Keyset-paginated. */
export async function listUsersWithUsage(
  db: Db, accountId: string, period: string, day: string | null, limit: number, after?: { t: string; id: string },
) {
  // `day` = today's UTC date when listing the current month (to show daily usage); null for past months.
  const { rows } = await db.query(
    `SELECT u.id, u.external_id, u.plan_id, u.created_at::text AS created_at_raw, COALESCE(uu.units, 0) AS used, COALESCE(ud.units, 0) AS used_today
     FROM users u
     LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period = $2
     LEFT JOIN user_daily_usage ud ON ud.user_id = u.id AND ud.day = $6::date
     WHERE u.account_id = $1 AND ($3::timestamptz IS NULL OR (u.created_at, u.id) > ($3::timestamptz, $4::uuid))
     ORDER BY u.created_at, u.id LIMIT $5`,
    [accountId, period, after?.t ?? null, after?.id ?? null, limit, day],
  );
  return rows.map((r) => ({
    uid: r.id as string, userId: r.external_id as string, planId: r.plan_id as string, createdAtRaw: r.created_at_raw as string,
    used: r.used as number, usedToday: r.used_today as number,
  }));
}
