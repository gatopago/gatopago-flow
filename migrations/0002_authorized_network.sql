-- The network an intent was last authorized on, and until when that authorization can be used.
-- Each network's router only knows its own payments: while one can still pay, another network is
-- refused, so an intent is never paid on two networks.
ALTER TABLE payment_intents ADD COLUMN authorized_network TEXT;
ALTER TABLE payment_intents ADD COLUMN authorized_until INTEGER;
