import type { Violation } from '../domain/rules';
import type { Db } from './db';
import type { StoredDecision } from './usage';

/** One decision as stored in the request log, ready for the history endpoint. */
export interface HistoryRow {
  id: string;
  requestId: string;
  uid: string;
  userId: string;
  units: number;
  period: string;
  accepted: boolean;
  rejectedRule: string | null;
  rejectedLevel: string | null;
  violations: Violation[] | null;
  applied: StoredDecision['applied'];
  createdAt: string;
  createdAtRaw: string; // created_at::text, full microsecond precision, used as the pagination cursor
}

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
     WHERE r.account_id = $1
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
