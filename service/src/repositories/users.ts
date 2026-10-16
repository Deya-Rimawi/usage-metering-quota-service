import type { QueryResultRow } from 'pg';
import type { Db } from './db';

/** The API identifies a user by the caller's own id (`external_id`); the internal uuid never leaves the service. */
export interface UserRow { uid: string; userId: string; planId: string; createdAt: string; createdAtRaw: string }
const COLS = `id, external_id, plan_id, created_at, created_at::text AS created_at_raw`;
// Rows from pg are untyped: this mapper is the one place they are turned into typed objects.
const map = (r: QueryResultRow): UserRow => ({
  uid: r.id, userId: r.external_id, planId: r.plan_id, createdAt: r.created_at.toISOString(), createdAtRaw: r.created_at_raw,
});

export async function insert(db: Db, accountId: string, userId: string, planId: string): Promise<UserRow> {
  const { rows } = await db.query(
    `INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [accountId, userId, planId],
  );
  return map(rows[0]);
}

/** How many users an account has, counted up to `upTo` (bounded work even for huge accounts). */
export async function countForAccount(db: Db, accountId: string, upTo: number): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM users WHERE account_id = $1 LIMIT $2) s', [accountId, upTo]);
  return rows[0].n;
}

/** Scoped by account: another account's user simply does not exist from here. */
export async function find(db: Db, accountId: string, userId: string): Promise<UserRow | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM users WHERE account_id = $1 AND external_id = $2`, [accountId, userId]);
  return rows[0] ? map(rows[0]) : null;
}

/** Keyset pagination, oldest first. `after` is the (created_at, id) of the last row of the previous page. */
export async function list(
  db: Db, accountId: string, limit: number, after?: { t: string; id: string },
): Promise<UserRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM users
     WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
     ORDER BY created_at, id LIMIT $4`,
    [accountId, after?.t ?? null, after?.id ?? null, limit],
  );
  return rows.map(map);
}

export const setPlan = (db: Db, accountId: string, userId: string, planId: string) =>
  db.query('UPDATE users SET plan_id = $3 WHERE account_id = $1 AND external_id = $2', [accountId, userId, planId]);
