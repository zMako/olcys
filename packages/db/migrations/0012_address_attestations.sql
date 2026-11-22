-- OŁCyŚ schema, part 12: what an institution publicly attests about an address.

-- E.g. an exchange attesting on chain that the address belongs to its verified customer.
CREATE TABLE address_attestations (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chain       text NOT NULL,
  address     text NOT NULL,
  issuer      text NOT NULL,
  claim       text NOT NULL,
  value       text,
  uid         text NOT NULL,
  at          text,
  source_url  text,
  UNIQUE (run_id, uid)
);
