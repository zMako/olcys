-- OŁCyŚ schema, part 1: cases, runs, evidence vault, documents, address mentions.

CREATE TABLE cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- What the analyst entered. Leads found during a run live in run_identifiers.
CREATE TABLE case_identifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  value       text NOT NULL,
  normalized  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, kind, normalized)
);

-- One execution of the analysis. A case has many runs (recurring analyses), which can be compared.
CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  trigger         text NOT NULL DEFAULT 'manual',          -- manual | schedule
  status          text NOT NULL DEFAULT 'running',         -- running | completed | failed
  engine_version  text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,      -- search parameters, connectors used
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX runs_case_idx ON runs (case_id, started_at);

CREATE TABLE run_identifiers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind                    text NOT NULL,
  value                   text NOT NULL,
  normalized              text NOT NULL,
  origin                  text NOT NULL,                   -- seed | discovered
  depth                   integer NOT NULL DEFAULT 0,
  discovered_in_document  uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind, normalized)
);

-- Evidence vault. Bodies are stored once per content hash; unchanged pages cost nothing on reruns.
CREATE TABLE blobs (
  sha256      text PRIMARY KEY,
  size        integer NOT NULL,
  body        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every fetched resource exactly as received, hash-chained within its run.
CREATE TABLE snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  connector_id     text NOT NULL,
  url              text NOT NULL,
  http_status      integer NOT NULL,
  content_type     text NOT NULL,
  sha256           text NOT NULL REFERENCES blobs(sha256),
  fetched_at       text NOT NULL,                          -- ISO-8601 exactly as hashed
  prev_chain_hash  text NOT NULL,
  chain_hash       text NOT NULL,
  UNIQUE (run_id, seq)
);

-- Every outbound request the engine attempted, allowed or not.
CREATE TABLE egress_log (
  id            bigserial PRIMARY KEY,
  run_id        uuid REFERENCES runs(id) ON DELETE CASCADE,
  connector_id  text NOT NULL,
  url           text NOT NULL,
  host          text NOT NULL,
  allowed       boolean NOT NULL,
  http_status   integer,
  note          text,
  at            timestamptz NOT NULL DEFAULT now()
);

-- One attributable unit of content (profile, single post, ad) parsed from a snapshot.
CREATE TABLE documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  snapshot_id          uuid NOT NULL REFERENCES snapshots(id),
  connector_id         text NOT NULL,
  origin               text NOT NULL,                      -- independence group of the source
  resource_id          text NOT NULL,
  url                  text NOT NULL,
  doc_type             text NOT NULL,
  title                text,
  author_handle        text,
  author_display_name  text,
  author_profile_url   text,
  published_at         text,
  container            jsonb,
  relation             text NOT NULL,                      -- profile_owner | author | mention
  matched_identifier   jsonb NOT NULL,
  segments             jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, connector_id, resource_id)
);

CREATE TABLE address_mentions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chain          text NOT NULL,
  address        text NOT NULL,
  address_type   text NOT NULL,
  checksum       text NOT NULL,                            -- valid | absent
  raw            text NOT NULL,
  method         text NOT NULL,                            -- plain | deobfuscated | joined
  obfuscation    jsonb NOT NULL DEFAULT '[]'::jsonb,
  segment_index  integer NOT NULL,
  segment_kind   text NOT NULL,
  quoted_author  text,
  start_offset   integer NOT NULL,
  end_offset     integer NOT NULL,
  context        text NOT NULL
);
CREATE INDEX address_mentions_run_idx ON address_mentions (run_id, address);
