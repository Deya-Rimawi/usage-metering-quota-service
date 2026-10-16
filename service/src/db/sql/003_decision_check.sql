-- With `accepted` NOT NULL (002) the "accepted IS NULL" branch of the outcome CHECK is dead. Replace it.
ALTER TABLE requests DROP CONSTRAINT requests_check;
ALTER TABLE requests ADD CONSTRAINT requests_outcome_consistent CHECK (
  (accepted AND rejected_rule IS NULL AND rejected_level IS NULL)
  OR (NOT accepted AND rejected_rule IS NOT NULL AND rejected_level IS NOT NULL));
