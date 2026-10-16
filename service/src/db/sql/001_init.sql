-- Usage metering schema. See docs/DATA_MODEL.md for the rationale behind each constraint.

CREATE TABLE plans (
  id                text PRIMARY KEY,
  account_id        uuid,                                   -- NULL = predefined (read-only) plan
  kind              text NOT NULL CHECK (kind IN ('account', 'user')),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  monthly_allowance bigint CHECK (monthly_allowance BETWEEN 1 AND 1000000000000),  -- NULL = unlimited
  max_per_request   bigint CHECK (max_per_request   BETWEEN 1 AND 1000000000),     -- NULL = unlimited
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, kind)                                         -- target of the composite FKs below
);
CREATE UNIQUE INDEX plans_name_per_owner ON plans (COALESCE(account_id::text, ''), lower(name));

CREATE TABLE accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  api_key_hash text NOT NULL UNIQUE,                        -- sha256 of the key; the key itself is never stored
  plan_id      text NOT NULL,
  plan_kind    text NOT NULL DEFAULT 'account' CHECK (plan_kind = 'account'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, plan_kind) REFERENCES plans (id, kind)  -- DB guarantees an ACCOUNT plan here
);
ALTER TABLE plans ADD FOREIGN KEY (account_id) REFERENCES accounts (id);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),  -- caller's own user identifier
  plan_id     text NOT NULL,
  plan_kind   text NOT NULL DEFAULT 'user' CHECK (plan_kind = 'user'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),
  FOREIGN KEY (plan_id, plan_kind) REFERENCES plans (id, kind)       -- DB guarantees a USER plan here
);

-- Usage counters: one row per (owner, UTC month). Plans are NOT part of the key, so
-- switching plans can never reset consumption.
CREATE TABLE account_usage (
  account_id uuid   NOT NULL REFERENCES accounts (id),
  period     date   NOT NULL CHECK (period = date_trunc('month', period)::date),
  units      bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (account_id, period)
);
CREATE TABLE user_usage (
  user_id uuid   NOT NULL REFERENCES users (id),
  period  date   NOT NULL CHECK (period = date_trunc('month', period)::date),
  units   bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (user_id, period)
);

-- Request log: the idempotency record, the audit trail, and the source of truth for the counters.
CREATE TABLE requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid   NOT NULL REFERENCES accounts (id),
  request_id     text   NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  user_id        uuid   NOT NULL REFERENCES users (id),
  units          bigint NOT NULL CHECK (units BETWEEN 1 AND 1000000000),
  period         date   NOT NULL,
  accepted       boolean,                                   -- NULL only inside the deciding transaction
  rejected_rule  text CHECK (rejected_rule IN ('max_per_request', 'monthly_allowance')),
  rejected_level text CHECK (rejected_level IN ('account', 'user')),
  violations     jsonb,                                     -- every rule that failed, primary first
  applied        jsonb,                                     -- snapshot of the limits used for this decision
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),                          -- idempotency key
  CHECK (accepted IS NULL
         OR (accepted AND rejected_rule IS NULL AND rejected_level IS NULL)
         OR (NOT accepted AND rejected_rule IS NOT NULL AND rejected_level IS NOT NULL))
);
CREATE INDEX requests_account_history ON requests (account_id, created_at DESC, id DESC);
CREATE INDEX requests_user_history    ON requests (user_id, created_at DESC, id DESC);
