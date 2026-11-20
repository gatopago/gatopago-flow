-- Each intent's deposit address (Cascabel's `CascabelDeposit`) and the settlement it commits to, as
-- JSON: anyone pays it with a plain transfer, and it can only send what it receives to the merchant.
ALTER TABLE payment_intents ADD COLUMN deposit_address TEXT;
ALTER TABLE payment_intents ADD COLUMN deposit_settlement TEXT;
CREATE UNIQUE INDEX payment_intents_by_deposit ON payment_intents (deposit_address);
