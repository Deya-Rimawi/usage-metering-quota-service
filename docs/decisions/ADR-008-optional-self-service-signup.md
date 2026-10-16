# ADR-008: Optional self-service signup

**Status:** accepted

## Context
The brief says accounts get an API key when created but not who may create them. The default (ADR in [PROVISIONING.md](../PROVISIONING.md)) is that only the operator, holding an admin token, creates accounts. In real API products a customer gets an account and a key themselves, with no operator and no key hand-off. Building a website with human login is out of scope in the brief, but the *service side* of that flow is small.

## Decision
A switch, `OPEN_SIGNUP` (default **off**). When on, `POST /accounts` also accepts requests with **no admin token**; the new account's key is returned directly in the response. With a valid admin token the behaviour is unchanged.

## What keeps it safe
| Risk | Control |
|---|---|
| Anyone filling the database with accounts | Strict per-IP rate limit for everyone without a valid admin token (`SIGNUP_RATE_LIMIT_PER_MIN`, default 10); a global cap on self-service accounts (`SIGNUP_MAX_ACCOUNTS`, default 10,000), exact even for simultaneous requests (a transaction-scoped advisory lock around count-then-insert). Operator-created accounts are neither limited by it nor counted. |
| Probing which customer ids exist | `externalId` (idempotent get-or-create) is **admin-only**. An anonymous request with one gets 403 and nothing about any existing account is returned. |
| Admin-token guessing | A token that is present but wrong is refused with 401, never silently treated as a signup, and counts against the strict limit. |
| Opening more than intended | Only account creation opens. Key recovery by an admin, every data route and the account's own routes keep their existing protection (tested). |
| Switching it on by accident | Off by default; the service logs a warning at startup when it is on. |

## Not done, on purpose
Email or phone verification, CAPTCHA and a human-facing signup page. Those belong to the website that fronts the service, which the brief puts out of scope; they are the real defence against determined abuse and are listed in LIMITATIONS.md. Plans are self-managed by accounts in this model (an account can create and assign its own plans), so there is nothing to restrict about the starting plan.

## Consequences
- The "get an API key" experience matches real products: call the endpoint, receive the key, start using it.
- A self-service account that loses its key has no recovery path except an operator's admin rotate (it can rotate its own key only while it still has a working one).
- Accounts remember how they were created (`accounts.source`), so self-service accounts can be counted and, if needed, reviewed or cleaned up separately.
