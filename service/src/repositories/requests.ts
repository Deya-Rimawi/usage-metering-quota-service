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

export interface HistoryRow extends StoredRequest { requestId: string; createdAt: string; createdAtRaw: string; id: string }

/**
 * Newest first, keyset-paginated on (created_at, id): stable while new requests keep arriving
 * (OFFSET would skip or repeat rows). Filters are optional; the account scope is always applied.
 */
export async function list(
  db: Db, accountId: string,
  f: { limit: number; after?: { t: string; id: string }; uid?: string; period?: string; accepted?: boolean },
): Promise<HistoryRow[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.request_id, r.user_id, u.external_id, r.units, r.period, r.accepted, r.rejected_rule, r.rejected_level,
            r.violations, r.applied, r.created_at, r.created_at::text AS created_at_raw
     FROM requests r JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1 AND r.accepted IS NOT NULL
       AND ($2::uuid IS NULL OR r.user_id = $2) AND ($3::date IS NULL OR r.period = $3) AND ($4::boolean IS NULL OR r.accepted = $4)
       AND ($5::timestamptz IS NULL OR (r.created_at, r.id) < ($5::timestamptz, $6::uuid))
     ORDER BY r.created_at DESC, r.id DESC LIMIT $7`,
    [accountId, f.uid ?? null, f.period ?? null, f.accepted ?? null, f.after?.t ?? null, f.after?.id ?? null, f.limit],
  );
  return rows.map((r) => ({
    id: r.id, requestId: r.request_id, uid: r.user_id, userId: r.external_id, units: r.units, period: r.period, accepted: r.accepted,
    rejectedRule: r.rejected_rule, rejectedLevel: r.rejected_level, violations: r.violations, applied: r.applied,
    createdAt: r.created_at.toISOString(), createdAtRaw: r.created_at_raw,
  }));
}
