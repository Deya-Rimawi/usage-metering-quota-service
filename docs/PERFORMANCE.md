# Performance

**Short version.** One account can be decided at about **250-300 requests/s** (the price of exact, serialized totals); many accounts together reach about **1,600 requests/s** on a laptop. I found and fixed three real problems by measuring (planning time inside the lock, round trips, and one hot tenant starving everyone else), and found that about **60% of a hot account's time is the commit's disk flush**. In every one of about 1.2 million recorded requests the correctness invariants held.

## 1. Environment
| | |
|---|---|
| Machine | Laptop under WSL2 + Docker Desktop, 20 logical CPUs, 7.6 GB RAM visible to Docker |
| Software | Node 22 (service), PostgreSQL 16 (default config, `fsync` and `synchronous_commit` on), autocannon (load generator) |
| Topology | `loadtest`, `service` and `db` containers on one Compose network; **all three share the same CPUs** |
| Pool | 20 database connections for the service (`PG_POOL_MAX`) |

Because the generator, service and database share a machine, treat numbers as **relative** (before/after, which scenario is slower) rather than production capacity. Run-to-run noise is about **±10%**; the tables use the median of three 15-second runs.

## 2. Method
**Tool:** `loadtest/` (autocannon + a verifier). Each scenario seeds fresh accounts through the public API, fires `POST /consume` (and other calls) from 64 connections, samples what database sessions are waiting on ten times a second, then **verifies the invariants from the database**: every counter equals the sum of accepted units in the request log (I1), account usage equals the sum of its users (I5), no request is left without a decision, and where the allowance is known the accepted total equals it exactly. A run whose invariants fail is reported as failed whatever its speed.

| Scenario | What it stresses |
|---|---|
| `spread` | 50 accounts x 20 users, nothing rejected: raw throughput when accounts do not contend |
| `hot` | 1 account, 200 users: every request contends for the same account counter (worst case) |
| `hot-limited` | 1 account with a 5,000-unit allowance and 5-unit requests: mostly rejections; accepted total must be exactly 5,000 |
| `retry-storm` | every `requestId` sent twice almost simultaneously; each must count once |
| `plan-edits` | the user plan is edited every 50 ms during the run |
| `mixed-reads` | 70% consume, 10% each of `/usage`, `/requests`, `/users/{id}/limits` on a hot account |
| `noisy-neighbor` | 20 quiet accounts (reported) beside one hot account hammering with 48 connections |

**Reading latency.** When the system is saturated, latency is simply `connections / throughput` (Little's law): 64 connections at 250 req/s is about 256 ms *whatever the code does*. So compare **throughput and tail latency**, not p50, in saturated scenarios.

## 3. Results: first version vs final
Baseline = the first implementation (ADR-004, commit `60e3e91`: about 10 round trips, two locks). Final = lock-first (ADR-005) + prepared statements + per-account gate (ADR-006).

| Scenario | Baseline req/s | Final req/s | Baseline p99 | Final p99 |
|---|---:|---:|---:|---:|
| spread | 1,073 | **1,560** (+45%) | 82 ms | 102 ms |
| hot | 252 | 250 (flat) | 555 ms | **315 ms** |
| hot-limited | 210 | **253** (+20%) | 410 ms | **305 ms** |
| retry-storm | 1,284 | 1,232 (-4%) | 65 ms | 134 ms |
| plan-edits | 243 | 220 (-9%) | 502 ms | **400 ms** |
| mixed-reads | 342 | 311 (-9%) | 378 ms | 374 ms |
| noisy-neighbor (quiet tenants) | n/m* | **1,375** | n/m* | **29 ms** |

\* The scenario did not exist for the baseline. Without the gate (version 3 below) the quiet tenants got **124 req/s with p50 123 ms**; with no hot neighbour at all they get about 1,640 req/s with p50 9 ms.

All runs: zero HTTP errors, invariants held. **Honest reading:** uncontended throughput is up 45%, the hot account's *tail* latency is much better, and a hot tenant can no longer ruin the others. But the final version is not faster in every cell: a few contended scenarios are 4-9% lower (within noise) and the uncontended p99 is higher. Section 5 explains the trade.

## 4. How it got there (each step measured)
| Version | Change | spread | hot | noisy-neighbor (quiet) |
|---|---|---:|---:|---:|
| 1 baseline | ~10 round trips, user lock + account lock | 1,073 | 252 | n/m |
| 2 lock-first | one lock, 5 round trips (ADR-005) | **1,561** | **212 (worse!)** | n/m |
| 3 + prepared statements | named statements, no re-planning | 1,767 | 286 | 124 |
| 4 + per-account gate (limit 1) | hot tenant waits in memory, not in the pool (ADR-006) | 1,603 | 255 | **1,421** |
| 5 final (re-run, same code) | | 1,560 | 250 | 1,375 |

**Version 2 made the hot account slower**, the opposite of the goal. `EXPLAIN (ANALYZE)` of its main read statement showed **planning 4.3 ms, execution 0.26 ms**. Planning happened inside the lock window, so every queued request waited behind it. Naming the statements (prepared once per connection) removed that, and the hot account went from 212 to 286 req/s.

## 5. Bottleneck analysis
**5.1 Hot account: the lock.** Wait sampling on the baseline showed about 18 of 20 database sessions waiting on locks (`Lock:tuple` 14.5, `Lock:transactionid` 3.7) and under one doing work; CPU was idle (service about 33% of one core, Postgres about 61%). The ceiling is **how long one transaction holds the account lock**, about 4 ms, hence 250-300 req/s. That is inherent to serializing a counter, and it is the cost of exact totals.

**5.2 What the lock hold time is made of.** Turning `synchronous_commit` off for one experiment (never shipped, it can lose acknowledged commits) moved the hot account from about 250 to **about 620 req/s**. So roughly **60% of the lock window is the commit's disk flush**; the rest is round trips and statement execution. Group commit does not help because the next decision for the same account cannot start until the previous commit releases the lock.

**5.3 Uncontended traffic: round trips and the app.** With many accounts, sessions mostly wait on `Client:ClientRead`: Postgres is waiting for the Node process to send the next statement. Cutting round trips from about 10 to 5 gave the +45%.

**5.4 Noisy neighbour: pool starvation.** The hot account's requests each checked out a pooled connection and sat waiting on the lock, using up the pool; quiet tenants then waited for a connection. 16 quiet connections fell from about 1,640 to **124 req/s** (p50 9 -> 123 ms). A per-account in-process gate keeps the hot tenant's waiting in memory: quiet tenants back to about 1,400, the hot account itself unchanged. (ADR-006)

## 6. What did not help
- **More concurrency per account.** A sweep of `ACCOUNT_CONCURRENCY` = 1, 2, 4, 8 (`loadtest/sweep.sh`) showed no gain from 1 to 4 (differences inside the noise) and a worse result at 8 (spread 1,157 req/s, p99 141 ms). Default stays 1: simplest to explain and best or equal everywhere.
- **The gate has a cost.** On uncontended traffic it roughly doubles p99 (about 50 -> 100 ms) because two requests for the same account can no longer overlap their round trips. I judged fairness between tenants worth more than that tail.
- **First attempt at `hot-limited`** failed my own check: with 50,000 allowance the test never sent enough traffic to reach it (the service was right, my scenario was mis-sized). I resized it and also fixed a verifier bug (a `sum()` returned as a string). Recorded here because the failed runs are in the history.

## 7. What I would do next (not built, with evidence)
1. **Micro-batch an account's pending decisions into one transaction.** One lock acquisition and one commit flush shared by several requests. Section 5.2 says the flush is about 60% of the hot path, so a batch of 4 could raise one account's ceiling by about 2-3x while keeping full durability and exact, in-order decisions. It needs per-request error isolation inside the batch, which is why I left it as a documented next step.
2. **Shard the counter** if a single account must exceed that: complicates "exactly at the limit".
3. Re-run on dedicated hardware, separating the load generator, service and database.

## 8. Reproduce
```bash
cp .env.example .env
docker compose up -d --build                                       # db + service + client
docker compose --profile tools run --rm --build loadtest all --label mine          # all scenarios, 3 x 15 s each, ~6 min
docker compose --profile tools run --rm loadtest hot --duration 10 --runs 1 --label quick   # a single scenario
bash loadtest/sweep.sh && node loadtest/summarize.ts sweep-c      # the concurrency sweep
```
Needs only Docker. Results are written to `loadtest/results/<label>.json` (raw per-run numbers including the wait-event samples); the files from the runs quoted here are committed. Exit code is non-zero if any invariant fails. Options: `--duration`, `--connections`, `--runs`, `--label`.
