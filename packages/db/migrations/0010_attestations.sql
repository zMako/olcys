-- OŁCyŚ schema, part 10: signed statements checked by someone else.

-- Set when a signature was not verified by this tool but is vouched for by the service that holds it (e.g. Keybase).
ALTER TABLE proofs ADD COLUMN attested_by text;
