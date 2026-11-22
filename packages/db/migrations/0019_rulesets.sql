-- OŁCyŚ schema, part 19: the scoring rules as the analysts set them.

-- Every saved change of the rules is a new row: the newest one is in force, the earlier ones show what the rules
-- were when an older analysis was scored (each analysis records the version it used).
CREATE TABLE rulesets (
  id         bigserial PRIMARY KEY,
  version    text NOT NULL,
  body       jsonb NOT NULL,
  changes    jsonb NOT NULL,
  actor      text NOT NULL,
  created_at text NOT NULL
);
