-- OŁCyŚ schema, part 6: publicly stated amounts and the transfers they correspond to.

-- Amounts found in documents: the asking price of an ad, a crypto amount mentioned in a post.
CREATE TABLE stated_amounts (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  value        double precision NOT NULL,
  unit         text NOT NULL,
  raw          text NOT NULL,
  kind         text NOT NULL                               -- price | text
);
CREATE INDEX stated_amounts_run_idx ON stated_amounts (run_id);

-- Stated amounts matched to transfers on the subject's addresses.
CREATE TABLE amount_matches (
  run_id   uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  matches  jsonb NOT NULL
);
