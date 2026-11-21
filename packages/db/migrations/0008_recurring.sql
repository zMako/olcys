-- OŁCyŚ schema, part 8: recurring analyses.

-- A case is identified by what was entered and where it is searched, so repeating an analysis adds a run to the same case.
ALTER TABLE cases ADD COLUMN fingerprint text;
ALTER TABLE cases ADD COLUMN sources text NOT NULL DEFAULT 'synthetic';
CREATE INDEX cases_fingerprint_idx ON cases (fingerprint);

-- How often a case is analysed again on its own.
CREATE TABLE case_schedules (
  case_id        uuid PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  every_seconds  integer NOT NULL,
  next_run_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
