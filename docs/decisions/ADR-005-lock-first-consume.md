# ADR-005: One lock, taken first; read everything after it

**Status:** accepted (supersedes the locking part of ADR-004; measured in [PERFORMANCE.md](../PERFORMANCE.md))

## Context
The first implementation (ADR-004) used about 10 round trips per consume: look up the user, claim the request id, create counter rows, lock the user counter, lock the account counter, read the plans, update counters, update the log, commit. The load test showed that all consumption for one account queues on the account counter row, and that each queued request held the lock for the whole multi-round-trip tail of the transaction.

## Observations that allow a simpler design
1. **The user lock is redundant.** Every consume locks the account counter, and every writer of a user counter is a consume. So holding the account lock already serializes all writers of that account's user counters. A second lock adds a statement and an ordering rule but protects nothing extra.
2. **The idempotency claim is redundant under that lock.** Two requests with the same `requestId` belong to the same account, so they serialize on the same lock. After taking it, a plain `SELECT` for the request id is enough to find an earlier decision. The unique index `(account_id, request_id)` stays as a safety net.
3. **A statement reads a snapshot taken when it starts.** If a statement waits for a row lock and also reads other tables, those reads can miss rows committed by the transaction it waited for (only the locked row itself is re-read). So the lock must be its own statement, and everything the decision depends on must be read in a *later* statement.

## Decision
```
BEGIN
 1. SELECT ... FROM account_usage ... FOR UPDATE        (create the month's row first if missing)
 2. one SELECT: user + its usage, both plans, any earlier decision for this requestId
 3. evaluate() in TypeScript (unchanged, pure)
 4. one statement: INSERT the decision into requests; if accepted also UPDATE account_usage and upsert user_usage
COMMIT
```
Five round trips instead of about ten, one lock, no pending row (the `accepted` column becomes `NOT NULL`, migration 002), no lock-ordering rule to get wrong.

## Alternatives rejected
| Alternative | Why not |
|---|---|
| A PL/pgSQL function doing everything in one round trip | Duplicates the rule evaluation in SQL: two implementations to keep in sync, and the decision logic is no longer a pure, unit-tested TypeScript function. The remaining gain (about 2-3 round trips) is small next to that cost. |
| Keep both locks (user, then account) | Slower for no safety gain, per observation 1. |
| Sharded account counters | Removes the serialization but makes "exactly at the limit" hard to decide; the measured ceiling is acceptable for the stated scope. Documented as the upgrade path. |

## Consequences
- Lower lock hold time and fewer round trips: higher per-account throughput (numbers in PERFORMANCE.md).
- A duplicate request now takes the account lock briefly instead of stopping at the unique index first. Retries are rare and cheap, so this is acceptable.
- Reasoning about correctness got shorter: one lock, every writer holds it, every read that matters happens after it.
- Invariant to preserve in future code: **any code that writes a usage counter must hold the account's counter lock first.** `lockAccount()` is the single entry point.
