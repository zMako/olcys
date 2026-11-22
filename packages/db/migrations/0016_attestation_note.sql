-- OŁCyŚ schema, part 16: what an attestation says, in plain words.

-- Attestations now come from several issuers (exchanges, identity services, event organisers), each meaning
-- something different. The source that knows the meaning writes it down once; the rest of the tool quotes it.
ALTER TABLE address_attestations ADD COLUMN note text;
