import type { Db } from './db';

/** Makes sure both counter rows exist for the month (no-op if they do). One round trip. */
export async function ensure(db: Db, uid: string, accountId: string, period: string): Promise<void> {
  await db.query(
    `WITH u AS (INSERT INTO user_usage (user_id, period) VALUES ($1, $3) ON CONFLICT DO NOTHING),
          a AS (INSERT INTO account_usage (account_id, period) VALUES ($2, $3) ON CONFLICT DO NOTHING)
     SELECT 1`,
    [uid, accountId, period],
  );
}

/** Row lock on the user's counter; held until the transaction ends. Returns units used so far. */
export async function lockUser(db: Db, uid: string, period: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM user_usage WHERE user_id = $1 AND period = $2 FOR UPDATE', [uid, period]);
  return rows[0].units;
}

export async function lockAccount(db: Db, accountId: string, period: string): Promise<number> {
  const { rows } = await db.query('SELECT units FROM account_usage WHERE account_id = $1 AND period = $2 FOR UPDATE', [accountId, period]);
  return rows[0].units;
}

/** Adds units to both counters. Callers must hold both row locks. */
export async function add(db: Db, uid: string, accountId: string, period: string, units: number): Promise<void> {
  await db.query(
    `WITH u AS (UPDATE user_usage SET units = units + $4 WHERE user_id = $1 AND period = $3),
          a AS (UPDATE account_usage SET units = units + $4 WHERE account_id = $2 AND period = $3)
     SELECT 1`,
    [uid, accountId, period, units],
  );
}

/** The plans in force right now for this user and its account. Read inside the consume transaction. */
export async function currentLimits(db: Db, uid: string, accountId: string) {
  const { rows } = await db.query(
    `SELECT ap.id AS a_id, ap.name AS a_name, ap.monthly_allowance AS a_month, ap.max_per_request AS a_req,
            up.id AS u_id, up.name AS u_name, up.monthly_allowance AS u_month, up.max_per_request AS u_req
     FROM accounts a
     JOIN plans ap ON ap.id = a.plan_id
     JOIN users u  ON u.id = $1
     JOIN plans up ON up.id = u.plan_id
     WHERE a.id = $2`,
    [uid, accountId],
  );
  const r = rows[0];
  return {
    account: { planId: r.a_id as string, planName: r.a_name as string, limits: { monthlyAllowance: r.a_month as number | null, maxPerRequest: r.a_req as number | null } },
    user: { planId: r.u_id as string, planName: r.u_name as string, limits: { monthlyAllowance: r.u_month as number | null, maxPerRequest: r.u_req as number | null } },
  };
}
