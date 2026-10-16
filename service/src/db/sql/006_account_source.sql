-- How an account came to exist, so self-service signups can be counted and capped separately from
-- accounts an operator created.
ALTER TABLE accounts ADD COLUMN source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'self_service'));
