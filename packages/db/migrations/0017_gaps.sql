-- OŁCyŚ schema, part 17: what a run could not read.

-- A source that refused, timed out or answered with an error leaves a hole in the result. Each such hole is
-- written down, so a result built on incomplete data says so instead of looking complete.
CREATE TABLE run_gaps (
  id      bigserial PRIMARY KEY,
  run_id  uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source  text NOT NULL,
  message text NOT NULL,
  at      text NOT NULL
);
CREATE INDEX run_gaps_run_idx ON run_gaps (run_id, id);
