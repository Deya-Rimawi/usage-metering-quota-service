# ADR-007: An extra rule: the daily allowance

**Status:** accepted

## Context
The brief requires two rule types (monthly allowance, maximum per request) and says additional rules are optional: *"Explain how any additional rules interact with account and user plans, and demonstrate their behavior."* A reliable core matters more than extras, so the extra rule had to be small, fit the existing design without weakening it, and be fully verified.

## Decision
Add a **daily allowance**: the total units available in a UTC calendar day, in both account and user plans (`null` = unlimited), next to the monthly allowance and the per-request maximum.

It was chosen over a per-minute rate limit because it reuses the existing machinery unchanged in kind: a running total per owner and period, decided under the same lock. A per-minute limit would need many short-lived counter rows and extra writes on every request.

## How it interacts with the account and user plans
- **Same rule as everything else: all must pass.** A request must satisfy the user's daily allowance *and* the account's daily allowance, in addition to the four existing checks. Six checks in total.
- **Shared at account level, separate per user**, exactly like the monthly allowance: the account's usage today is the sum of its users' usage today; users sharing a plan do not share their individual daily allowance; a larger user allowance never raises the account's.
- **Fixed evaluation order**, shortest window first: user per-request, account per-request, user daily, account daily, user monthly, account monthly. The first broken rule is reported (`rule: "daily_allowance"`, `level`); all broken rules are listed in `violations`.
- **No required relation to the monthly allowance.** A daily allowance larger than the monthly one is harmless (the monthly rule still binds); a daily one smaller binds first on the day. It is not validated against the monthly one, because plans can be edited independently at any time.
- **Plan changes behave as for the monthly rule**: edits and switches apply to the next request; units already used today are kept (counters are keyed by owner and day, not by plan); a daily allowance cut below today's usage shows 0 remaining today and rejects until it is raised or the next UTC day starts; history keeps the limits that applied.
- **Days and months are taken from the same instant**, the moment the request holds the lock, so a request that queues across midnight is charged to the new day (and to the new month on the 1st).

## Implementation
- `plans.daily_allowance`, and two counter tables `account_daily_usage` / `user_daily_usage` keyed by (owner, UTC day) (migration 004, which also backfills the counters from existing history). `requests.day` records the day each decision was charged to, so the counters can be re-derived from the log.
- `domain/rules.ts`: one more rule name and two more entries in the evaluation order; the function is still pure.
- The consume transaction is unchanged in shape: the same single account lock serializes everything. The read statement also fetches today's usage; the write statement now updates four counters instead of two. No new lock was added, because every writer of any counter, daily or monthly, still holds the account's monthly row first (invariant I6).
- Responses add `dailyAllowance`, `usedToday` and `remainingToday` next to the monthly numbers. For past months they are `null` (they describe today). Decisions stored before the rule existed read back with `null` daily fields.
- Predefined plans got example daily limits: Starter 2,000, Pro 100,000, Basic 100, Premium 1,000.

## Demonstration
The demo scenario caps the account at 150 units per day when 135 have been used today: bob's 20-unit request is rejected by the **account's daily allowance** although his plan and the monthly allowance have plenty left; lifting the cap makes the same request succeed, with no client change.

## Verification
- Unit truth table for the six-rule order, boundaries, `null`, and cut-below-usage.
- Integration tests: user and account daily rejection, midnight reset while the month keeps counting, switch and edit semantics, retry on a later day, queue across midnight, API shapes, legacy decisions.
- Concurrency across two service instances (exactly the allowance is accepted) and the invariants I1, I2, I5 re-checked per day from the database after each.
- Mutation checks (rule not evaluated, user daily counter not written, monthly usage mistaken for today's) each make tests fail.
- Load tests re-run, including a scenario that must accept *exactly* the daily allowance: see [PERFORMANCE.md](../PERFORMANCE.md).

## Consequences
- The write statement does two more counter upserts. Measured: no change beyond run-to-run noise, all invariants (including the daily ones) hold in every load scenario, and a dedicated scenario accepts exactly the daily allowance ([PERFORMANCE.md](../PERFORMANCE.md), section 3b).
- Days are UTC-only; there is no per-account time zone (see LIMITATIONS.md).
- Adding a fourth rule later follows the same recipe: a plan column, a counter if it needs one, one entry in `ORDER`.
