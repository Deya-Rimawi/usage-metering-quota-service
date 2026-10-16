import type { Db } from './db';

/**
 * Claims (accountId, requestId). The unique index makes this the idempotency gate:
 * a concurrent duplicate blocks here until the first transaction commits, then gets `false`.
 */
export async function claim(db: Db, accountId: string, requestId: string, uid: string, units: number, period: string): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO requests (account_id, request_id, user_id, units, period) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, request_id) DO NOTHING RETURNING id`,
    [accountId, requestId, uid, units, period],
  );
  return rows[0]?.id ?? null;
}

export interface StoredRequest {
  uid: string;
  userId: string;
  units: number;
  period: string;
  accepted: boolean;
  rejectedRule: string | null;
  rejectedLevel: string | null;
  violations: any[] | null;
  applied: any;
}

export async function findStored(db: Db, accountId: string, requestId: string): Promise<StoredRequest> {
  const { rows } = await db.query(
    `SELECT r.user_id, u.external_id, r.units, r.period, r.accepted, r.rejected_rule, r.rejected_level, r.violations, r.applied
     FROM requests r JOIN users u ON u.id = r.user_id WHERE r.account_id = $1 AND r.request_id = $2`,
    [accountId, requestId],
  );
  const r = rows[0];
  return {
    uid: r.user_id, userId: r.external_id, units: r.units, period: r.period, accepted: r.accepted,
    rejectedRule: r.rejected_rule, rejectedLevel: r.rejected_level, violations: r.violations, applied: r.applied,
  };
}

export async function finalize(
  db: Db, id: string,
  d: { accepted: boolean; rule?: string; level?: string; violations: unknown[]; applied: unknown },
): Promise<void> {
  await db.query(
    `UPDATE requests SET accepted = $2, rejected_rule = $3, rejected_level = $4, violations = $5, applied = $6 WHERE id = $1`,
    [id, d.accepted, d.rule ?? null, d.level ?? null, JSON.stringify(d.violations), JSON.stringify(d.applied)],
  );
}
