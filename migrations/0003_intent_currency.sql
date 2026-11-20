-- The coin an intent is priced in: USDC (paid from any network, received on the home one), or
-- another coin of Flow's networks such as AUSD, paid and received on its own network.
ALTER TABLE payment_intents ADD COLUMN currency TEXT NOT NULL DEFAULT 'USDC';
