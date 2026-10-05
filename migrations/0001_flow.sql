-- GatoPago Flow: payment intents paid onchain through GatoPagoPaymentRouter.

-- A GatoPago user who gets paid; funds settle to their account on the home network.
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- Only the SHA-256 of each key is kept.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  key_hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  -- keccak256 of the id: how the router names the intent onchain.
  onchain_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  -- USDC atomic units the merchant receives.
  amount TEXT NOT NULL,
  description TEXT,
  metadata TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('requires_payment', 'processing', 'succeeded', 'canceled', 'expired')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  network TEXT,
  transaction_hash TEXT,
  payer TEXT,
  paid_at INTEGER,
  -- `Idempotency-Key` of the request that created it: a retry returns the same intent.
  idempotency_key TEXT,
  UNIQUE (merchant_id, idempotency_key)
) STRICT;
CREATE INDEX payment_intents_by_merchant ON payment_intents (merchant_id, created_at DESC);
CREATE INDEX payment_intents_by_status ON payment_intents (status, expires_at);

-- `secret` is encrypted with WEBHOOK_SECRET_KEY (AES-GCM).
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_by_merchant ON events (merchant_id, created_at DESC);

CREATE TABLE webhook_deliveries (
  event_id TEXT NOT NULL REFERENCES events (id),
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_status INTEGER,
  PRIMARY KEY (event_id, endpoint_id)
) STRICT;
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE delivered_at IS NULL;

-- Last block whose router events were read, per network.
CREATE TABLE chain_cursors (
  network TEXT PRIMARY KEY,
  block INTEGER NOT NULL
) STRICT;
