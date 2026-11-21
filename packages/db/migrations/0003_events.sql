-- OŁCyŚ schema, part 3: the step-by-step record of a run.
-- The interface replays it to show how the case was assembled; it also documents the analytical process.
CREATE TABLE run_events (
  id       bigserial PRIMARY KEY,
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq      integer NOT NULL,
  type     text NOT NULL,
  payload  jsonb NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
