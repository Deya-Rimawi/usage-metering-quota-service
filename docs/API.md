# API reference

Interactive docs: **http://localhost:3000/docs** (Swagger UI, generated from the same schemas that validate requests).
Machine-readable: [`openapi.json`](openapi.json) (regenerate with `npm run openapi` in `service/`).

## Authentication
| Header | Used for |
|---|---|
| `X-Admin-Token: <ADMIN_TOKEN>` | Only `POST /accounts` |
| `X-API-Key: mk_...` | Every other endpoint except `/health`, `/ready`, `/docs` |

The key identifies the calling account. Every query is scoped to that account, so a key can only ever reach its own users, plans, usage and history. Someone else's resource looks like it does not exist (404).

## Conventions
- JSON in, JSON out. Times are ISO-8601 UTC. A `period` is `YYYY-MM` (UTC calendar month).
- Limits: `null` means unlimited. Monthly allowance 1..1e12, per-request 1..1e9, units 1..1e9, all integers.
- Lists use cursor pagination: `?limit=50&cursor=<nextCursor>`; `nextCursor: null` means the last page.
- Errors: `{ "error": { "code": "...", "message": "...", "details": ... } }`

| Status | Codes | Meaning |
|---|---|---|
| 401 | `unauthorized` | Missing/invalid API key or admin token |
| 403 | `predefined_plan_read_only`, `account_limit_reached`, `external_id_requires_admin`, `signup_closed` | Tried to edit a predefined plan; the account hit its plan/user cap; `externalId` without the admin token; self-service signup cap reached |
| 404 | `not_found` | Unknown route, or user/plan that does not exist **for this account** |
| 409 | `user_exists`, `plan_name_taken`, `idempotency_conflict` | Duplicate, or a `requestId` reused with a different user/amount |
| 422 | `validation_error`, `wrong_plan_kind`, `bad_cursor`, `bad_period`, `future_period`, `invalid_input` | Invalid input (`invalid_input`: a value the database refused) |
| 429 | `rate_limited` | Too many account-creation or admin requests from one IP |
| 500 | `internal_error` | Bug or outage; details are in the server log, never in the response |
| 503 | `account_busy` | Too many consumes already waiting for this account on this instance; retry shortly |

## Endpoints
| Method & path | Purpose |
|---|---|
| `POST /accounts` | (admin token, or no token when `OPEN_SIGNUP=true`) Create an account; returns the API key **once**. Pass `externalId` (your own customer id) to make it idempotent: a repeat returns `200 {created:false, apiKey:null}` instead of a duplicate |
| `POST /accounts/{accountId}/api-key/rotate` | (admin) New key for an account that lost its key |
| `GET /account` | The account, its plan and limits |
| `PUT /account/plan` | `{planId}` change the account plan |
| `POST /account/api-key/rotate` | New key; the old one stops working immediately |
| `POST /users` | `{userId, planId?}` register a user (default plan `basic`) |
| `GET /users` | List users (paginated) |
| `GET /users/{userId}` | One user and their plan |
| `PUT /users/{userId}/plan` | `{planId}` change a user's plan |
| `GET /plans` | Predefined plus your own plans |
| `POST /plans` | `{kind, name, monthlyAllowance?, dailyAllowance?, maxPerRequest?}` create a custom plan (omitted or `null` = unlimited) |
| `GET /plans/{planId}` | One plan |
| `PATCH /plans/{planId}` | Partial update of a custom plan; applies to the next request |
| `POST /consume` | **Decide and record a consumption** |
| `GET /usage?period=` | Account usage for a month with every user |
| `GET /users/{userId}/usage?period=` | One user's usage plus their account's |
| `GET /users/{userId}/limits` | Plans and limits currently applied, with remaining units now |
| `GET /requests?userId=&period=&accepted=` | Decision history, newest first |

## `POST /consume`
```http
POST /consume
X-API-Key: mk_...

{ "userId": "alice", "units": 25, "requestId": "doc-123" }
```
Always HTTP 200 when a decision was made. Branch on `accepted`:
```json
{
  "requestId": "doc-123", "userId": "alice", "units": 25, "period": "2026-10",
  "accepted": false,
  "rule": "max_per_request",
  "level": "user",
  "message": "The user's plan allows at most 20 units per request; 25 requested",
  "violations": [ { "level": "user", "rule": "max_per_request", "limit": 20, "requested": 25, "remaining": null } ],
  "user":    { "planId": "basic",   "planName": "Basic",   "monthlyAllowance": 500,   "dailyAllowance": 100,  "maxPerRequest": 20,  "used": 0, "remaining": 500, "usedToday": 0, "remainingToday": 100 },
  "account": { "planId": "starter", "planName": "Starter", "monthlyAllowance": 10000, "dailyAllowance": 2000, "maxPerRequest": 100, "used": 0, "remaining": 10000, "usedToday": 0, "remainingToday": 2000 },
  "replayed": false
}
```
- `rule`: `max_per_request`, `daily_allowance` or `monthly_allowance`. `level`: `account` or `user`. Both are `null` when accepted.
- `violations` lists **every** broken rule; the first is the primary reason (order: user per-request, account per-request, user daily, account daily, user monthly, account monthly).
- `user` / `account` show the plan applied and the balance **after** this decision: month (`used`, `remaining`) and day (`usedToday`, `remainingToday`; `null` when the plan has no daily limit or for past months).
- **Retries:** send the same `requestId`. You get the original decision again with `replayed: true`; nothing is counted twice. Use a new `requestId` for a new attempt. Reusing an id with a different user or amount returns 409.

## Typical flows
**Integrate:** create the account once (admin), store the key in your backend, register users as they sign up, call `/consume` before each business action, and proceed only if `accepted`.

**Change what a user can do without touching code:** `PUT /users/alice/plan {"planId":"premium"}`, or `PATCH /plans/{id} {"maxPerRequest": 100}`. The next `/consume` uses the new limits; units already consumed this month are kept.

**Audit:** `GET /requests?userId=alice&accepted=false` lists every denial with the exact limits that applied then.
