# Usage Metering & Quota Service

Backend service that tracks usage and decides whether a user may consume units, enforcing an account plan and a user plan together.

> **Status:** Day 1 of 7 (scaffold, schema, migrations, seeded plans). The full plan is in [`docs/PLAN.md`](docs/PLAN.md).

## Quick start
```bash
cp .env.example .env
docker compose up --build        # service on http://localhost:3000, Postgres on 127.0.0.1:5433
curl localhost:3000/ready
```

## Develop and test
```bash
cd service && npm install
docker compose up -d db          # tests use the compose database on 127.0.0.1:5433
npm run check                    # typecheck + tests
```

## Predefined plans
| Plan | Kind | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 1,000,000 | 1,000 |
| Basic | user | 500 | 20 |
| Premium | user | 5,000 | 200 |

## Docs
- [`docs/PLAN.md`](docs/PLAN.md): architecture, schedule, and the documentation roadmap
- [`docs/decisions/`](docs/decisions): architecture decision records
