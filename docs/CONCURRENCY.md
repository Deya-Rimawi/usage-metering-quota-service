# Concurrency and correctness of `POST /consume`

Code: [`service/src/services/consume.ts`](../service/src/services/consume.ts) (orchestration),
[`domain/rules.ts`](../service/src/domain/rules.ts) (decision), `repositories/usage.ts` + `requests.ts` (SQL).

## The problem
Many requests for the same user/account arrive at once. Each must check "is there enough left?" and then add to the total. If two requests both read `used = 95`, both see room for 5, and both add 5, the allowance is overspent. This is the classic *lost update / check-then-act race*.

## The solution in one sentence
Inside one database transaction, take a **row lock** on the user's counter and the account's counter, read them, decide, write, commit. A second request wanting the same row **waits** until the first commits, then reads the fresh value.

## Step by step (READ COMMITTED)
```
0. find the user by (account, userId)          not found -> 404, nothing written
BEGIN
1. INSERT request (account, requestId) ON CONFLICT DO NOTHING
     inserted?  -> we own this requestId, continue
     conflict?  -> a duplicate: wait for the first transaction, then replay its stored decision
2. ensure counter rows exist for this UTC month (INSERT ... ON CONFLICT DO NOTHING)
3. SELECT ... FOR UPDATE  user_usage            <- lock #1
4. SELECT ... FOR UPDATE  account_usage         <- lock #2 (the shared, contended one: taken LAST)
5. read the plans in force now (accounts -> plan, users -> plan)
6. evaluate(units, user, account)               pure function, no I/O
7. accepted? UPDATE both counters += units      rejected? counters untouched
8. UPDATE the request row: decision + snapshot of limits and balances
COMMIT                                          locks released
```

## Why each choice
| Choice | Reason |
|---|---|
| Row locks (`FOR UPDATE`) instead of SERIALIZABLE | Serializable aborts conflicting transactions and needs retry loops; with a hot row that means abort storms. Locks just queue, which is exactly what we want. |
| Always lock **user, then account** | If one request locked A then B while another locked B then A, they would deadlock. A single global order makes cycles impossible. Different users share only the account lock, which is always second. |
| Account lock taken last | Everyone for an account queues on it; locking it last keeps the time it is held as short as possible (only steps 4-8). |
| Plans read **after** the locks (step 5) | A plan edit committed while we waited applies to this request. A request never decides on limits that were already replaced before it got its turn. |
| Counters keyed by `(owner, month)`, not plan | Switching plans cannot reset usage. |
| Idempotency claim first (step 1) | The unique index `(account_id, request_id)` makes duplicates serialize on the index, before any counter lock is taken. Two simultaneous copies of a request cannot both pass. |
| Decision stored with a snapshot | A retry returns the identical answer, and history keeps the limits that applied at the time even after plans change. |

## Invariants
| | Invariant | How it is protected / verified |
|---|---|---|
| I1 | Each counter equals the sum of accepted units in the request log for that owner and month | Counters and the log row are written in the same transaction; `brokenInvariants()` in tests checks it from the DB after concurrent runs |
| I2 | Accepted usage never exceeds the allowance in force at decision time | Row locks + decision on the locked value |
| I3 | A rejection changes no counter | `add` is only called when `violations` is empty |
| I4 | One `(account, requestId)` has exactly one decision, forever | Unique index + stored decision |
| I5 | Account usage = sum of its users' usage for the month | Both counters are updated in one statement while both locks are held |

Proof the tests are real: removing `FOR UPDATE` from `usage.ts` makes the two parallel-allowance tests fail (the allowance is overspent).

## Failure modes
- **Crash or error mid-transaction:** Postgres rolls everything back, including the claimed request row. The client retries with the same `requestId` and gets a fresh decision. No half-counted state exists.
- **Client times out but the server committed:** the retry replays the stored decision (`replayed: true`) and does not count again.
- **Duplicate arrives while the first is in flight:** it blocks on the unique index, then replays after the first commits. If the first rolled back, the duplicate proceeds as the real one.
- **Plan edited during a request:** the request sees the old or the new limits, never a mix, because the plan is read once at step 5. The new limits apply to every request that reaches step 5 after the edit commits.
- **Reduced allowance below usage:** `remaining = max(0, allowance - used)`, so it shows 0 and `used + units > allowance` rejects until the allowance rises or the month rolls over.

## Known limit
All consumes for **one account** serialize on its counter row, so one account's throughput is bounded by how fast the transaction commits. Different accounts do not interact. Measured in [PERFORMANCE.md](PERFORMANCE.md) (Day 6). Upgrade path: sharded counters or a single-statement version (see ADR-004).
