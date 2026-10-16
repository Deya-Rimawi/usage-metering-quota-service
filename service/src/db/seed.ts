import type pg from 'pg';

/** Predefined, read-only plans (account_id NULL). Ids are stable so clients can reference them. */
export const PREDEFINED_PLANS = [
  { id: 'starter', kind: 'account', name: 'Starter', monthly: 10_000, daily: 2_000, perRequest: 100 },
  { id: 'pro', kind: 'account', name: 'Pro', monthly: 1_000_000, daily: 100_000, perRequest: 1_000 },
  { id: 'basic', kind: 'user', name: 'Basic', monthly: 500, daily: 100, perRequest: 20 },
  { id: 'premium', kind: 'user', name: 'Premium', monthly: 5_000, daily: 1_000, perRequest: 200 },
] as const;

/** Idempotent: re-running restores the documented values. */
export async function seedPlans(pool: pg.Pool): Promise<void> {
  for (const p of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (id, account_id, kind, name, monthly_allowance, daily_allowance, max_per_request)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, monthly_allowance = EXCLUDED.monthly_allowance,
             daily_allowance = EXCLUDED.daily_allowance, max_per_request = EXCLUDED.max_per_request`,
      [p.id, p.kind, p.name, p.monthly, p.daily, p.perRequest],
    );
  }
}
