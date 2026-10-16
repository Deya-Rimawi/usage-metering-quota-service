# Usage Metering & Quota Service

Backend service that tracks usage and decides whether a user may consume units, enforcing an account plan and a user plan together.

**What is in the repo:** the service (`service/`), an example client with a web page (`client/`), load tests (`loadtest/`), and documentation (`docs/`), all in TypeScript on PostgreSQL. One command starts all of it.

## Quick start
```bash
cp .env.example .env
docker compose up --build        # service :3000, demo client :8080, Postgres on 127.0.0.1:5433
curl localhost:3000/ready
```
- **Demo client:** http://localhost:8080 (click *Run scenario*; details in [`docs/DEMO.md`](docs/DEMO.md))
- **Interactive API docs:** http://localhost:3000/docs

## Develop and test
```bash
cd service && npm install
docker compose up -d db          # tests use the compose database on 127.0.0.1:5433
npm run check                    # typecheck + 82 tests
(cd ../client && npm install && npm run typecheck)   # the client and load tests are TypeScript too (Node runs them directly)
docker compose --profile tools run --rm e2e   # demo scenario against the live stack
```

## Predefined plans
| Plan | Kind | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 1,000,000 | 1,000 |
| Basic | user | 500 | 20 |
| Premium | user | 5,000 | 200 |

## Try it
```bash
# 1. Create an account (admin token from .env). The apiKey is shown ONCE.
curl -s -X POST localhost:3000/accounts -H 'x-admin-token: dev-admin-token' \
  -H 'content-type: application/json' -d '{"name":"Acme","planId":"starter"}'
export KEY=mk_...   # paste the apiKey

# 2. Register users and give one a bigger plan
curl -s -X POST localhost:3000/users -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"userId":"alice"}'
curl -s -X PUT  localhost:3000/users/alice/plan -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"planId":"premium"}'

# 3. Create a custom plan (null = unlimited) and change it later, with no redeploy
curl -s -X POST  localhost:3000/plans -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"kind":"user","name":"Team","monthlyAllowance":100,"maxPerRequest":10}'
curl -s -X PATCH localhost:3000/plans/<planId> -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"monthlyAllowance":200}'

# 4. Consume units. Same requestId = safe retry.
curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"alice","units":10,"requestId":"doc-123"}'
```
Response (HTTP 200 whether accepted or not):
```json
{ "accepted": false, "rule": "max_per_request", "level": "user",
  "message": "The user's plan allows at most 20 units per request; 25 requested",
  "violations": [ { "level": "user", "rule": "max_per_request", "limit": 20, "requested": 25, "remaining": null } ],
  "user":    { "planId": "basic",   "monthlyAllowance": 500,   "maxPerRequest": 20,  "used": 0, "remaining": 500 },
  "account": { "planId": "starter", "monthlyAllowance": 10000, "maxPerRequest": 100, "used": 0, "remaining": 10000 },
  "replayed": false, "requestId": "doc-123", "userId": "alice", "units": 25, "period": "2026-10" }
```
Errors always look like `{"error":{"code":"...","message":"..."}}`.

## How it works

**Model.** An **account** is the calling application; it has an API key and an *account plan* whose limits are shared by all its users. A **user** belongs to one account and has a *user plan*. A **plan** is a named set of rules. **Units** are the single metered resource. The two plans apply together: a larger user allowance never raises the account's shared allowance.

**Supported rules** (in both account and user plans; `null` = unlimited):
| Rule | Meaning |
|---|---|
| `monthlyAllowance` | Total units available in a UTC calendar month |
| `maxPerRequest` | Largest amount a single request may consume |

A request is accepted only if **all four** checks pass (user per-request, account per-request, user monthly, account monthly). A rejection consumes nothing. The response names the first broken rule in this fixed order and whether it belongs to the `user` or the `account`, and lists every broken rule in `violations`. Accepted units are added to the user's usage **and** the account's usage; the account's usage is the sum of its users'.

**API keys.** An admin creates an account (`POST /accounts` with `X-Admin-Token`); the response contains the account's `apiKey` **once**. The calling backend sends it as `X-API-Key` on every other call. The key identifies the account and gives access to that account's data only: another account's users and plans answer `404`; a missing or invalid key answers `401`. Only a SHA-256 hash of the key is stored. `POST /account/api-key/rotate` replaces the key (an admin can also do this if the key is lost).

**Plan changes.** Edits and plan switches apply to every request that starts after the change succeeds, with no redeploy. Units already consumed this month are kept, so switching plans never grants a fresh allowance. Editing a custom plan affects every account or user assigned to it. If an allowance is lowered below existing usage, remaining shows `0` and consumption at that level is rejected until the allowance exceeds usage again or the month rolls over. Past request history is never rewritten: each decision stores the limits that applied when it was made. Predefined plans are read-only; create a custom plan to change limits. Several users can share one plan and still keep separate usage.

**Months.** Usage belongs to the UTC month in which the request is *processed*. Each month starts at zero for the account and every user; earlier months stay queryable (`/usage?period=2026-09`, `/requests?period=2026-09`).

**Retry behavior.** Send a unique `requestId` with every consume. If you retry the same `requestId` (for example after a timeout), you get the original decision back with `replayed: true` and nothing is counted twice, even if you retry concurrently. Reusing a `requestId` with a different user or amount returns `409`. Use a new `requestId` for a new attempt. A rejected request is also remembered, so retrying it returns the same rejection.

## API summary
Full reference with examples: [`docs/API.md`](docs/API.md); interactive docs at `/docs` (Swagger UI, generated from the same schemas that validate requests).
| Endpoint | Purpose |
|---|---|
| `POST /accounts` (admin) | Create an account, get its API key |
| `GET /account`, `PUT /account/plan`, `POST /account/api-key/rotate` | Inspect the account, change its plan, rotate its key |
| `POST /users`, `GET /users`, `GET /users/{id}`, `PUT /users/{id}/plan` | Register users, assign or change their plans |
| `GET /plans`, `POST /plans`, `GET /plans/{id}`, `PATCH /plans/{id}` | Predefined plus custom plans |
| `POST /consume` | Decide and record a consumption |
| `GET /users/{id}/limits` | Plans and limits currently applied to a user and the account, with remaining units |
| `GET /usage`, `GET /users/{id}/usage` | Consumed and remaining units, by month |
| `GET /requests` | Decision history (filter by user, month, outcome), cursor-paginated |

## Product assumptions
The brief leaves some behavior open; these are the main choices (all 33, with reasoning, are in [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md)).
- **Creating accounts needs an admin token**, because the brief does not say who may mint accounts. The demo token is a documented default.
- **Users are identified by the caller's own `userId`** (unique within an account; two accounts may reuse the same id).
- **A rejection is HTTP 200 with `accepted: false`**, not an error: callers branch on `accepted`. 4xx is for bad input, bad keys, unknown users, or a reused `requestId`.
- **Rule order is fixed** (user per-request, account per-request, user monthly, account monthly) so the reported reason is predictable.
- **Rejected requests are logged** and count toward no usage.
- **`remaining` is reported for the current month only**; for past months `used` is the record (a closed month has nothing left to consume).
- **Limits are integers** (monthly up to 1e12, per request and units up to 1e9) so every value is exact; `null` means unlimited.
- **Plans cannot be deleted** and users cannot be removed or moved (out of scope; deleting would orphan history).

## Main design decisions
- **Totals are exact because of one database row lock per account.** A consume locks the account's monthly counter, reads fresh state, decides with a pure function, and writes the decision and counters in one statement. Details: [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md), [ADR-005](docs/decisions/ADR-005-lock-first-consume.md).
- **Counters are keyed by (owner, month), not by plan**, so a plan switch cannot reset usage; the request log is kept as the audit trail and as the check the counters are verified against.
- **Pure domain core** (`service/src/domain/rules.ts`): the decision logic has no database or HTTP in it, so it is unit-tested with a truth table. Layers: http, services, repositories ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).
- **Raw SQL, no ORM**, so locking and statements are visible ([ADR-002](docs/decisions/ADR-002-raw-sql-no-orm.md)); the schema itself enforces plan kind, unique request ids and non-negative counters ([`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)).
- **Performance was measured, then improved** (fewer round trips, prepared statements, a per-account gate against one tenant starving the connection pool); every change was kept only if the correctness invariants still held ([`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)).

## Known limitations
Full list with upgrade paths: [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).
- **One account is limited to roughly 250-300 consumes per second** (about 1,600/s across many accounts on a laptop). Exact totals require serializing an account; about 60% of that time is the commit's disk flush. The upgrade path is batching decisions or sharded counters.
- **One PostgreSQL and one Node process were measured**; the service is stateless so more instances can run, but multi-node behavior is not load-tested.
- **API keys have no scopes, expiry or multiple keys per account**; only the admin endpoints are rate-limited; there is no TLS (put a proxy in front).
- **History grows without bound** (one row per decision); partitioning and retention are not implemented.
- **Load-test numbers are relative**, taken on one laptop with the load generator, service and database sharing CPU.
- **No extra rule type beyond the two required ones** was added; `domain/rules.ts` shows where one would go ([`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md)).

## Performance at a glance
One account is decided at about **250-300 requests/s** (exact totals require serializing it); many accounts reach about **1,600 requests/s** on a laptop. Correctness invariants held across 1.2 million load-test requests. Details, method and how to reproduce: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
```bash
docker compose --profile tools run --rm --build loadtest all --label mine   # ~6 minutes
```

## Configuration
All via environment variables (Compose reads `.env`; see `.env.example`). Only the first two normally need changing.
| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_TOKEN` | `dev-admin-token` (demo) | Secret for creating accounts. **Change it before exposing the service.** The service warns while the demo value is in use. |
| `POSTGRES_PASSWORD` | `metering` (demo) | Database password |
| `BIND_ADDR` | all interfaces | Set to `127.0.0.1` to publish the service and demo client on localhost only |
| `SERVICE_PORT`, `CLIENT_PORT` | 3000, 8080 | Host ports for the service and demo client, if those are already in use |
| `PG_POOL_MAX` | 20 | Database connections per service instance |
| `ACCOUNT_CONCURRENCY` | 1 | Consumes allowed to run at once per account per instance ([ADR-006](docs/decisions/ADR-006-per-account-gate.md)) |
| `ACCOUNT_QUEUE_MAX` | 1000 | Consumes allowed to wait for one account before the service answers 503 |
| `ADMIN_RATE_LIMIT_PER_MIN` | 600 | Per-IP limit on admin endpoints |
| `DOCS_ENABLED` | true | Serve Swagger UI at `/docs` |
| `LOG_LEVEL` | info | pino log level |

## Docs
- [`docs/PLAN.md`](docs/PLAN.md): architecture, schedule, and the documentation roadmap
- [`docs/DEMO.md`](docs/DEMO.md): the example client and the guided scenario
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model, controls, review results
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): layers, diagrams, request lifecycle
- [`docs/API.md`](docs/API.md): endpoint reference, error catalogue ([`openapi.json`](docs/openapi.json))
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): ER diagram, constraints, invariants
- [`docs/TESTING.md`](docs/TESTING.md): what every test proves, and the checks that show the tests can fail
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md): load-test method, results, bottleneck analysis, what helped and what did not
- [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md): how consume stays correct under parallel requests
- [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md): every product decision the brief left open
- [`docs/decisions/`](docs/decisions): architecture decision records
