# ADR-002: `pg` with hand-written SQL, no ORM

**Status:** accepted

## Context
Correctness depends on exact statements: `SELECT ... FOR UPDATE`, `INSERT ... ON CONFLICT`, lock ordering, transaction scope.

## Decision
Use `pg` directly. Migrations are numbered `.sql` files applied once each under a Postgres advisory lock (`db/migrate.ts`).

## Consequences
- Every lock and statement is visible and explainable; nothing is generated behind the scenes.
- Slightly more boilerplate in repositories.
- Types are written by hand at the repository boundary.
- The schema (not application code) enforces invariants: foreign keys, CHECKs, and composite FKs that guarantee an *account* plan on accounts and a *user* plan on users.
