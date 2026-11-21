-- OŁCyŚ schema, part 4: wallets, exchange exit points and the PLN estimate.

-- Addresses tied on chain to the one found in open sources, and the exchange addresses the wallet paid into.
ALTER TABLE chain_activity ADD COLUMN wallet jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chain_activity ADD COLUMN off_ramps jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Estimated value in złoty of crypto sent to cash-out services, with every figure it was computed from.
CREATE TABLE run_estimates (
  run_id      uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  estimate    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
