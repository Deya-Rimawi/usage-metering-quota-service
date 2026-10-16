# Known limitations and upgrade paths

Stated plainly, with what I would do about each. None of them break correctness; they are limits of scale, scope, or operations.

| # | Limitation | Why it exists | Upgrade path |
|---|---|---|---|
| 1 | **One account tops out around 250-300 consumes/s** (measured: [PERFORMANCE.md](PERFORMANCE.md)). | All consumption for an account is serialized by one row lock, which is what makes totals exact. Throughput is bounded by how long a transaction holds that lock. | Shard the monthly counter into N sub-rows per account and decide against their sum (harder near the exact limit); or batch decisions per account. Not needed for the brief. |
| 2 | **Different accounts scale only as far as one Postgres and one Node process allow** (about 1,600 req/s total on the test machine). | One service, one database, as the brief allows. The service is stateless, so more instances can be added. | Run several instances behind a load balancer (already safe: correctness is in the database), add a read replica for the usage and history endpoints, tune Postgres. |
| 3 | **The in-process per-account gate queues requests in memory.** Its size is bounded by open connections, but there is no timeout or load shedding. | It protects the connection pool from a hot tenant; it is a performance guard only. | Add a queue timeout that returns 503 + `Retry-After`; per-account rate limits at an edge proxy. |
| 4 | **The gate is per instance.** With N instances a hot account can hold up to N connections. | It cannot coordinate across processes without another dependency. | Acceptable (still bounded and fair across tenants); or move to a shared limiter if needed. |
| 5 | **Prepared statements are per connection**, which rules out PgBouncer in transaction-pooling mode. | The hot path uses named statements to avoid re-planning inside the lock (measured gain). | Use session pooling, or protocol-level prepared statement support in a newer pooler. |
| 6 | **API keys have no scopes, expiry, or multiple keys per account.** | Role-based permissions were out of scope. Rotation exists for lost or leaked keys. | Add a `api_keys` table (hash, label, scopes, expires_at, revoked_at). |
| 7 | **Account creation is gated by one shared admin token.** | The brief does not say who creates accounts. | Real admin auth, or self-service signup behind a separate system. |
| 8 | **History grows without bound** (`requests` is one row per decision). | Required for audit and idempotency. | Partition `requests` by month and archive old partitions; keep a retention window for idempotency lookups. |
| 9 | **A retry's replay shows balances as of the original decision**, not current ones. | The stored decision is returned verbatim so retries are exactly idempotent. | Read current balances from `/usage` or `/users/{id}/limits`. |
| 10 | **Plans cannot be deleted, users cannot be removed or moved between accounts.** | Out of scope; deleting would orphan history. | Soft-delete with a `deleted_at` column. |
| 11 | **Limits are capped** (monthly 1e12, per request 1e9, units 1e9). | Keeps every number exactly representable in JavaScript. | Return BIGINT as strings/`BigInt` end to end if larger values are ever needed. |
| 12 | **Usage reads are not locked**, so they can be a few milliseconds behind an in-flight request. | Reads must not slow the write path; decisions never depend on them. | None needed. |
| 13 | **No metrics endpoint or tracing**, only structured logs and health checks. | Time budget. | Add Prometheus metrics (decision counts by rule and level, lock wait, pool usage) and OpenTelemetry traces. |
| 14 | **Load results come from one laptop**, with the load generator, service and database sharing CPU, on Docker Desktop. | That is the available environment. Numbers show relative effects and bottlenecks, not production capacity. | Re-run `loadtest/` on dedicated hardware. |
| 15 | **No rate limiting on the API itself** (for example, on failed key attempts). | Keys are 256-bit random, so guessing is infeasible; abuse protection is normally an edge concern. | Add a rate limiter at the reverse proxy. |
