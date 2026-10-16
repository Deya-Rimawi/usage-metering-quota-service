# Architecture decision records

One page per significant decision: the context, what was chosen, what was rejected and why, and the consequences. Later records supersede earlier ones where noted.

| # | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-architecture-style.md) | Modular monolith with a pure domain core | accepted |
| [ADR-002](ADR-002-raw-sql-no-orm.md) | `pg` with hand-written SQL, no ORM | accepted |
| [ADR-003](ADR-003-usage-counters.md) | Per-month counter rows updated under row locks | accepted |
| [ADR-004](ADR-004-locking-and-idempotency.md) | Two row locks in a fixed order, and an idempotency claim first | **superseded by ADR-005** (kept as the measured baseline) |
| [ADR-005](ADR-005-lock-first-consume.md) | One lock, taken first; read everything after it | accepted |
| [ADR-006](ADR-006-per-account-gate.md) | A per-account in-process gate against pool starvation | accepted |
| [ADR-007](ADR-007-daily-allowance.md) | The extra rule: a daily allowance | accepted |
| [ADR-008](ADR-008-optional-self-service-signup.md) | Optional self-service signup | accepted |

Related: [ASSUMPTIONS.md](../ASSUMPTIONS.md) (product decisions the brief left open), [PROVISIONING.md](../PROVISIONING.md) (who creates accounts).
