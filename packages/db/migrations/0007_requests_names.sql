-- OŁCyŚ schema, part 7: requests with a body (node RPC calls) and on-chain names.

-- What was asked, for sources queried with a request body (e.g. JSON-RPC). Needed to repeat the request.
ALTER TABLE snapshots ADD COLUMN request_body text;

-- Names bound to addresses on chain (e.g. ENS) and the records their owners attached to them.
CREATE TABLE name_records (
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chain    text NOT NULL,
  address  text NOT NULL,
  record   jsonb NOT NULL,
  PRIMARY KEY (run_id, chain, address)
);
