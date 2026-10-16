# Concepts behind this project, in plain language

Each section explains one idea, then points to the exact place it appears in the code. Read this before [WALKTHROUGH.md](WALKTHROUGH.md).

## 1. Transactions: "all or nothing"
A **transaction** groups several database statements so they either all happen or none do. If the server crashes halfway, the database undoes the partial work.
*Here:* consuming units changes the user counter, the account counter and the request log. They must agree, so they are written in one transaction (`withTx` in `repositories/db.ts`, used by `services/consume.ts`).

## 2. The race condition we must prevent
Two requests arrive at the same moment. Both read "95 of 100 used", both see room for 5, both add 5. Result: 105 of 100. This is a *check-then-act race*. The fix is to make the second request **wait** until the first finished.
*Here:* proven by the tests in `test/consume.test.ts` ("concurrency"), which fail if the lock is removed.

## 3. Row locks: `SELECT ... FOR UPDATE`
`SELECT ... FOR UPDATE` reads a row and **locks** it: other transactions that try to lock or change it wait until this transaction commits or rolls back. When they get their turn they read the *fresh* value.
*Here:* `lockAccount()` in `repositories/usage.ts`. The locked row is the account's counter for the month. Different accounts have different rows, so they never wait on each other.

## 4. Isolation levels and why snapshots matter
Each statement sees the database as of the moment it **started** (in PostgreSQL's default READ COMMITTED mode). A statement that waits for a lock does not magically see rows committed meanwhile, except the locked row itself.
*Here:* that is why the lock is its own statement and the data the decision depends on is read in the **next** statement (`readContext`). See [ADR-005](decisions/ADR-005-lock-first-consume.md).

## 5. Deadlocks
Request A holds lock 1 and wants lock 2; request B holds lock 2 and wants lock 1; both wait forever. The database detects it and kills one. The cure is to always take locks in the same order, or to need only one lock.
*Here:* v2 needs just one lock (the account counter), so a deadlock between consumes is impossible by construction.

## 6. Idempotency: safe retries
Networks fail. A client that never got a response will retry. An operation is **idempotent** if doing it twice has the same effect as once. The client sends a unique `requestId`; the service remembers the decision for that id and returns it again instead of counting again.
*Here:* the `UNIQUE (account_id, request_id)` index plus the stored decision in the `requests` table; the replay path is `replay()` in `services/consume.ts`. A different payload with the same id is a 409, because it is probably a client bug.

## 7. Pure functions and why the domain is separate
A **pure function** depends only on its inputs and does nothing else (no database, no clock, no network). It is easy to test exhaustively and easy to explain.
*Here:* `evaluate()` in `domain/rules.ts` takes limits and usage numbers and returns the broken rules. All database work is outside it.

## 8. Counters versus summing a log
We could recompute usage by adding up every accepted request each time. That gets slower as history grows. Instead we keep a **running total** per month (`account_usage`, `user_usage`) and keep the log for auditing. The log is also how we *verify* the totals (`brokenInvariants` in tests, `loadtest/verify.ts`).

## 9. Hashing API keys
We store `sha256(key)`, not the key. If the database leaks, the keys do not. Unlike passwords we use a fast hash: the key is 256 random bits, so it cannot be guessed, and we need to look it up on every request.
*Here:* `services/apiKeys.ts`, `repositories/accounts.ts` (`findByKeyHash`).

## 10. Tenant isolation
Many accounts share one database. Every query that reads or changes tenant data includes `account_id = <the authenticated account>`, and the account id comes from the API key, never from the request body.
*Here:* `http/auth.ts` sets `req.account`; repositories take `accountId` as the first argument. Someone else's resource answers 404, so existence is not revealed.

## 11. Keyset (cursor) pagination
`OFFSET 100` makes the database walk past 100 rows and shifts when new rows appear (you skip or repeat items). A **cursor** remembers the sort key of the last item you saw ("everything older than this") and stays correct while data changes.
*Here:* `http/pagination.ts`, `repositories/requests.ts` (`list`), tested in `test/usage.test.ts`.

## 12. Migrations
A migration is a numbered SQL file that moves the schema from one version to the next. The runner records which ones ran and takes a database-wide lock so two starting instances do not apply the same file twice.
*Here:* `db/migrate.ts`, `db/sql/001_init.sql`, `002_decision_not_null.sql`.

## 13. Percentiles and load testing
Averages hide pain. **p99 latency** = the time 99% of requests beat. A load test is only meaningful if the system is still *correct* afterwards, so every run re-checks the invariants against the database.
*Here:* `loadtest/` and [PERFORMANCE.md](PERFORMANCE.md).

## 14. Constraints in the database
`CHECK`, `UNIQUE` and foreign keys are rules the database itself enforces. Even a bug in the application cannot store a user plan on an account, a negative counter, or two decisions for one request id.
*Here:* [DATA_MODEL.md](DATA_MODEL.md).

## 15. Get-or-create and partial unique indexes
"Create this customer" called twice should not make two customers. The caller supplies its own id (`externalId`); a **unique index** guarantees at most one row per id, and `INSERT ... ON CONFLICT DO NOTHING` lets the database decide a race between simultaneous calls: one insert wins, the others get nothing back and read the existing row. The index is **partial** (`WHERE external_id IS NOT NULL`) so accounts without an id are unrestricted.
*Here:* `repositories/accounts.ts` (`insert`), `db/sql/005_account_external_id.sql`, tested with ten simultaneous creations in `test/api.test.ts`.

## 16. Advisory locks
A row lock protects a row. Sometimes you need a lock on an *idea* ("only one signup may check and bump the cap at a time"). Postgres **advisory locks** let you lock an arbitrary number for the length of a transaction. Use them sparingly: here only on the anonymous signup path, never on the hot consume path.
*Here:* `services/accounts.ts` (`signUp`), and the migration runner uses one too.

## 17. Rate limiting and trust levels
Not every caller deserves the same limits. The account-creation route gives a *generous* per-IP limit to a caller with the valid admin token and a *strict* one to everyone else (anonymous signups and anyone guessing the token). The limiter must run **before** the token check so guesses are counted.
*Here:* `http/routes/accounts.ts` (`rateLimit`), `http/auth.ts`.

