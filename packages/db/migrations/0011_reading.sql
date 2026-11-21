-- OŁCyŚ schema, part 11: what the person's own posts say.

-- One row per run: how many posts were read and how many were set aside as written by apps.
CREATE TABLE readings (
  run_id      uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  posts       integer NOT NULL,
  generated   integer NOT NULL,
  read        integer NOT NULL,
  model       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Posts in which the person seems to speak about their own crypto. `detail` is filled when the language model has read the post.
CREATE TABLE statements (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relevance    real NOT NULL,
  text         text NOT NULL,
  at           text,
  url          text,
  detail       jsonb,
  UNIQUE (run_id, document_id)
);

-- A description of the case written by the language model from the run's findings.
CREATE TABLE narratives (
  run_id      uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  model       text NOT NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
