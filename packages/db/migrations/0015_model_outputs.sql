-- OŁCyŚ schema, part 15: what the language model produced, and what was checked about it.

-- One row per piece of model output of a run: the grounded description of the case, the ranking of open leads,
-- an opinion on whether two accounts are one person, the reasoning of a request draft. The payload keeps both
-- what was accepted and what the checks rejected, so the model's work can be audited like everything else.
CREATE TABLE model_outputs (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  key        text NOT NULL DEFAULT '',
  model      text NOT NULL,
  payload    jsonb NOT NULL,
  created_at text NOT NULL,
  UNIQUE (run_id, kind, key)
);
