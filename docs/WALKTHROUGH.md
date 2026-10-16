# Interview walkthrough

How to explain this project, trace a request, and handle questions and live changes. Read [LEARNING.md](LEARNING.md) first for the concepts.

## The 60-second pitch
"It is a backend that other applications call before doing something metered. An account has a plan, each user has a plan, and both must allow a request. It records every decision, never over-allocates under concurrency, and makes retries safe. It is one TypeScript service on PostgreSQL. The core idea is one row lock per account for the month, taken first, so all decisions for an account are serialized by the database, and a pure function does the deciding."

## Trace one request: `POST /consume {userId:"alice", units:25, requestId:"doc-1"}`
| # | Where | What happens |
|---|---|---|
| 1 | `http/app.ts` | Fastify matches `/consume`. The `onRequest` hook for the authenticated scope runs first. |
| 2 | `http/auth.ts` `apiKeyAuth` | Reads `X-API-Key`, calls `authenticate` -> `sha256` -> `accounts.findByKeyHash` (a prepared statement). No match: 401. Match: `req.account` is set. **The account id comes from the key, never from the body.** |
| 3 | `http/routes/consume.ts` | zod validates the body: `units` is an integer 1..1e9, `userId` matches the allowed pattern, `requestId` is 1..200 chars. Invalid: 422. |
| 4 | `services/consume.ts` `consume` | Computes the UTC month from the injectable clock, then enters the per-account gate (`services/accountGate.ts`): at most one consume per account at a time *in this process*. |
| 5 | `repositories/db.ts` `withTx` | Takes a pooled connection, `BEGIN`. |
| 6 | `repositories/usage.ts` `lockAccount` | `SELECT units FROM account_usage ... FOR UPDATE`. Any other transaction doing the same for this account waits here. If the row does not exist yet (first request of the month) it is created, then locked. |
| 7 | `repositories/usage.ts` `readContext` | **A new statement** (fresh snapshot, so it sees everything the previous lock holder committed). One query returns: the user (null if not in this account), the user's usage this month, the account plan and user plan, and any earlier decision for this `requestId`. |
| 8 | `services/consume.ts` | If an earlier decision exists: `replay` returns it (`replayed: true`), or 409 if the user/amount differ. If the user is unknown: 404. |
| 9 | `domain/rules.ts` `evaluate` | **Pure.** Checks user per-request, account per-request, user daily, account daily, user monthly, account monthly; returns the list of broken rules. Empty = accepted. |
| 10 | `repositories/usage.ts` `record` | One statement: insert the decision into `requests` (with a snapshot of limits and balances) and, only if accepted, add the units to the four counters (`account_usage`, `user_usage`, `account_daily_usage`, `user_daily_usage`). |
| 11 | `withTx` | `COMMIT` releases the lock; the next waiting request proceeds. |
| 12 | `http/routes/consume.ts` | The response is serialized through the zod response schema: `200 {accepted:false, rule:"max_per_request", level:"user", ...}`. |

Rejected request: steps 1-9 identical; in step 10 only the log row is inserted, so counters do not change.

## Questions you should be ready for
**Correctness and concurrency**
1. *How do you prevent two requests overspending the allowance?* A `FOR UPDATE` row lock on the account's monthly counter, held for the whole decision. The second request waits, then reads the fresh value. Tests prove it, and they fail if the lock is removed.
2. *Why only one lock, not user and account?* Every writer of any counter holds the account lock first, so it already serializes the account's users. A second lock added nothing and brought ordering/deadlock concerns. (ADR-005)
3. *Why read the plans and usage in a separate statement from the lock?* A statement's snapshot is taken when it starts. If the read were in the same statement as the lock wait, it could miss rows committed by the transaction we waited for. (LEARNING section 4)
4. *Can there be a deadlock?* Not between consumes: they take one lock. Plan edits do not take counter locks.
5. *What if the server crashes mid-request?* The transaction rolls back; no partial state. The client retries with the same `requestId` and gets a fresh decision.
6. *What if the client times out but the server committed?* The retry finds the stored decision and replays it; nothing is counted twice.
7. *Two retries at the exact same time?* Both go through the same account lock; the first records, the second sees it and replays. Tested with 20 simultaneous duplicates across two instances.
8. *Does it work with several service instances?* Yes. Correctness comes from the database lock. The in-process gate is only a performance guard. Tests alternate between two app instances.
9. *When does a plan change take effect?* For any request whose read statement starts after the change commits. Units already consumed are kept (usage is keyed by owner and month, not plan).
10. *Allowance reduced below usage?* `remaining = max(0, allowance - used)`, and `used + units > allowance` rejects until the allowance rises or the month rolls over.
11. *Which month does a request belong to?* The UTC month at processing time, taken from the clock when the request is handled.

**Design**
12. *Why counters instead of summing the log?* O(1) decisions. The log remains the audit trail and the check (the tests and load tests recompute totals from it).
13. *Why is a rejection HTTP 200?* It is a normal business outcome. Callers branch on `accepted`; monitoring does not mistake quota rejections for failures.
14. *Why raw SQL, no ORM?* The locking and exact statements are the point; an ORM hides them. (ADR-002)
15. *How are API keys stored?* sha256 hash only; shown once; rotation invalidates the old key at once. A fast hash is fine because the key is 256 random bits and needs an indexed lookup per request.
16. *How do you guarantee tenant isolation?* The account id comes from the key; every repository function takes it and filters on it; another account's resource answers 404. Tested on every endpoint.
17. *What does the database enforce itself?* Plan kind per assignment (composite FKs), unique request ids, non-negative counters, valid limits, decision/reason consistency. (DATA_MODEL.md)

**Performance**
18. *What is the bottleneck?* Per account, throughput is bounded by how long the lock is held (about 3-4 ms, so roughly 250-300 req/s for one account). Different accounts run in parallel (about 1,600+ req/s total on this machine). (PERFORMANCE.md)
19. *What did you optimize, and how did you know?* I measured first. Round trips per request went from about 10 to 5; that helped uncontended traffic a lot but made the hot account *slower* because query planning (4 ms) happened inside the lock; prepared statements fixed that. Then I found a hot tenant starved the connection pool for everyone else; a per-account in-process gate fixed it. A sweep showed that allowing more concurrency per account did not help, so the default is 1.
20. *What would you do to scale one account beyond that ceiling?* Shard the counter into N sub-rows, or batch decisions per account. Both complicate "exactly at the limit". It is documented as the upgrade path, not built, because the requirement is correctness first.
21. *Why not a stored procedure for a single round trip?* It would duplicate the rule logic in SQL, splitting the one place the rules live. The extra gain is small. (ADR-005)

**Honesty questions**
22. *What are the weak points?* See [LIMITATIONS.md](LIMITATIONS.md): per-account ceiling, single Postgres, in-memory gate memory proportional to queued requests, no key scopes, unbounded history growth, not tested beyond one machine.

## Live-change drills (practice these)
| Change | Where | How |
|---|---|---|
| Add **another rule** (a fourth) | `domain/rules.ts` | You have seen the recipe: the daily allowance is one ([ADR-007](decisions/ADR-007-daily-allowance.md)). Add a rule name, one entry in `ORDER`, a plan column (new migration) and, if it needs a running total, a counter table written in the `record` statement; expose it in the plan schemas and add a `describe` message. The lock and transaction do not change. |
| Change **rule precedence** | `domain/rules.ts` | Reorder the `checks` array; update the truth-table test. |
| Make a rejection a **4xx** | `http/routes/consume.ts` | Reply with a status when `!result.accepted`; update `docs/API.md` and tests. |
| Add **`GET /plans` filter by kind** | `http/routes/plans.ts` | Add an optional `kind` to the querystring schema; filter in `services/plans.ts`. |
| Change the **period** from month to week | `domain/period.ts` | `periodOf` / `parsePeriod` / `periodLabel` and the `CHECK` on usage tables (a new migration). |
| Add a **new predefined plan** | `db/seed.ts` | Add an entry to `PREDEFINED_PLANS`; update the seeded-plans test and the README table. |
| Add a **per-request cap on history page size** | `http/schemas.ts` | Change `limit` max in `pageQuery`. |

## Where each requirement lives
| Requirement | Code | Test |
|---|---|---|
| API key auth, isolation | `http/auth.ts`, account-scoped repositories | `test/api.test.ts` |
| Both plans apply together | `domain/rules.ts` | `test/rules.test.ts`, `test/consume.test.ts` |
| The extra rule (daily allowance) | `domain/rules.ts`, `usage.record`, migration 004 | `test/rules.test.ts`, "daily allowance" tests in `consume.test.ts` and `usage.test.ts` |
| Rejection consumes nothing | `usage.record` (`$6::boolean` guard) | "brief examples" tests |
| Safe retries | `readContext` + `replay` | "safe retries" tests |
| Concurrent correctness | `usage.lockAccount` | "concurrency" tests (two instances) |
| Plan changes mid-month | usage keyed by month, plans read live | "plan changes" tests |
| Month rollover | `domain/period.ts` | "months" test |
| History + pagination | `repositories/requests.ts` | `test/usage.test.ts` |
| Performance evidence | `loadtest/` | `docs/PERFORMANCE.md` |
