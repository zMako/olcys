-- OŁCyŚ schema, part 14: which network a transfer happened on.

-- Ethereum addresses also live on networks built on top of Ethereum (Base and others). A transfer made there has
-- its own explorer and its own history, so the record says where it happened. Empty means the main network.
ALTER TABLE chain_transfers ADD COLUMN network text;
