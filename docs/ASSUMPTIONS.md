# Product assumptions

The brief leaves some behaviour open. Each choice below is deliberate, applied consistently, and covered by tests where it affects behaviour.

| # | Topic | Decision | Reasoning |
|---|---|---|---|
| 1 | Creating accounts | `POST /accounts` requires an `X-Admin-Token` (env `ADMIN_TOKEN`). Everything else uses the account's `X-API-Key`. | The brief says accounts get a key when created but not who may create one. Open creation lets anyone mint accounts. |
| 2 | User identifiers | Callers address users by their own id (`userId`, 1-200 chars of `A-Za-z0-9._:@-`). It is unique per account; two accounts may reuse the same id. | The caller already has this id, so it needs no mapping table. The restricted charset keeps it safe in URLs. The internal uuid never leaves the service. |
| 3 | Unlimited | A plan limit of `null` means no limit for that rule. Limits are integers from 1 up to 1e12 (monthly) and 1e9 (per request). | Lets a plan use only one rule. The caps keep every BIGINT inside a JS number, so no precision loss. |
| 4 | Default plans | A new account gets `starter`; a new user gets `basic`, unless specified. | Every account and user must always have a plan, or the two-plan rule has nothing to apply. |
| 5 | Plan kinds | An *account* plan can only go on an account and a *user* plan only on a user. The database enforces this with composite foreign keys. | Prevents a mix-up that would silently apply the wrong limits. |
| 6 | Plan visibility | An account sees predefined plans plus its own. Another account's plan answers 404, never 403. | Does not reveal that a resource exists in a different account. |
| 7 | Predefined plans | Read-only: `PATCH` returns 403 `predefined_plan_read_only`. | Allowed by the brief. Keeps the documented example limits trustworthy. |
| 8 | Plan names | Unique per owner, case-insensitive. An account may reuse a predefined name for its own plan. | Avoids confusing duplicates inside one account. |
| 9 | Plan deletion | Not supported. | Deleting an assigned plan would orphan users; out of scope. Edit it or reassign users instead. |
| 10 | Not-found vs. invalid | Unknown id gives 404. Wrong kind of plan gives 422 `wrong_plan_kind`. Bad input gives 422 `validation_error`. | Distinct, predictable error codes. |
| 11 | Key rotation | `POST /account/api-key/rotate` returns a new key and invalidates the old one immediately. | A lost or leaked key needs a recovery path. Small addition, high value. |
| 12 | Key storage | Only the SHA-256 hash is stored. The key is shown once. | A database leak does not leak working keys. |

Decisions about consumption (rule order, retries, rejected requests, month rollover) are added to this table when that feature lands.
