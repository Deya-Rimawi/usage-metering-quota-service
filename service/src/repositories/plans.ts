import { randomUUID } from 'node:crypto';
import type { Plan, PlanKind } from '../domain/types';
import type { Db } from './db';

const COLS = `id, kind, name, monthly_allowance, daily_allowance, max_per_request, account_id IS NULL AS predefined, created_at, updated_at`;

export const toPlan = (r: any): Plan => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  monthlyAllowance: r.monthly_allowance,
  dailyAllowance: r.daily_allowance,
  maxPerRequest: r.max_per_request,
  predefined: r.predefined,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** A plan is visible to an account if it is predefined or owned by that account. */
export async function getVisible(db: Db, accountId: string | null, planId: string): Promise<Plan | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`, [planId, accountId]);
  return rows[0] ? toPlan(rows[0]) : null;
}

export async function listVisible(db: Db, accountId: string): Promise<Plan[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM plans WHERE account_id IS NULL OR account_id = $1 ORDER BY (account_id IS NOT NULL), kind, name`,
    [accountId],
  );
  return rows.map(toPlan);
}

/** How many custom plans an account owns, counted up to `upTo` (bounded work even for huge accounts). */
export async function countOwned(db: Db, accountId: string, upTo: number): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM plans WHERE account_id = $1 LIMIT $2) s', [accountId, upTo]);
  return rows[0].n;
}

export async function insert(
  db: Db,
  accountId: string,
  p: { kind: PlanKind; name: string; monthlyAllowance: number | null; dailyAllowance: number | null; maxPerRequest: number | null },
): Promise<Plan> {
  const { rows } = await db.query(
    `INSERT INTO plans (id, account_id, kind, name, monthly_allowance, daily_allowance, max_per_request)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    ['pln_' + randomUUID(), accountId, p.kind, p.name, p.monthlyAllowance, p.dailyAllowance, p.maxPerRequest],
  );
  return toPlan(rows[0]);
}

/** Only touches plans owned by `accountId`, so predefined plans and other accounts' plans are never modified. */
export async function updateOwned(
  db: Db,
  accountId: string,
  planId: string,
  patch: { name?: string; monthlyAllowance?: number | null; dailyAllowance?: number | null; maxPerRequest?: number | null },
): Promise<Plan | null> {
  const { rows } = await db.query(
    `UPDATE plans SET
       name = COALESCE($3, name),
       monthly_allowance = CASE WHEN $4::boolean THEN $5::bigint ELSE monthly_allowance END,
       max_per_request   = CASE WHEN $6::boolean THEN $7::bigint ELSE max_per_request END,
       daily_allowance   = CASE WHEN $8::boolean THEN $9::bigint ELSE daily_allowance END,
       updated_at = now()
     WHERE id = $1 AND account_id = $2 RETURNING ${COLS}`,
    [
      planId, accountId, patch.name ?? null,
      patch.monthlyAllowance !== undefined, patch.monthlyAllowance ?? null,
      patch.maxPerRequest !== undefined, patch.maxPerRequest ?? null,
      patch.dailyAllowance !== undefined, patch.dailyAllowance ?? null,
    ],
  );
  return rows[0] ? toPlan(rows[0]) : null;
}
