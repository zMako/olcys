-- OŁCyŚ schema, part 2: identity leads, chain facts, scoring.

-- Leads published on each document (links to other profiles, e-mail, phone, name).
ALTER TABLE documents ADD COLUMN discovered jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Every time an identifier led to a document, including repeats. Used to tell which accounts are tied together.
CREATE TABLE document_hits (
  id                     bigserial PRIMARY KEY,
  run_id                 uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id            uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  identifier_kind        text NOT NULL,
  identifier_value       text NOT NULL,
  identifier_normalized  text NOT NULL,
  relation               text NOT NULL
);
CREATE INDEX document_hits_run_idx ON document_hits (run_id);

-- What the explorer said about an address (kind of account, labels, activity).
CREATE TABLE chain_accounts (
  run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chain         text NOT NULL,
  address       text NOT NULL,
  connector_id  text NOT NULL,
  info          jsonb NOT NULL,
  PRIMARY KEY (run_id, chain, address)
);

-- Value movements of the analysed addresses.
CREATE TABLE chain_transfers (
  id               bigserial PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  subject_address  text NOT NULL,
  chain            text NOT NULL,
  tx_hash          text NOT NULL,
  at               text NOT NULL,
  from_address     text NOT NULL,
  to_address       text NOT NULL,
  asset            text NOT NULL,
  amount           double precision NOT NULL,
  snapshot_id      uuid
);
CREATE INDEX chain_transfers_run_idx ON chain_transfers (run_id, subject_address, at);

-- Activity summary and cash-out indicators per analysed address.
CREATE TABLE chain_activity (
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chain       text NOT NULL,
  address     text NOT NULL,
  activity    jsonb NOT NULL,
  indicators  jsonb NOT NULL,
  PRIMARY KEY (run_id, chain, address)
);

-- One scoring of a run with one version of the rules. A run can be re-scored; nothing is overwritten.
CREATE TABLE assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ruleset_id       text NOT NULL,
  ruleset_version  text NOT NULL,
  ruleset          jsonb NOT NULL,                         -- the exact rules used, for replay
  clusters         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assessments_run_idx ON assessments (run_id, created_at);

-- Person-to-address link with its Confidence Score and the receipt explaining it.
CREATE TABLE links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position       integer NOT NULL,
  cluster_id     text NOT NULL,
  chain          text NOT NULL,
  address        text NOT NULL,
  status         text NOT NULL,                            -- attributed | excluded | not_attributable
  score          integer NOT NULL,
  band           text NOT NULL,
  detail         jsonb NOT NULL                            -- receipt, occurrences, other publishers
);
CREATE INDEX links_run_idx ON links (run_id, address);
