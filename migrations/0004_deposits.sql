-- Each intent's deposit address (Cascabel's `CascabelDeposit`) and the settlement it commits to, as
-- JSON: anyone pays it with a plain transfer, and it can only send what it receives to the merchant.
ALTER TABLE payment_intents ADD COLUMN deposit_address TEXT;
ALTER TABLE payment_intents ADD COLUMN deposit_settlement TEXT;
-- What has reached the deposit, in atomic units of the intent's coin: less than `amount` is a partial
-- payment. When the intent ends unpaid, `underpaid_at` records when what arrived was swept to the
-- merchant anyway.
ALTER TABLE payment_intents ADD COLUMN amount_received TEXT;
ALTER TABLE payment_intents ADD COLUMN underpaid_at INTEGER;
CREATE UNIQUE INDEX payment_intents_by_deposit ON payment_intents (deposit_address);
