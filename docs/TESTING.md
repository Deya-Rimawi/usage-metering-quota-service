# Testing

Everything below runs from a clean clone. Totals: **105 service tests + 2 end-to-end tests + a load-test suite that re-verifies correctness after every run.**

## How to run
```bash
docker compose up -d db                 # tests use the compose database on 127.0.0.1:5433
cd service && npm install && npm run check      # typecheck + all 105 tests (about 20 s)
(cd client && npm install && npm run typecheck); (cd loadtest && npm install && npm run typecheck)   # client and load tooling are TypeScript, run by Node directly
cd .. && docker compose up -d --build && docker compose --profile tools run --rm e2e    # demo scenario against the live stack
docker compose --profile tools run --rm loadtest all --duration 8 --runs 1 --label smoke   # load + invariants (see PERFORMANCE.md)
```
Tests use a real PostgreSQL (database `metering_test`, created on first run) rather than mocks, because the behaviour that matters (row locks, unique indexes, snapshots) lives in the database. Test files run one after another since they share that database; the in-process clock is injectable so months can be moved deterministically.

## What each file proves
| File | Tests | Proves |
|---|---:|---|
| `rules.test.ts` | 17 | The pure decision function: each rule alone, all combinations, boundaries (exactly at the limit), unlimited (`null`), allowance reduced below usage, rule order, the brief's two examples; **the daily allowance** (alone, boundaries, order, larger than monthly, cut below usage); UTC month and day edges; period parsing |
| `api.test.ts` | 15 | API-key authentication (missing, invalid, rotated), admin token, hash-only storage, users, pagination, custom plans (create, edit, share, `null` = unlimited, read-only predefined), **account isolation on users and plans** |
| `consume.test.ts` | 35 | The brief's three consumption examples; account usage = sum of users; shared plan keeps separate usage; plan switch keeps usage; plan edit applies to the next request; allowance cut below usage; history keeps the limits applied then; month rollover (and a request that queues across midnight); safe retries (replay, replay of a rejection after a plan change, 409 on a changed payload, replay in a later month); input validation and cross-account refusal; **daily allowance** (user and account rejection, midnight reset while the month keeps counting, order before monthly, plan switch and edit, retry on a later day, queue across midnight, concurrency); **concurrency** (below); decision order |
| `usage.test.ts` | 16 | Usage and remaining for account and users (monthly and daily), past months, malformed and future periods, user-list pagination, limits endpoint follows plan changes, request history (order, filters, stable pagination while new requests arrive), history survives plan changes, OpenAPI is served and complete |
| `hardening.test.ts` | 10 | Bad cursors, control characters and impossible periods give 4xx never 500; the Postgres data-error safety net; admin rate limit; per-account plan cap; response headers; docs switch; admin key recovery |
| `gate.test.ts` | 6 | The per-account gate: one at a time per key, order, parallel across keys, errors do not block the queue, limit N, no leak, bounded queue (503) |
| `foundation.test.ts` | 6 | Predefined plans seeded with the documented values, migrations are idempotent, the database refuses a user plan on an account, health and readiness, waiting for the database at startup |
| `client/test/scenario.test.ts` | 2 | The demo scenario end to end against the real service: every step as expected, final balances add up |

## Concurrency tests (the important ones)
In `consume.test.ts`, all racing requests are spread over **two app instances** (two separate in-process gates, one database), so only the database lock can be what keeps them correct:
- 200 parallel requests against a 100-unit user allowance: **exactly 100 accepted**; the same against a 100-unit **daily** allowance, and 120 requests from 6 users against a shared 90-unit daily allowance: **exactly 30 accepted**
- 300 requests from 10 users racing for a shared 120-unit account allowance: **exactly 60 accepted** (60 x 2 = 120)
- 20 simultaneous duplicates of one `requestId`: **one decision, counted once**
- plan edits during a 150-request burst: counters stay consistent
- the same race with `ACCOUNT_CONCURRENCY=3` on a single instance
- usage reads during writes: the account total always equals the sum of the users in the same response

After each, `brokenInvariants()` recomputes from the database: counters = sum of the accepted log (I1), account = sum of users (I5), every accepted decision fits the allowance that applied to it (I2), and every accepted request left a counter (the reverse of I1). See [CONCURRENCY.md](CONCURRENCY.md).

## Proof the tests can fail (mutation checks)
A passing test proves little unless it fails when the code is wrong. I broke the code on purpose and confirmed the matching test fails; each was then restored:
| Break | Test that failed |
|---|---|
| Remove `FOR UPDATE` from the account lock | both allowance-race tests (the allowance is overspent) |
| `created_at` back to `now()` (transaction start) | "history order follows decision order" |
| Skip the month re-check after taking the lock | "a request that queues across midnight..." |
| Read usage without a shared snapshot | "a usage response describes one instant" (3 of 3 runs) |
| Daily rule not evaluated | 8 of the 10 daily tests |
| User's daily counter never written | 8 of the 10 daily tests |
| Today's usage taken from the monthly counter | "resets at 00:00 UTC while the monthly total keeps counting" |
| (earlier) the gate alone masking a missing lock | motivated running the race across two instances |

## Beyond unit and integration tests
- **Load tests** (`loadtest/`): seven scenarios; after every run the verifier checks the same invariants against the database, so a throughput number only counts if the totals are still exact. About 1.2 million requests verified.
- **Clean-clone check:** a fresh `git clone`, `cp .env.example .env`, `docker compose up --build`, then the README's curl walkthrough, the demo scenario, `e2e`, a fresh `npm ci && npm run check`, a load smoke run, a restart of the database and service (data and idempotency survive), a full `down`/`up` with the volume kept, and a process exit (the restart policy brings the service back). This found one real problem (the service died if it started while the database was restarting), now fixed and tested.
- **Two independent reviews** (security and five-axis code review) were run on the finished code; every finding got a fix and, where behaviour changed, a test. See [SECURITY.md](SECURITY.md).

## Gaps I know about
- Tests run on one machine against one PostgreSQL version (16); there is no multi-node or failover test.
- The demo client's page script is syntax-checked and its server endpoints are exercised, but the page is not driven by a browser in CI.
- Load numbers are relative, not production capacity ([PERFORMANCE.md](PERFORMANCE.md) explains why).
