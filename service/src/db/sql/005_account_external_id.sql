-- Idempotent account creation: the caller's own id for the customer (for example PagePilot's customer id).
-- Creating an account twice with the same external_id returns the existing account instead of a duplicate.
ALTER TABLE accounts ADD COLUMN external_id text CHECK (length(external_id) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX accounts_external_id_key ON accounts (external_id) WHERE external_id IS NOT NULL;
