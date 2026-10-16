# ADR-003: Per-month counter rows updated under row locks

**Status:** accepted

## Options considered
| Option | Verdict |
|---|---|
| `SUM()` over the request log on every decision | O(n) per request and still needs a lock to be race-free. Rejected |
| **Counter rows (`account_usage`, `user_usage`) locked in the deciding transaction** | **Chosen** |
| Redis / in-memory counters | Adds a consistency gap with the durable DB. Rejected |
| Sharded counters per account | Removes the hot row but makes "exactly at the limit" hard. Documented upgrade path |
| SERIALIZABLE isolation with retries | Abort storms on a hot row. Rejected |

## Decision
`account_usage(account_id, period)` and `user_usage(user_id, period)` hold the running totals. They are keyed by owner and UTC month, **not by plan**, so switching plans cannot reset consumption. The `requests` table is the audit log and the source of truth used to verify the counters.

## Consequences
- O(1) decisions and exact totals.
- All requests for one account serialize on one row; different accounts never contend. Measured in `docs/PERFORMANCE.md`.
