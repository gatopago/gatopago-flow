-- Initial Flow schema. Fresh databases only.
-- Index creation order preserves the established SQLite query plans.
PRAGMA foreign_keys = ON;

CREATE TABLE merchants (
	id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL DEFAULT '',
	settlement_wallet TEXT NOT NULL,
	settlement_chain_id INTEGER NOT NULL,
	account_version INTEGER NOT NULL DEFAULT 1 CHECK (account_version >= 1),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE settlement_account_commands (
	command_id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	account_version INTEGER NOT NULL CHECK (account_version >= 1),
	settlement_wallet TEXT NOT NULL,
	settlement_chain_id INTEGER NOT NULL,
	applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE payment_intents (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	link_id TEXT,
	idempotency_key TEXT,
	amount_atomic TEXT NOT NULL,
	currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
	reference TEXT NOT NULL DEFAULT '',
	metadata TEXT NOT NULL DEFAULT '{}',
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	status TEXT NOT NULL DEFAULT 'awaiting_payment'
		CHECK (status IN ('awaiting_payment','processing','paid','overpaid','canceled','expired','failed')),
	settlement_wallet TEXT NOT NULL,
	settlement_chain_id INTEGER NOT NULL,
	settlement_account_version INTEGER NOT NULL,
	paid_amount_atomic TEXT NOT NULL DEFAULT '0',
	paid_tx_hash TEXT,
	paid_at TEXT,
	paid_by TEXT,
	expires_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL, amount_mode TEXT NOT NULL DEFAULT 'fixed'
	CHECK (amount_mode IN ('fixed', 'payer_defined')),
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE payment_quotes (
	id TEXT PRIMARY KEY,
	intent_id TEXT NOT NULL,
	payer TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	settlement_amount_atomic TEXT NOT NULL,
	platform_fee_atomic TEXT NOT NULL,
	cctp_fee_atomic TEXT NOT NULL DEFAULT '0',
	gross_payer_amount_atomic TEXT NOT NULL,
	fee_source TEXT NOT NULL CHECK (fee_source IN ('local','circle_live')),
	fee_observed_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	quote_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL, fee_policy_id TEXT NOT NULL DEFAULT 'free-default', fee_policy_version INTEGER NOT NULL DEFAULT 1
	CHECK (fee_policy_version >= 1), fee_rule_id TEXT NOT NULL DEFAULT 'free-default', platform_fee_bps INTEGER NOT NULL DEFAULT 0
	CHECK (platform_fee_bps BETWEEN 0 AND 100), platform_fee_bearer TEXT NOT NULL DEFAULT 'none'
	CHECK (platform_fee_bearer IN ('none','payer')), platform_fee_recipient TEXT
	CHECK (platform_fee_recipient IS NULL OR (
		length(platform_fee_recipient) = 42 AND substr(platform_fee_recipient, 1, 2) = '0x'
		AND substr(platform_fee_recipient, 3) NOT GLOB '*[^0-9a-fA-F]*')), route_fee_cap_bps INTEGER NOT NULL DEFAULT 0
	CHECK (route_fee_cap_bps BETWEEN 0 AND 100),
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE payment_attempts (
	id TEXT PRIMARY KEY,
	attempt_hash TEXT NOT NULL UNIQUE,
	intent_id TEXT NOT NULL,
	quote_id TEXT NOT NULL,
	payer_user_id TEXT,
	payer_address TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	status TEXT NOT NULL DEFAULT 'reserved'
		CHECK (status IN ('reserved','submitted','processing','paid','overpaid','failed','expired','canceled')),
	router_address TEXT NOT NULL,
	authorization_hash TEXT NOT NULL UNIQUE,
	authorization_json TEXT NOT NULL,
	signature TEXT NOT NULL,
	valid_after INTEGER NOT NULL,
	valid_until INTEGER NOT NULL,
	user_op_hash TEXT,
	source_tx_hash TEXT,
	destination_tx_hash TEXT,
	settlement_amount_atomic TEXT NOT NULL,
	settled_amount_atomic TEXT NOT NULL DEFAULT '0',
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL, platform_fee_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(platform_fee_atomic) BETWEEN 1 AND 78 AND platform_fee_atomic NOT GLOB '*[^0-9]*'), cctp_fee_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(cctp_fee_atomic) BETWEEN 1 AND 78 AND cctp_fee_atomic NOT GLOB '*[^0-9]*'), gross_payer_amount_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(gross_payer_amount_atomic) BETWEEN 1 AND 78 AND gross_payer_amount_atomic NOT GLOB '*[^0-9]*'), fee_policy_id TEXT NOT NULL DEFAULT 'free-default', fee_policy_version INTEGER NOT NULL DEFAULT 1
	CHECK (fee_policy_version >= 1), fee_rule_id TEXT NOT NULL DEFAULT 'free-default', platform_fee_bps INTEGER NOT NULL DEFAULT 0
	CHECK (platform_fee_bps BETWEEN 0 AND 100), platform_fee_bearer TEXT NOT NULL DEFAULT 'none'
	CHECK (platform_fee_bearer IN ('none','payer')), platform_fee_recipient TEXT
	CHECK (platform_fee_recipient IS NULL OR (
		length(platform_fee_recipient) = 42 AND substr(platform_fee_recipient, 1, 2) = '0x'
		AND substr(platform_fee_recipient, 3) NOT GLOB '*[^0-9a-fA-F]*')), route_fee_cap_bps INTEGER NOT NULL DEFAULT 0
	CHECK (route_fee_cap_bps BETWEEN 0 AND 100), checkout_capability_hash TEXT, payer_proof_signature TEXT, payer_proof_message_hash TEXT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT,
	FOREIGN KEY (quote_id) REFERENCES payment_quotes(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE wallet_execution_commands (
	command_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL,
	user_op_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE crosschain_operations (
	op_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE,
	source_chain_id INTEGER NOT NULL,
	destination_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('cctp_fast','cctp_standard')),
	status TEXT NOT NULL DEFAULT 'awaiting_burn'
		CHECK (status IN ('awaiting_burn','burned','attesting','minting','settled','failed','needs_support')),
	source_tx_hash TEXT,
	message_hash TEXT,
	message TEXT,
	attestation TEXT,
	destination_tx_hash TEXT,
	last_error_code TEXT,
	next_attempt_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL, burn_amount_atomic TEXT, platform_fee_atomic TEXT, network_fee_atomic TEXT, message_nonce TEXT, minted_amount_atomic TEXT, mint_raw_transaction TEXT, mint_signer_address TEXT, mint_nonce INTEGER
	CHECK (mint_nonce IS NULL OR mint_nonce >= 0), mint_broadcast_at TEXT,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE payment_chain_blocks (
	chain_id INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	parent_hash TEXT NOT NULL,
	block_timestamp TEXT,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0,1)),
	PRIMARY KEY (chain_id, block_number, block_hash)
) STRICT;

CREATE TABLE payment_chain_events (
	chain_id INTEGER NOT NULL,
	tx_hash TEXT NOT NULL,
	log_index INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	event_name TEXT NOT NULL,
	intent_hash TEXT,
	attempt_hash TEXT,
	payload_json TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0,1)),
	created_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, tx_hash, log_index)
) STRICT;

CREATE TABLE payment_stream_checkpoints (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, stream)
) STRICT;

CREATE TABLE payment_reorg_incidents (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	previous_block_number INTEGER NOT NULL,
	previous_block_hash TEXT NOT NULL,
	common_ancestor_number INTEGER NOT NULL,
	common_ancestor_hash TEXT NOT NULL,
	orphaned_event_count INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('test','live')),
	prefix TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL DEFAULT '',
	last_used_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE webhook_endpoints (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	url TEXT NOT NULL,
	secret_ciphertext TEXT NOT NULL,
	secret_key_id TEXT NOT NULL,
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	enabled_events TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE events (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	dedupe_key TEXT,
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE webhook_deliveries (
	id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	endpoint_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed','dead')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_retry_at TEXT NOT NULL,
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_status_code INTEGER,
	last_error TEXT,
	delivered_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
	FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE payment_outbox (
	id TEXT PRIMARY KEY,
	topic TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enqueued','completed','failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE payment_job_runs (
	dedupe_key TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	job TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
	lease_expires_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT
) STRICT;

CREATE TABLE rate_limits (
	scope TEXT NOT NULL,
	key_hash TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (scope, key_hash, window_start)
) STRICT;

CREATE TABLE payment_fee_ledger (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL,
	intent_id TEXT NOT NULL,
	fee_type TEXT NOT NULL CHECK (fee_type IN ('platform','network')),
	currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
	bearer TEXT NOT NULL CHECK (bearer IN ('none','payer')),
	quoted_amount_atomic TEXT NOT NULL CHECK (
		length(quoted_amount_atomic) BETWEEN 1 AND 78 AND quoted_amount_atomic NOT GLOB '*[^0-9]*'),
	actual_amount_atomic TEXT CHECK (actual_amount_atomic IS NULL OR (
		length(actual_amount_atomic) BETWEEN 1 AND 78 AND actual_amount_atomic NOT GLOB '*[^0-9]*')),
	recipient TEXT CHECK (recipient IS NULL OR (
		length(recipient) = 42 AND substr(recipient, 1, 2) = '0x'
		AND substr(recipient, 3) NOT GLOB '*[^0-9a-fA-F]*')),
	status TEXT NOT NULL CHECK (status IN ('quoted','waived','charged')),
	policy_id TEXT NOT NULL,
	policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
	rule_id TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	charged_tx_hash TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE payment_signer_leases (
	lease_key TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE crosschain_mint_attempts (
	id TEXT PRIMARY KEY,
	op_id TEXT NOT NULL,
	tx_hash TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('prepared','broadcast','pending','success','reverted','unknown')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (op_id) REFERENCES crosschain_operations(op_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE payment_settlement_commits (
	commit_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE,
	intent_id TEXT NOT NULL,
	previous_paid_amount_atomic TEXT NOT NULL CHECK (
		length(previous_paid_amount_atomic) BETWEEN 1 AND 78
		AND previous_paid_amount_atomic NOT GLOB '*[^0-9]*'),
	settled_amount_atomic TEXT NOT NULL CHECK (
		length(settled_amount_atomic) BETWEEN 1 AND 78
		AND settled_amount_atomic NOT GLOB '*[^0-9]*'),
	resulting_paid_amount_atomic TEXT NOT NULL CHECK (
		length(resulting_paid_amount_atomic) BETWEEN 1 AND 78
		AND resulting_paid_amount_atomic NOT GLOB '*[^0-9]*'),
	expected_amount_atomic TEXT NOT NULL CHECK (
		length(expected_amount_atomic) BETWEEN 1 AND 78
		AND expected_amount_atomic NOT GLOB '*[^0-9]*'),
	resulting_status TEXT NOT NULL CHECK (resulting_status IN ('paid','overpaid')),
	created_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_merchants_settlement_wallet ON merchants(settlement_chain_id, settlement_wallet);

CREATE UNIQUE INDEX idx_intents_merchant_idempotency
	ON payment_intents(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;


CREATE INDEX idx_intents_status_expiry ON payment_intents(status, expires_at);



CREATE INDEX idx_quotes_intent_expiry ON payment_quotes(intent_id, expires_at DESC);

CREATE UNIQUE INDEX idx_attempts_user_op_hash
	ON payment_attempts(user_op_hash) WHERE user_op_hash IS NOT NULL;

CREATE UNIQUE INDEX idx_attempts_source_tx_hash
	ON payment_attempts(source_chain_id, source_tx_hash) WHERE source_tx_hash IS NOT NULL;

CREATE INDEX idx_attempts_status_updated ON payment_attempts(status, updated_at);

CREATE UNIQUE INDEX idx_attempts_request_idempotency
	ON payment_attempts(intent_id, payer_address, source_chain_id, idempotency_key);

CREATE INDEX idx_crosschain_due ON crosschain_operations(status, next_attempt_at);

CREATE UNIQUE INDEX idx_payment_chain_canonical_height
	ON payment_chain_blocks(chain_id, block_number) WHERE canonical = 1;

CREATE INDEX idx_payment_events_attempt ON payment_chain_events(chain_id, attempt_hash, canonical);

CREATE INDEX idx_payment_reorg_incidents_open ON payment_reorg_incidents(status, created_at DESC);

CREATE INDEX idx_api_keys_merchant ON api_keys(merchant_id, created_at DESC);

CREATE INDEX idx_webhook_endpoints_merchant ON webhook_endpoints(merchant_id, created_at DESC);

CREATE UNIQUE INDEX idx_events_dedupe ON events(merchant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;


CREATE UNIQUE INDEX idx_webhook_delivery_once ON webhook_deliveries(event_id, endpoint_id);

CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);

CREATE UNIQUE INDEX idx_payment_outbox_logical_once ON payment_outbox(topic, resource_id);

CREATE INDEX idx_payment_outbox_due ON payment_outbox(status, next_attempt_at);

CREATE UNIQUE INDEX idx_payment_fee_ledger_attempt_type ON payment_fee_ledger(attempt_id, fee_type);

CREATE INDEX idx_payment_fee_ledger_intent ON payment_fee_ledger(intent_id, created_at DESC);

CREATE INDEX idx_payment_fee_ledger_policy ON payment_fee_ledger(policy_id, policy_version, rule_id);

CREATE UNIQUE INDEX idx_intents_link_id
	ON payment_intents(link_id) WHERE link_id IS NOT NULL;

CREATE INDEX idx_intents_merchant_cursor
	ON payment_intents(merchant_id, created_at DESC, id DESC);

CREATE INDEX idx_intents_merchant_mode_status_cursor
	ON payment_intents(merchant_id, mode, status, created_at DESC, id DESC);

CREATE INDEX idx_attempts_source_active_created
	ON payment_attempts(source_chain_id, created_at)
	WHERE status IN ('reserved','submitted','processing');

CREATE INDEX idx_attempts_intent_created
	ON payment_attempts(intent_id, created_at DESC);

CREATE INDEX idx_payment_events_chain_canonical_height
	ON payment_chain_events(chain_id, block_number)
	WHERE canonical = 1;

CREATE INDEX idx_rate_limits_window_start ON rate_limits(window_start);

CREATE INDEX idx_payment_fee_ledger_status_created
	ON payment_fee_ledger(status, created_at);

CREATE INDEX idx_webhook_endpoints_active_mode
	ON webhook_endpoints(merchant_id, mode) WHERE status = 'active';

CREATE INDEX idx_events_merchant_cursor
	ON events(merchant_id, created_at DESC, id DESC);

CREATE INDEX idx_crosschain_mint_attempts_op
	ON crosschain_mint_attempts(op_id, created_at DESC);

CREATE INDEX idx_crosschain_message_nonce
	ON crosschain_operations(destination_chain_id, message_nonce)
	WHERE message_nonce IS NOT NULL;

CREATE INDEX idx_intents_open_amount
	ON payment_intents(status, amount_mode, updated_at)
	WHERE amount_mode = 'payer_defined';

CREATE INDEX idx_attempts_submitted_expiry
	ON payment_attempts(status, valid_until)
	WHERE status = 'submitted';

CREATE INDEX idx_attempts_intent_active_created
	ON payment_attempts(intent_id, created_at DESC)
	WHERE status IN ('reserved','submitted','processing');

CREATE INDEX idx_payment_settlement_commits_intent
	ON payment_settlement_commits(intent_id, created_at);

CREATE TRIGGER payment_attempt_matches_payable_intent
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
	SELECT 1
	FROM payment_intents
	WHERE id = NEW.intent_id
	  AND status = 'awaiting_payment'
	  AND (
		(amount_mode = 'fixed' AND amount_atomic = NEW.settlement_amount_atomic)
		OR (amount_mode = 'payer_defined' AND paid_amount_atomic = '0')
	  )
)
BEGIN
	SELECT RAISE(ABORT, 'payment attempt does not match a payable intent');
END;
