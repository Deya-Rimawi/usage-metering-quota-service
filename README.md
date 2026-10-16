# Usage Metering & Quota Service

Backend service that tracks usage and decides whether a user may consume units, enforcing an account plan and a user plan together.

> **Status:** Day 2 of 7 (accounts, API keys, users, plans, isolation). Consume, usage and history come next. The full plan is in [`docs/PLAN.md`](docs/PLAN.md).

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
```
Errors always look like `{"error":{"code":"...","message":"..."}}`.

## Docs
- [`docs/PLAN.md`](docs/PLAN.md): architecture, schedule, and the documentation roadmap
- [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md): every product decision the brief left open
- [`docs/decisions/`](docs/decisions): architecture decision records
