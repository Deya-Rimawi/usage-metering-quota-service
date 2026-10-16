# ADR-001: Modular monolith with a pure domain core

**Status:** accepted

## Context
The brief allows one service and one database. The hard part of this system is correctness under concurrency, not scale-out.

## Decision
One Fastify service, layered `http → services → repositories`, plus a `domain/` folder that is pure (no I/O). Rule evaluation ("which limit rejected this request?") lives in `domain/rules.ts` as a pure function.

## Consequences
- Rules are unit-testable without a database and are the one file to read to understand a decision.
- SQL lives only in `repositories/`, so locking behaviour is easy to audit.
- No network hops between components, so no partial-failure modes beyond the DB itself.
- Trade-off: the service is a single deployable; horizontal scaling means running more copies against the same DB (supported, since all state lives in Postgres).
