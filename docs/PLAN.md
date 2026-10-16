# Usage Metering & Quota Service: Master Plan (v2)

Goal: a correct, well-architected, well-documented service you can fully explain and modify live in an interview.
Priorities, in order: **correctness > reliability > explainability > performance > extras.**

---------------------------------------------------------------------------
## 1. Architecture

### 1.1 Style: modular monolith, layered, with a pure domain core
One deployable service, one Postgres. The brief says that is enough, and it removes distributed-systems failure modes that would not make the answers any more correct.

```
 Client app ──HTTP──▶ [ http ]──▶ [ services ]──▶ [ repositories ]──▶ PostgreSQL
 (demo web)           routes,      use cases,      SQL only,
                      zod schemas, transactions,   no business
                      auth hook,   orchestration   rules
                      error map         │
                                        ▼
                                  [ domain ]  ← PURE: no I/O.
                                  rule evaluation, period math,
                                  types, errors
```
Dependency rule: `http → services → (domain, repositories)`; `domain` imports nothing. The decision logic (which rule rejected?) is a pure function, so it is unit-testable without a database, and you can point at one file in an interview.

```
service/src/
  domain/        rules.ts (evaluate), period.ts, types.ts, errors.ts
  repositories/  accounts.ts users.ts plans.ts usage.ts requests.ts (SQL)
  services/      consume.ts accounts.ts users.ts plans.ts usage.ts
  http/          app.ts, auth.ts, errors.ts, routes/*.ts, schemas/*.ts
  db/            pool.ts, migrate.ts, sql/001_init.sql, seed.ts
  config.ts  main.ts
```

### 1.2 Tech choices (each gets an ADR)
| Concern | Choice | Alternatives rejected |
|---|---|---|
| Runtime | Node 22 + TypeScript (strict) | none, required |
| HTTP | Fastify + zod type provider + `@fastify/swagger` (OpenAPI generated from the same schemas, so docs can't drift) | Express (no built-in validation); Nest (too heavy to explain) |
| DB access | `pg` + hand-written SQL | ORM: hides the locking and SQL that the interview will probe |
| Migrations | Plain numbered `.sql` files plus a `schema_migrations` table, run at startup under a Postgres advisory lock | Heavy migration tools. The lock makes multi-instance startup safe |
| Tests | Vitest + real Postgres | Mocks for the DB: they can't prove concurrency |
| Load | autocannon (Node, reproducible via compose) + invariant checker | k6 (extra binary, can mention as alternative) |
| Logging | pino, with a request id per request | |
| Demo client | Tiny Node server + one static HTML page (key kept server-side) | SPA framework: pointless weight |

### 1.3 The central design problem: where do the totals live, and how do we update them safely?

| Option | Idea | Verdict |
|---|---|---|
| A. `SUM()` over the request log per decision | No counters, one source of truth | Rejected: O(n) per request, and still needs a lock to be race-free |
| B. **Counter rows + row locks inside one transaction** | `account_usage(account, month)` and `user_usage(user, month)`; lock, check, increment, log, commit | **Chosen.** O(1), exact, easy to reason about, and Postgres does the hard part |
| C. Redis / in-memory counters | Fast | Rejected: the brief wants durability and one DB; adds a consistency gap |
| D. Sharded counters (N sub-rows per account) | Removes the hot row | Documented as the upgrade path; it complicates exactness near the limit (a sub-row can't see the global remaining) |
| E. Serializable isolation + retry | Simple code | Rejected: abort storms on hot rows, retry logic needed anyway |

**Known cost of B:** every consume for one account serializes on that account's counter row (a per-account throughput ceiling). Mitigation, with evidence in PERFORMANCE.md: keep the transaction tiny, lock the hot row **last**, make it a single round trip. Different accounts never contend.

### 1.4 Consume algorithm (READ COMMITTED, one transaction)
```
BEGIN
 1. INSERT INTO requests(account_id, request_id, ...) ON CONFLICT DO NOTHING
      - conflict? (duplicate/retry) wait for the first txn, SELECT stored result,
        compare payload (same user+units?) → replay it (200, replayed:true) or 409.
 2. Read user + account + both plans (one JOIN; sees committed plan edits).
 3. Ensure counter rows exist (INSERT ... ON CONFLICT DO NOTHING).
 4. SELECT ... FOR UPDATE user_usage, then account_usage (FIXED ORDER everywhere: no deadlocks).
 5. domain.evaluate(plans, usedUser, usedAccount, units) → accept | reject(rule, level, violations[])
 6. accepted: UPDATE both counters += units.
 7. UPDATE requests row with the final decision plus a snapshot of the limits applied.
COMMIT
```
Properties (documented as invariants in CONCURRENCY.md, checked by tests and load runs):
- **I1** `account_usage.units == SUM(accepted units in requests for that account/month)` (same for users).
- **I2** Sum of accepted units never exceeds the allowance in force at decision time.
- **I3** Rejection changes no counters (the transaction either commits the rejected log row alone, or nothing).
- **I4** A `(account_id, request_id)` yields exactly one decision, forever.
- **I5** `account_usage == Σ user_usage` for the same month.

Step order and a possible optimization: v1 is the readable multi-statement version above. v2 (done only if the load test shows lock-hold time dominating) collapses steps 3-7 into one SQL statement/CTE, or a PL/pgSQL function, to cut round trips while the lock is held. Both versions are measured, and the winner is chosen on numbers (an ADR with a before/after table).

Plan edits: plans are read inside the consume transaction, so an update takes effect for every request that begins after the update commits. A request already past step 2 uses the old limits. That linearization point is documented.

Clock: the service passes one `now` per request (injectable `Clock`, UTC) into the period computation, which makes month rollover testable deterministically.

Number safety: units and limits are capped (`units <= 1e9`, `allowance <= 1e12`) so `BIGINT` values always fit in JS `Number`. The cap is documented and validated.

---------------------------------------------------------------------------
## 2. Data model (full ERD in docs/DATA_MODEL.md)
- `plans(id, account_id NULL=predefined, kind account|user, name, monthly_allowance NULL=unlimited, max_per_request NULL=unlimited, created_at, updated_at)`; UNIQUE (account_id, name); CHECK limits ≥ 1.
- `accounts(id, name, api_key_hash UNIQUE, plan_id → plans, created_at)`
- `users(id, account_id, external_id, plan_id, created_at)`; UNIQUE (account_id, external_id)
- `account_usage(account_id, period, units)` PK (account_id, period)
- `user_usage(user_id, period, units)` PK (user_id, period)
- `requests(id, account_id, request_id, user_id, units, period, accepted, rejected_rule, rejected_level, applied jsonb, created_at)`; UNIQUE (account_id, request_id); index (account_id, created_at DESC, id DESC) for keyset history
- Integrity enforced in the DB: foreign keys, CHECKs (plan.kind matches how it is assigned via a trigger or service check; units > 0), so bad data cannot get in from any code path.
- Predefined plans: Starter (10,000/mo, 100/req), Pro (1,000,000/mo, 1,000/req); Basic (500/mo, 20/req), Premium (5,000/mo, 200/req). Seeded idempotently with fixed IDs.

## 3. API (generated OpenAPI is the reference; docs/API.md has curl walkthroughs)
Auth: `X-API-Key` (everything except `POST /accounts`, which needs `X-Admin-Token`).
`POST /accounts` · `GET /account` · `PUT /account/plan` · `POST /account/api-key/rotate` · `POST|GET /users`, `GET /users/:id`, `PUT /users/:id/plan` · `GET /users/:id/limits` · `GET|POST /plans`, `GET|PATCH /plans/:id` · `POST /consume` · `GET /usage?period=` · `GET /users/:id/usage?period=` · `GET /requests?cursor&limit&userId&period` · `GET /health`, `GET /ready`.
Decisions: a rejection is HTTP 200 with `accepted:false` (a normal outcome, not an error); a retry returns the stored result with `replayed:true`; errors use `{error:{code,message,details?}}`; 401 bad key; 404 for another account's resource; 409 idempotency conflict; 422 validation; 403 editing a predefined plan.

## 4. Product assumptions (listed in docs/ASSUMPTIONS.md, each with reasoning)
Admin-gated account creation · NULL = unlimited · rule-evaluation order (user per-request → account per-request → user monthly → account monthly) with all violations also listed · rejected requests logged, counting nothing · retries return the original decision even if plans changed since · same `requestId` with a different payload gives 409 · plan switches never reset usage · reduced allowance gives remaining 0 · users cannot be deleted/moved between accounts · custom plans cannot be deleted while assigned (deletion out of scope) · `kind` of plan must match target (account plan on account, user plan on user) · key rotation invalidates the old key at once · history ordered newest first · default plans for new account/user: Starter/Basic.

## 5. Beyond-the-brief rule (small, demonstrable, optional, last)
Only if the core is finished and verified: per-minute rate limit as a third rule type in the same pure evaluator (one more input to `evaluate`, one more counter table). It sits in the evaluation order after per-request. It is documented and tested. Otherwise explicitly out of scope: "extra rules slot in at `domain/rules.ts`; here is how."

---------------------------------------------------------------------------
## 6. Documentation set (written as we build, not at the end)
| File | Purpose / what you will learn from it |
|---|---|
| `README.md` | 5-minute quick start, API key how-to, curl examples, links to everything below |
| `docs/ARCHITECTURE.md` | Context diagram, layers, request lifecycle (mermaid sequence diagram), folder map |
| `docs/DATA_MODEL.md` | ERD, every table and constraint, invariants I1-I5 |
| `docs/CONCURRENCY.md` | The consume algorithm step by step, why it is safe, locking order, failure modes (crash mid-transaction, duplicate retries, simultaneous plan edit) |
| `docs/API.md` + `docs/openapi.json` | Endpoint reference, request/response examples, error catalogue |
| `docs/ASSUMPTIONS.md` | Every unspecified product decision and why |
| `docs/decisions/ADR-001…` | One page each: runtime/framework, raw SQL, counters vs SUM, lock order, idempotency, rejection-as-200, API key storage, migrations, optimization chosen |
| `docs/TESTING.md` | Test pyramid, what each test proves, how to run |
| `docs/PERFORMANCE.md` | Method, scenarios, hardware, results tables, bottleneck analysis, what changed and what it bought, limits |
| `docs/WALKTHROUGH.md` | **Interview guide:** trace one `POST /consume` through each file with line references; 20 likely questions with answers; "small change" drills (add a rule, change the order, add a field) |
| `docs/LEARNING.md` | Plain-language primer: transactions, isolation levels, `SELECT FOR UPDATE`, idempotency keys, keyset pagination, hashing API keys. Each concept is tied to where it appears in the code |
| `docs/LIMITATIONS.md` | Hot-row ceiling, single-node DB, no key scopes, caps, and the upgrade path for each |

## 7. Quality gates
Strict TS, ESLint + Prettier, `npm run check` (typecheck + lint + test). Conventional commits, small and meaningful, one per task (git history is part of what reviewers read). CI workflow (GitHub Actions) runs check with a Postgres service. No secrets in the repo; `.env.example` only.

## 8. Test strategy (details in docs/TESTING.md)
- **Unit (pure, fast):** `evaluate()` truth table: each rule alone, all combinations, unlimited, boundaries (exactly at limit), reduced allowance, period math at UTC month edges and year rollover.
- **Integration (real Postgres, Fastify `inject`):**
  - Auth: missing key, invalid key, rotated key, admin token.
  - Isolation: account B cannot see or use account A's users, plans, requests, usage (every endpoint, each returns 404 or 401).
  - Each brief example (25-unit user per-request reject; 10-unit request rejected with 5 left on account; user has plenty).
  - Rejection consumes nothing; account total equals Σ users; shared plan, separate usage.
  - Plan change mid-month keeps usage; allowance cut below usage gives remaining 0 and reject; custom plan edit affects all assignees on the next request; predefined plan edit gives 403.
  - Month rollover with the injected clock; past month still queryable.
  - Idempotency: sequential retry, concurrent duplicate, conflicting payload, retry of a rejected request after a plan change.
  - Pagination: stable, no gaps or duplicates under inserts.
  - Restart persistence.
- **Concurrency:** 500 parallel consumes (limit 100 → exactly 100 accepted), mixed users, plan edit during the run; invariants I1-I5 asserted afterward.
- **Property-style check (small):** random sequences of consume/plan edits compared with an in-memory model.
- Run the unit and integration suites in compose (`docker compose run --rm tests`) so reviewers reproduce them with no local Node.

## 9. Performance plan (docs/PERFORMANCE.md)
Tooling in `loadtest/`: autocannon scenarios plus `verify.ts` (re-checks invariants I1-I5 from the DB after every run). Run through compose profile `load`.
Scenarios: (1) many accounts × many users, throughput ceiling; (2) **hot account**, many users on one account (worst case for B); (3) retry storm, 50% duplicate request IDs; (4) plan edits during load; (5) read endpoints (history, usage) under write load.
Method: warm-up, fixed duration, 3 runs, report RPS, p50/p95/p99, error rate, accept/reject counts, Postgres CPU. Establish a baseline (v1), profile (`pg_stat_statements`, lock waits via `pg_locks`/`pg_stat_activity`), then try one change at a time and keep only measured wins: pool size · single-round-trip statement · API-key lookup cache with a short TTL (and rotation invalidation) · index review · optional `synchronous_commit` tradeoff (documented, default OFF-the-table because it risks losing acknowledged commits).
Each change is re-verified for correctness (the invariants must still hold) before the numbers count.

## 10. Demo client
Node server + HTML page at :8080, calling the service with a demo account's key held server-side (the browser never sees it; also the realistic integration pattern). Bootstrap on startup creates the demo account, two users (Basic and Premium), and a small account plan so the account limit is reachable. Buttons or a "Run scenario" flow: accepted action → user-limit rejection → account-limit rejection → switch plan (or edit the custom plan) → same action now accepted. Live panel showing decision, rule + level, and remaining for both. The client code is identical before and after the plan change, which is the point.

## 11. Docker Compose
Services: `db` (Postgres 16, healthcheck, named volume), `service` (multi-stage build, non-root, runs migrate+seed then serves, waits for db health), `client`, and profile-gated `tests` and `loadtest`. `docker compose up --build` is the only command needed; ports: service :3000 (Swagger UI at `/docs`), client :8080. All config through env with safe demo defaults in `.env.example`.

---------------------------------------------------------------------------
## 12. Workflow and skills (how I'll build it)
1. **spec** skill: freeze SPEC (the sections above) → review with you.
2. **plan / build / test (TDD)** skills per phase: failing test first, then the code, small commit.
3. **doubt-driven review** on the consume algorithm (fresh-context adversarial review of concurrency correctness).
4. **security-and-hardening** + security-auditor agent on auth, key storage, isolation, input limits.
5. **code-review** agent (five axes) and **ponytail-review** to cut over-engineering.
6. **performance-optimization** for the measured tuning loop.
7. **documentation-and-adrs** for every doc above; **ship** checklist for the final go/no-go (clean clone → `docker compose up --build` works).

## 13. Phases (7 days, buffer built in)
| Day | Deliverable | Done when |
|---|---|---|
| 1 | Scaffold, config, compose+db, migrations, seed, `/health`; SPEC and ADR-001..3 | `docker compose up` healthy; restart keeps data |
| 2 | Auth, accounts, users, plans CRUD, isolation tests | all auth and isolation tests green |
| 3 | `domain/rules` + consume v1 + idempotency + concurrency test | all brief examples + 500-parallel test green |
| 4 | Usage, history, limits endpoints; month rollover; plan-change tests; OpenAPI + `/docs` | full integration suite green |
| 5 | Demo client; end-to-end scenario in compose | scenario runs from a clean clone |
| 6 | Load tests, profiling, optimization (v2), PERFORMANCE.md with real numbers | invariants hold after every run |
| 7 | Docs pass (WALKTHROUGH, LEARNING, LIMITATIONS), CI, review/security passes, clean-clone ship check, optional rate-limit rule | checklist all green |

## 14. Risk list
Concurrency bug (mitigated: invariants plus tests plus adversarial review) · hot-row throughput looks poor (mitigated: measured, honest explanation, sharding upgrade path documented) · over-scoping (mitigated: the extra rule is last and optional) · docs lag (mitigated: each doc is a task in its phase's definition of done).
