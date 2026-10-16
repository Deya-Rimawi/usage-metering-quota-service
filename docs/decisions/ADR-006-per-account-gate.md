# ADR-006: A per-account in-process gate against pool starvation

**Status:** accepted

## Context
Consumption for one account is serialized by a row lock in the database (ADR-005). Without anything else, every request for a hot account checks out a pooled database connection and then waits on that lock. A few busy accounts can hold the entire pool (20 connections), so quiet accounts wait for a connection. Measured: 16 quiet connections dropped from about 1,640 req/s (p50 9 ms) to about 124 req/s (p50 123 ms) beside one hot account.

## Decision
`services/accountGate.ts`: before taking a connection, a consume waits in a small in-memory queue per account; at most `ACCOUNT_CONCURRENCY` (default **1**) run at a time per account per process. Waiting costs memory, not a database connection.

## Why 1
A sweep of 1, 2, 4 and 8 (`loadtest/sweep.sh`) found no benefit above 1 within the noise and a worse result at 8. 1 also matches the database lock, so it is the easiest to explain.

## Not the correctness mechanism
The database lock stays authoritative. With several service instances each has its own gate, and totals remain exact; tests build two app instances over one database and race requests across both, and they fail if the database lock is removed. The gate only decides *where* requests wait.

## Consequences
- Quiet tenants stay at about 1,400 req/s beside a hot one (was 124).
- A hot account is unchanged (about 250 req/s) but its tail latency is better (p99 555 -> 315 ms).
- Cost: on uncontended traffic p99 roughly doubles (about 50 -> 100 ms) because same-account requests no longer overlap round trips.
- Queue length is bounded only by open client connections; there is no timeout or load shedding (see LIMITATIONS.md).
- The gate is per process, so N instances allow up to N concurrent consumes for one account (still bounded and fair).
