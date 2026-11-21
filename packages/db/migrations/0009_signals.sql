-- OŁCyŚ schema, part 9: profile fingerprints and contract deployments.

-- Hashes and key fingerprints a profile shows (avatar e-mail hash, public keys).
ALTER TABLE documents ADD COLUMN fingerprints jsonb NOT NULL DEFAULT '[]';

-- Which address created which contract, as reported by the explorer.
CREATE TABLE deployments (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chain        text NOT NULL,
  contract     text NOT NULL,
  creator      text NOT NULL,
  tx_hash      text,
  at           text,
  source_url   text,
  snapshot_id  uuid,
  UNIQUE (run_id, chain, contract)
);
