# Requirements checklist: the brief, line by line

Every requirement in the brief, where it is implemented, and the evidence. Test names refer to `service/test/*.test.ts` unless noted; run them with `cd service && npm run check`.

## Accounts, users and plans
| Requirement | Implementation | Evidence | Docs |
|---|---|---|---|
| An account has an account plan; each user has a user plan; the two apply together; a larger user allowance never raises the account's | `domain/rules.ts` checks every rule at both levels | `rules.test.ts` ("the brief examples", all combinations); `consume.test.ts` "the brief examples" | README *How it works* |
| One resource, "units", positive whole numbers | zod schema `units` 1..1e9 integer | `consume.test.ts` "validates units, ids and body shape" | ASSUMPTIONS #3 |
| API key in a request header; reject missing or invalid; the key grants access only to that account's data | `http/auth.ts` (`X-API-Key`, sha256 lookup); every query scoped by the authenticated account | `api.test.ts` "API key authentication", "account isolation" | PROVISIONING, SECURITY |
| Validate that any supplied user belongs to the identified account | users are looked up by `(account, userId)`; foreign users answer 404 | `consume.test.ts` "cannot consume for another account's user"; `api.test.ts` isolation | SECURITY |

## Core features
| Requirement | Implementation | Evidence | Docs |
|---|---|---|---|
| Create accounts and issue an API key for each | `POST /accounts` (admin token; optional `OPEN_SIGNUP`); key shown once, only its hash stored | `api.test.ts` "API key authentication"; `signup.test.ts` | PROVISIONING, ADR-008 |
| Register users, assign or change their plans; keep accounts' users and usage separate | `POST /users`, `PUT /users/{id}/plan`; usage keyed by owner | `api.test.ts` "users"; "account isolation" | API |
| Predefined plans for accounts and users at startup, with documented example limits | `db/seed.ts` (Starter, Pro, Basic, Premium), upserted on every boot | `foundation.test.ts` "seeds the four predefined plans" | README *Predefined plans* |
| Custom plans: create, view, update; assign to the account or users; several users share one plan with separate usage; predefined read-only | `POST/GET/PATCH /plans` | `api.test.ts` "custom plans"; `consume.test.ts` "users sharing a plan keep separate allowances" | API |
| Consume: user id, positive whole units, request id; accept the full amount only if every rule allows; a rejection consumes nothing | `POST /consume`, one transaction (`services/consume.ts`) | `consume.test.ts` "the brief examples" ("rejection consumes nothing") | CONCURRENCY |
| Explain decisions: accepted or not; for a rejection, a rule and whether it is the account's or the user's; inspect plans and limits | response `rule`, `level`, `violations`, balances; `GET /users/{id}/limits` | `consume.test.ts`; `usage.test.ts` "limits" | API |
| Usage and history: consumed and remaining for account and users; previous months; request outcomes; simple pagination | `GET /usage?period=`, `GET /requests` (cursor pagination) | `usage.test.ts` "usage", "request history" (stable pagination) | API, ASSUMPTIONS #22-26 |
| Preserve data across restarts | everything in PostgreSQL | clean-clone check: restart of db and service, full `down`/`up` ([TESTING](TESTING.md)) | ARCHITECTURE |
| Choose and document endpoints, formats, database design | OpenAPI (generated), data model | `usage.test.ts` "API docs" | API, DATA_MODEL |

## How plans affect consumption
| Requirement | Implementation | Evidence |
|---|---|---|
| Monthly allowance (UTC month) and maximum per request, for both plan kinds | `domain/rules.ts`, `account_usage` / `user_usage` | `rules.test.ts` |
| 25 units rejected by the user's per-request limit even with monthly room | evaluation order and rules | `consume.test.ts` "rejects 25 units on the user per-request limit..." |
| 10 units accepted adds 10 to the user and 10 to the account | one write statement updates all counters | "accepts 10 units and adds 10 to both..." |
| Only 5 left on the account: a 10-unit request is rejected though the user has plenty | monthly rule at account level | "rejects 10 units when the account has only 5 left..." |
| Account usage = sum of its users' accepted usage; sharing a plan does not share the individual allowance | counters per owner | "account usage is the sum of its users" |
| New usage belongs to the UTC month when processed; each month starts at zero; earlier months queryable | month taken after the lock; counters keyed by month | `consume.test.ts` "months", "queues across midnight"; `usage.test.ts` past months |

## Changing and extending rules
| Requirement | Implementation | Evidence |
|---|---|---|
| Plan changes apply to new requests after the update succeeds | plans read live inside each consume | "an edit to a shared custom plan applies to the very next request" |
| Updating an account's custom plan affects the account or users assigned to it | plan rows are shared by reference | "an account plan edit applies to all its users" |
| Switching plans preserves units already consumed (no fresh allowance) | counters not keyed by plan | "switching plans keeps units already consumed" |
| Allowance reduced below usage: zero remaining, rejected until available again | `remaining = max(0, ...)` | "an allowance cut below existing usage shows 0 remaining..." |
| Changes preserve past request history | every decision stores a snapshot of the limits that applied | "history keeps the limits that applied at the time" |
| Additional rules: explain interaction with account and user plans and demonstrate | the **daily allowance**: [ADR-007](decisions/ADR-007-daily-allowance.md); demo scenario step 7 | `rules.test.ts` and `consume.test.ts` "daily allowance (the extra rule)" |

## Example application
| Requirement | Implementation | Evidence |
|---|---|---|
| A small working client that calls the service with an account's key on behalf of its users | `client/` (TypeScript server + one page); the key stays server-side | `client/test/scenario.test.ts` |
| Users with different plans; an accepted action; a rejection by a user limit; a rejection by the shared account limit | guided scenario (alice Basic, bob Premium, a small account plan) | scenario steps 1-5 |
| Configure or switch a plan and show the change **without changing client code** | steps 6-9 change plans through configuration endpoints only | scenario steps 6-9 |
| Display the decision and remaining allowances; instructions to run | page shows decision, rule, level, balances; DEMO.md | `docs/DEMO.md` |

## Docker Compose and setup
| Requirement | Implementation | Evidence |
|---|---|---|
| `docker compose up --build` starts service, PostgreSQL, the client | `docker-compose.yml` (db, service, client; tools profile for tests and load) | CI job and the clean-clone check |
| Database initialization and predefined plans as part of startup | migrations under an advisory lock, then seed, at boot (`main.ts`) | `foundation.test.ts` (idempotent migrations) |
| Document required configuration and how to reach the client | README *Configuration*, `.env.example` | README |

## Performance
| Requirement | Implementation | Evidence |
|---|---|---|
| Test under load, keeping totals and decisions correct as rules change and requests arrive concurrently | `loadtest/` (8 scenarios, including plan edits during load); invariants re-verified from the database after every run | [PERFORMANCE.md](PERFORMANCE.md) (results, bottleneck analysis, what changed) |
| Committed tests, scripts, tools, configuration, commands and dependencies to reproduce | `loadtest/`, Compose `tools` profile; only Docker needed | PERFORMANCE.md section 8 |

## What the evaluation looks at
| Area | Where to look |
|---|---|
| Correctness | `domain/rules.ts`, `consume.test.ts`, the invariants in [CONCURRENCY.md](CONCURRENCY.md) |
| Reliability | idempotent retries, row-lock concurrency tests across two instances, restart checks, error catalogue in [API.md](API.md) |
| Performance | [PERFORMANCE.md](PERFORMANCE.md) |
| Design and code quality | [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [decisions/](decisions/README.md) |
| Local setup | README quick start, `docker-compose.yml`, `.devcontainer/` (GitHub Codespaces) |
| Documentation and usability | README, [API.md](API.md), [DEMO.md](DEMO.md), [TESTING.md](TESTING.md) |
| Understanding and judgment | [ASSUMPTIONS.md](ASSUMPTIONS.md), [LIMITATIONS.md](LIMITATIONS.md), [WALKTHROUGH.md](WALKTHROUGH.md) |

## Deliverables
| Deliverable | Status |
|---|---|
| GitHub repository with the service, predefined plans and example client | this repository |
| Docker Compose file and Dockerfiles for the complete stack | `docker-compose.yml`, `service/Dockerfile`, `client/Dockerfile`, `loadtest/Dockerfile` |
| README covering API, model, keys, rules, plan changes, retries, assumptions, decisions, limitations | README |
| Automated tests incl. API key validation and account isolation | 123 service tests + 2 end-to-end tests ([TESTING.md](TESTING.md)); CI runs them |
| Performance results with reproducible tests, scripts, tools | `loadtest/` and `loadtest/results/` |
| Be ready to trace a request, explain decisions, make a small change | [WALKTHROUGH.md](WALKTHROUGH.md) (request trace, questions, live-change drills), [LEARNING.md](LEARNING.md) |
