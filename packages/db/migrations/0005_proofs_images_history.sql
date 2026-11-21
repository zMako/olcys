-- OŁCyŚ schema, part 5: addresses read from images, signed-message proofs, profile history.

-- Where a mention was read from when it was not the page text itself (e.g. a photo with a QR code).
ALTER TABLE address_mentions ADD COLUMN source_url text;
ALTER TABLE address_mentions ADD COLUMN source_snapshot_id uuid;

-- Signed messages found in documents and the outcome of verifying each.
CREATE TABLE proofs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chain        text NOT NULL,
  address      text NOT NULL,
  message      text NOT NULL,
  signature    text NOT NULL,
  valid        boolean NOT NULL,
  reason       text
);
CREATE INDEX proofs_run_idx ON proofs (run_id, address);

-- How the subject's profiles changed over time (from archived versions).
ALTER TABLE assessments ADD COLUMN histories jsonb NOT NULL DEFAULT '[]'::jsonb;
