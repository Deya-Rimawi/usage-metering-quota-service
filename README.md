# Usage Metering & Quota Service

Backend service that tracks usage and decides whether a user may consume units, enforcing an account plan and a user plan together.

> **Status:** Complete: API, demo client, load tests, security and code reviews, clean-clone verified.. The full plan is in [`docs/PLAN.md`](docs/PLAN.md).

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
