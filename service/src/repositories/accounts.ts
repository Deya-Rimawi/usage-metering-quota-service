import type { QueryResultRow } from 'pg';
import type { Db } from './db';

export interface AccountRow { id: string; name: string; planId: string; externalId: string | null; createdAt: string }
const COLS = 'id, name, plan_id, external_id, created_at';
// Rows from pg are untyped: this mapper is the one place they are turned into typed objects.
const map = (r: QueryResultRow): AccountRow => ({ id: r.id, name: r.name, planId: r.plan_id, externalId: r.external_id, createdAt: r.created_at.toISOString() });

/**
 * Inserts an account. With an `externalId` this is race-safe get-or-create: if another request already created
 * that external id, nothing is inserted and null is returned (the caller then reads the existing one).
 */
export async function insert(
  db: Db, name: string, keyHash: string, planId: string, externalId: string | null, source: 'admin' | 'self_service',
): Promise<AccountRow | null> {
  const { rows } = await db.query(
    `INSERT INTO accounts (name, api_key_hash, plan_id, external_id, source) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING ${COLS}`,
    [name, keyHash, planId, externalId, source],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** How many accounts came from self-service signup, counted up to `upTo` (bounded work). */
export async function countSelfService(db: Db, upTo: number): Promise<number> {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM (SELECT 1 FROM accounts WHERE source = 'self_service' LIMIT $1) s", [upTo]);
  return rows[0].n;
}

export async function findByExternalId(db: Db, externalId: string): Promise<AccountRow | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM accounts WHERE external_id = $1`, [externalId]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findByKeyHash(db: Db, keyHash: string): Promise<AccountRow | null> {
  const { rows } = await db.query({
    name: 'account_by_key_hash', // runs on every authenticated request
    text: `SELECT ${COLS} FROM accounts WHERE api_key_hash = $1`,
    values: [keyHash],
  });
  return rows[0] ? map(rows[0]) : null;
}

export async function get(db: Db, id: string): Promise<AccountRow> {
  const { rows } = await db.query(`SELECT ${COLS} FROM accounts WHERE id = $1`, [id]);
  return map(rows[0]);
}

export const setPlan = (db: Db, id: string, planId: string) => db.query('UPDATE accounts SET plan_id = $2 WHERE id = $1', [id, planId]);
export const setKeyHash = (db: Db, id: string, keyHash: string) => db.query('UPDATE accounts SET api_key_hash = $2 WHERE id = $1', [id, keyHash]);
