# ADR-004: Row locks in a fixed order, and an idempotency claim first

**Status:** superseded by [ADR-005](ADR-005-lock-first-consume.md) (kept as the record of the first design and the baseline that was measured)

## Decision
`consume` runs in one READ COMMITTED transaction: claim `(account_id, request_id)` with `INSERT ... ON CONFLICT DO NOTHING`, then `SELECT ... FOR UPDATE` the user counter and then the account counter, read the plans, decide, update, commit.

## Alternatives
| Alternative | Why not |
|---|---|
| Conditional `UPDATE ... WHERE units + n <= limit` with no explicit lock | Limits live in a different table (plans), and the response must say *which* rule failed, so we need the values. Possible as a later single-statement optimization. |
| SERIALIZABLE + retry | Abort storms on a hot row, and a retry loop to maintain. |
| Advisory locks per account | Same queueing as row locks but invisible to the schema; no benefit. |
| Check, then increment in separate transactions | Lost updates: the exact bug being prevented. |

## Consequences
- Correct under concurrency, proven by tests that fail when the lock is removed.
- Per-account throughput ceiling (the account row is serialized by design).
- The statement count (about 10 round trips) is the baseline for the Day 6 optimization.
