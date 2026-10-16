-- Every request row is now written with its final decision in a single statement (see docs/CONCURRENCY.md),
-- so a row without a decision can no longer exist.
ALTER TABLE requests ALTER COLUMN accepted SET NOT NULL;
