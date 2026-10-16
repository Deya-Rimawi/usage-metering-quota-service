-- Extra rule: daily allowance (units per UTC calendar day), in both account and user plans.
-- Counted exactly like the monthly allowance, in separate per-day counters; see docs/decisions/ADR-007.

ALTER TABLE plans ADD COLUMN daily_allowance bigint CHECK (daily_allowance BETWEEN 1 AND 1000000000000);  -- NULL = unlimited

CREATE TABLE account_daily_usage (
  account_id uuid   NOT NULL REFERENCES accounts (id),
  day        date   NOT NULL,
  units      bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (account_id, day)
);
CREATE TABLE user_daily_usage (
  user_id uuid   NOT NULL REFERENCES users (id),
  day     date   NOT NULL,
  units   bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (user_id, day)
);

-- Each decision records the UTC day it was charged to (needed to re-derive the daily counters from the log).
ALTER TABLE requests ADD COLUMN day date;
UPDATE requests SET day = (created_at AT TIME ZONE 'UTC')::date;
ALTER TABLE requests ALTER COLUMN day SET NOT NULL;

-- Existing history keeps the daily counters consistent with the log (invariant I1, per day).
INSERT INTO account_daily_usage (account_id, day, units) SELECT account_id, day, sum(units) FROM requests WHERE accepted GROUP BY 1, 2;
INSERT INTO user_daily_usage    (user_id,    day, units) SELECT user_id,    day, sum(units) FROM requests WHERE accepted GROUP BY 1, 2;

-- A rejection can now name the new rule.
ALTER TABLE requests DROP CONSTRAINT requests_rejected_rule_check;
ALTER TABLE requests ADD CONSTRAINT requests_rejected_rule_check
  CHECK (rejected_rule IN ('max_per_request', 'daily_allowance', 'monthly_allowance'));
