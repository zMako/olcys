-- OŁCyŚ schema, part 13: who did what, and when.

-- Every action taken in the tool, by a person or by the schedule. Entries are chained by hash: each one covers
-- the one before it, so an entry cannot be removed or altered without breaking every hash after it.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         text NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  case_id    uuid,
  run_id     uuid,
  detail     jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE INDEX audit_case_idx ON audit_log (case_id, id);
