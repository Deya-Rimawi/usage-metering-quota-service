import type { Db } from './db';

export interface AccountRow { id: string; name: string; planId: string; createdAt: string }
const map = (r: any): AccountRow => ({ id: r.id, name: r.name, planId: r.plan_id, createdAt: r.created_at.toISOString() });

export async function insert(db: Db, name: string, keyHash: string, planId: string): Promise<AccountRow> {
  const { rows } = await db.query(
    'INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ($1, $2, $3) RETURNING id, name, plan_id, created_at',
    [name, keyHash, planId],
  );
  return map(rows[0]);
}

export async function findByKeyHash(db: Db, keyHash: string): Promise<AccountRow | null> {
  const { rows } = await db.query('SELECT id, name, plan_id, created_at FROM accounts WHERE api_key_hash = $1', [keyHash]);
  return rows[0] ? map(rows[0]) : null;
}

export async function get(db: Db, id: string): Promise<AccountRow> {
  const { rows } = await db.query('SELECT id, name, plan_id, created_at FROM accounts WHERE id = $1', [id]);
  return map(rows[0]);
}

export const setPlan = (db: Db, id: string, planId: string) => db.query('UPDATE accounts SET plan_id = $2 WHERE id = $1', [id, planId]);
export const setKeyHash = (db: Db, id: string, keyHash: string) => db.query('UPDATE accounts SET api_key_hash = $2 WHERE id = $1', [id, keyHash]);
