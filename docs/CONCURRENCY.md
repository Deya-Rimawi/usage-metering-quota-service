# Concurrency and correctness of `POST /consume`

Code: [`service/src/services/consume.ts`](../service/src/services/consume.ts) (orchestration),
[`domain/rules.ts`](../service/src/domain/rules.ts) (decision), `repositories/usage.ts` (all the SQL on this path),
[`services/accountGate.ts`](../service/src/services/accountGate.ts) (performance guard).
Background: [LEARNING.md](LEARNING.md) sections 1-6. Why this shape: [ADR-005](decisions/ADR-005-lock-first-consume.md), [ADR-006](decisions/ADR-006-per-account-gate.md).

## The problem
Many requests for the same account arrive at once. Each must check "is there enough left?" and then add to the totals. If two requests both read `used = 95`, both see room for 5, and both add 5, the allowance is overspent: a *check-then-act race*.

## The solution in one sentence
Inside one database transaction, first take a **row lock** on the account's counter for the month, then read everything the decision needs, decide, write, commit. A concurrent request for the same account **waits** for the lock, then reads the fresh state.

## Step by step (READ COMMITTED)
```
(in process)  gate: wait until fewer than ACCOUNT_CONCURRENCY (=1) consumes of this account are running here
BEGIN
 1. SELECT units FROM account_usage WHERE (account, month) FOR UPDATE      <- THE lock
        (first request of a month: no row yet -> INSERT ... ON CONFLICT DO NOTHING, then lock it)
        then re-read the clock: if the UTC month turned while we queued, lock and charge the NEW month
 2. ONE read statement: the user + its usage this month, the account plan,
        the user plan, and any earlier decision for this requestId
 3. in TypeScript: replay? unknown user? otherwise evaluate(units, user, account) -> violations
 4. ONE write statement:  INSERT the decision into requests (with a snapshot of limits/balances)
        and, only if accepted, UPDATE account_usage and upsert user_usage
        (created_at = clock_timestamp(): stamped now, after the lock, so history order = decision order)
COMMIT                                                                      <- lock released
```
Five round trips including BEGIN and COMMIT.

## Why each choice
| Choice | Reason |
|---|---|
| **One lock** on the account counter | Every writer of any counter (the account's or a user's) is a consume, and every consume takes this lock first. So it already serializes all of an account's users; a second, user-level lock adds nothing and creates lock-ordering/deadlock questions. |
| **Lock in its own statement, reads in the next** | A statement sees the snapshot from when *it started*. If the reads shared the statement that waits for the lock, they could miss rows the previous lock holder just committed (only the locked row itself is re-read). A fresh statement after the lock sees them all. |
| **Idempotency lookup under the lock** | Two requests with the same `requestId` belong to the same account, so they serialize on the same lock. The second finds the first's committed decision in step 2 and replays it. The `UNIQUE (account_id, request_id)` index is a backstop. |
| **Locks, not SERIALIZABLE** | Serializable aborts conflicting transactions and needs retry loops (abort storms on a hot row). Locks just queue. |
| **Counters keyed by (owner, month), not plan** | Switching plans cannot reset usage. |
| **`created_at` from `clock_timestamp()`** | `now()` is the transaction *start*, before the lock wait; a later decision could look older and be skipped by a pagination cursor. |
| **Month read after the lock** | "Processed" means decided, not arrived: a request that queues across midnight UTC on the 1st belongs to the new month. |
| **Decision + snapshot stored** | A retry returns the identical answer; history keeps the limits that applied at the time, even after plans change. |
| **Rule evaluation is a pure function** | Testable with a truth table; the one file to read to understand a decision. |
| **Prepared (named) statements** | Planning one of these queries cost more than running it (4.3 ms vs 0.26 ms), and it would happen while holding the lock. |
| **Per-account gate** | Keeps a hot account's waiting in memory instead of in the connection pool, so it cannot starve other tenants. It is a performance guard only. |

## Invariants
| | Invariant | How it is protected / verified |
|---|---|---|
| I1 | Each counter equals the sum of accepted units in the request log for that owner and month | Counters and the log row are written by one statement under the lock; `brokenInvariants()` in tests and `loadtest/verify.ts` recompute it from the database |
| I2 | Accepted usage never exceeds the allowance in force at decision time | The decision is made on values read after taking the lock |
| I3 | A rejection changes no counter | The counter updates are guarded by `$6::boolean` (accepted) in the same statement |
| I4 | One `(account, requestId)` has exactly one decision, forever | Lookup under the lock + unique index + stored decision |
| I5 | Account usage = sum of its users' usage for the month | Both are updated in one statement while the lock is held |
| I6 | **Any code that writes a usage counter must hold the account's counter lock first** | `lockAccount()` is the single entry point; this is the rule future changes must keep |

## What the tests prove
- `test/consume.test.ts` "concurrency": 200 parallel requests against a 100-unit allowance give exactly 100 accepted; 300 requests from 10 users racing for a shared 120 give exactly 60 accepted; 20 simultaneous duplicates give one decision; plan edits during a burst keep the counters consistent.
- They alternate requests between **two app instances** (two gates, one database), so the in-process gate cannot be what makes them pass.
- **They fail if `FOR UPDATE` is removed** (checked by hand: both allowance tests overspend). That is the proof they test the lock and not luck.
- `loadtest/` re-verifies I1 and I5 from the database after every run (about 1.2 million requests, zero violations).

## Failure modes
- **Crash or error mid-transaction:** Postgres rolls everything back, including the log row. The client retries with the same `requestId` and gets a fresh decision. No half-counted state exists.
- **Client times out but the server committed:** the retry replays the stored decision (`replayed: true`) and does not count again.
- **Duplicate arrives while the first is in flight:** it waits on the account lock, then replays. If the first rolled back, the duplicate proceeds as the real request.
- **Plan edited during a request:** the request sees the old or the new limits, never a mix, because plans are read once in step 2. Any request whose step 2 starts after the edit commits sees the new limits.
- **Allowance reduced below usage:** `remaining = max(0, allowance - used)`, and `used + units > allowance` rejects until the allowance rises or the month rolls over.
- **Many service instances:** correct, because correctness is in the database lock. Each instance has its own gate (a performance guard).
- **Hot account:** requests queue (in the gate, then on the lock); none is lost. Order is first-come within one process's gate; across instances Postgres does not promise FIFO among lock waiters, which affects fairness only, never correctness.

## Known limit
All consumes for **one account** serialize, so one account is bounded by how long a transaction holds the lock (about 4 ms, of which roughly 60% is the commit's disk flush). Different accounts do not interact. Numbers and the upgrade path (batching decisions to share one flush, or sharded counters) are in [PERFORMANCE.md](PERFORMANCE.md) and [LIMITATIONS.md](LIMITATIONS.md).
