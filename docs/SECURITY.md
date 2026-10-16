# Security

What is protected, how, what was reviewed, and what is deliberately left to the deployment.

## Threat model in one paragraph
Many mutually untrusting applications ("accounts") share one service. Each holds a secret API key. The main risks are: one account reading or changing another's data; a stolen database or log leaking working keys; a malicious or buggy client breaking totals or crashing the service; and unbounded growth or load from one tenant. The service does not handle end users' identities, payments, or personal data.

## Controls
| Risk | Control | Where | Test |
|---|---|---|---|
| Cross-tenant access | The account id comes only from the API key. Every repository function takes it and filters on it. Another account's resource answers 404 (existence is not revealed). | `http/auth.ts`, `repositories/*` | `test/api.test.ts` "account isolation", `usage.test.ts` isolation, `consume.test.ts` "input and isolation" |
| Key theft from the database or backups | Only `sha256(key)` is stored; the key is 256 random bits and shown once. | `services/apiKeys.ts` | "stores only a hash" |
| Lost or leaked key | Rotation by the account; admin recovery endpoint; the old key stops working immediately. | `services/accounts.ts` | `api.test.ts`, `hardening.test.ts` |
| Minting accounts | `POST /accounts` needs the admin token (constant-time compare), is rate-limited per IP, and the service warns if the published demo token is in use. | `http/auth.ts`, `http/routes/accounts.ts`, `main.ts` | `hardening.test.ts` |
| SQL injection | Every statement is parameterized; the only interpolated text is a constant column list. | `repositories/*` | review |
| Malformed or hostile input | zod schemas on every route; strict character sets and lengths; no control characters (NUL); caps on numbers so values fit exactly in JS; body limit 100 KB; cursors validated; any leftover Postgres data error becomes 422, never 500. | `http/schemas.ts`, `http/errors.ts` | `hardening.test.ts` |
| Resource exhaustion | Page size capped at 200; 100 custom plans and 100,000 users per account; the per-account queue is bounded (503 when full); the connection pool is protected from hot tenants by the gate. | `services/*`, `accountGate.ts` | `hardening.test.ts`, `gate.test.ts`, [PERFORMANCE.md](PERFORMANCE.md) |
| Information leaks | One error shape; 500s say nothing about the cause (details only in the log); identical 401 for missing and invalid keys; secrets never logged. | `http/errors.ts` | review |
| Race conditions that overspend a quota | Row lock + decision on freshly read data; idempotent retries. | [CONCURRENCY.md](CONCURRENCY.md) | concurrency tests (they fail without the lock) |
| Browser-side attacks on the demo client | The key never reaches the browser; all dynamic text is HTML-escaped; POSTs need a JSON content type (forces a CORS preflight we never grant) and a same-origin `Origin`; body capped at 10 KB; `BIND_ADDR=127.0.0.1` keeps it local. | `client/server.ts`, `client/public/index.html` | review |
| Container hardening | Service and client run as a non-root user with a read-only filesystem, all capabilities dropped and `no-new-privileges`; Postgres is published on `127.0.0.1` only; the service and demo client ports follow `BIND_ADDR` (default all interfaces so one-command start works everywhere; set `BIND_ADDR=127.0.0.1` to keep them local). | `docker-compose.yml`, Dockerfiles | `docker compose up` works under these settings |
| Response hardening | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. | `http/app.ts` | `hardening.test.ts` |
| Docs exposure | Swagger UI and `/docs/json` can be turned off with `DOCS_ENABLED=false`. | `http/app.ts` | `hardening.test.ts` |

## Reviews performed
Two independent, read-only reviews of the finished code, run as separate agents, followed by fixes with a test for each:
1. **Security audit** (authentication, tenant isolation on every route and query, injection, secrets, validation and DoS, error leaks, replay abuse, Docker/config, the demo client, dependencies). Result: no Critical or High findings; tenant isolation verified on every route and repository function. Two Medium and five Low findings, all addressed (see below), plus three Info items.
2. **Five-axis code review** (correctness, readability, architecture, security, performance). No Blocker; the locking algorithm was confirmed sound. Findings fixed: history ordering used the transaction start time; the month was read before queueing; usage responses could mix instants; a few inputs produced 500; the pool had no error listener; a test helper could not detect an overspend; docs that contradicted code.

| Finding | Resolution |
|---|---|
| Demo admin token is published and live | Startup warning when the demo value is used; `BIND_ADDR=127.0.0.1` keeps the ports local; documented in ASSUMPTIONS #33. The one-command start required by the brief is kept, so this is mitigated and documented rather than removed. |
| Demo client was an unauthenticated, cross-origin-callable admin proxy | Content-type and Origin checks, body cap, serialized reset, localhost binding |
| Malformed cursor -> 500; NUL / year 0 / odd strings -> 500 | Strict schemas and cursor validation; class-22 safety net returns 422 |
| No throttling of admin token guesses | Per-IP rate limit; the check runs after the limiter so wrong guesses count |
| Unbounded rows and queue per account | Caps and a bounded queue |
| No admin path to recover a lost key | `POST /accounts/{id}/api-key/rotate` |
| Docs UI and container hardening | `DOCS_ENABLED`, security headers, read-only/cap-drop/no-new-privileges, non-root load-test image |
| Moderate advisory in the load-test tool's `uuid` | Accepted and recorded: not in the service image, not reachable as used |

## Left to the deployment (not solved in code)
TLS and HSTS (put a reverse proxy in front), general API rate limiting, secret management for `ADMIN_TOKEN` and the database password (the Compose values are demo defaults), backups, and monitoring. See [LIMITATIONS.md](LIMITATIONS.md).
