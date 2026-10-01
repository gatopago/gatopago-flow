import { formatUnits, type Address } from "viem";
import type { Merchant, PaymentAttempt, PaymentAttemptStatus, PaymentIntent, PaymentLink, PaymentQuote, PaymentRoute } from "../domain/models";
import type { PaymentFeeLine } from "@gatopago/shared/fees";

export type MerchantRow = {
	id: string; owner_user_id: string; display_name: string; settlement_wallet: Address;
	settlement_chain_id: number; account_version: number; status: Merchant["status"];
	created_at: string; updated_at: string;
};

export type IntentRow = {
	id: string; merchant_id: string; link_id: string | null; amount_atomic: string;
	amount_mode: PaymentIntent["amountMode"];
	currency: "USDC"; reference: string; metadata: string; mode: PaymentIntent["mode"]; status: PaymentIntent["status"];
	settlement_wallet: Address; settlement_chain_id: number; settlement_account_version: number;
	paid_amount_atomic: string; paid_tx_hash: string | null; paid_at: string | null; paid_by: string | null;
	expires_at: string | null; created_at: string; updated_at: string;
};

export type LinkRow = IntentRow & { link_id: string; owner_user_id: string };

export type QuoteRow = {
	id: string; intent_id: string; payer: Address; source_chain_id: number; route: PaymentRoute;
	settlement_amount_atomic: string; platform_fee_atomic: string; cctp_fee_atomic: string;
	gross_payer_amount_atomic: string; fee_source: PaymentQuote["feeSource"];
	fee_policy_id: string; fee_policy_version: number; fee_rule_id: string;
	platform_fee_bps: number; platform_fee_bearer: PaymentQuote["platformFeeBearer"];
	platform_fee_recipient: Address | null; route_fee_cap_bps: number;
	fee_observed_at: string; expires_at: string; quote_hash: `0x${string}`; created_at: string;
};

export type AttemptRow = {
	id: string; attempt_hash: `0x${string}`; intent_id: string; quote_id: string;
	payer_user_id: string | null; payer_address: Address; source_chain_id: number; route: PaymentRoute;
	status: PaymentAttemptStatus; router_address: Address; authorization_hash: `0x${string}`;
	authorization_json: string; signature: `0x${string}`;
	checkout_capability_hash: `0x${string}` | null;
	payer_proof_signature: `0x${string}` | null;
	payer_proof_message_hash: `0x${string}` | null;
	valid_after: number; valid_until: number;
	user_op_hash: string | null; source_tx_hash: string | null; destination_tx_hash: string | null;
	settlement_amount_atomic: string; platform_fee_atomic: string; cctp_fee_atomic: string;
	gross_payer_amount_atomic: string; fee_policy_id: string; fee_policy_version: number; fee_rule_id: string;
	platform_fee_bps: number; platform_fee_bearer: PaymentAttempt["platformFeeBearer"];
	platform_fee_recipient: Address | null; route_fee_cap_bps: number;
	settled_amount_atomic: string; created_at: string; updated_at: string;
};

export type FeeLedgerRow = {
	fee_type: "platform" | "network"; bearer: PaymentFeeLine["bearer"];
	quoted_amount_atomic: string; actual_amount_atomic: string | null; recipient: Address | null;
	status: PaymentFeeLine["status"]; policy_id: string; policy_version: number; rule_id: string;
};

export const MERCHANT_COLUMNS = "id, owner_user_id, display_name, settlement_wallet, settlement_chain_id, account_version, status, created_at, updated_at";

export const INTENT_COLUMNS = "id, merchant_id, link_id, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, paid_amount_atomic, paid_tx_hash, paid_at, paid_by, expires_at, created_at, updated_at";


export const QUOTE_COLUMNS = "id, intent_id, payer, source_chain_id, route, settlement_amount_atomic, platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps, fee_source, fee_observed_at, expires_at, quote_hash, created_at";

export const ATTEMPT_COLUMNS = "id, attempt_hash, intent_id, quote_id, payer_user_id, payer_address, source_chain_id, route, status, router_address, authorization_hash, authorization_json, signature, checkout_capability_hash, payer_proof_signature, payer_proof_message_hash, valid_after, valid_until, user_op_hash, source_tx_hash, destination_tx_hash, settlement_amount_atomic, platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps, settled_amount_atomic, created_at, updated_at";

export function mapMerchant(row: MerchantRow): Merchant {
	return { id: row.id, ownerUserId: row.owner_user_id, displayName: row.display_name, settlementWallet: row.settlement_wallet,
		settlementChainId: row.settlement_chain_id, accountVersion: row.account_version, status: row.status,
		createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapIntent(row: IntentRow): PaymentIntent {
	return { id: row.id, merchantId: row.merchant_id, linkId: row.link_id, amount: formatUnits(BigInt(row.amount_atomic), 6),
		amountAtomic: row.amount_atomic, amountMode: row.amount_mode, currency: row.currency, reference: row.reference,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>, mode: row.mode, status: row.status,
		settlementWallet: row.settlement_wallet, settlementChainId: row.settlement_chain_id,
		settlementAccountVersion: row.settlement_account_version, paidAmountAtomic: row.paid_amount_atomic,
		paidTxHash: row.paid_tx_hash, paidAt: row.paid_at, expiresAt: row.expires_at,
		createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapLink(row: LinkRow): PaymentLink {
	const status = row.status === 'paid' || row.status === 'overpaid' ? 'paid'
		: row.status === 'canceled' || row.status === 'expired' ? row.status : 'pending';
	return { id: row.link_id, intentId: row.id, merchantId: row.merchant_id, ownerUserId: row.owner_user_id,
		wallet: row.settlement_wallet, amount: formatUnits(BigInt(row.amount_atomic), 6), currency: row.currency, reference: row.reference,
		status, txHash: row.paid_tx_hash, paidAt: row.paid_at, paidBy: row.paid_by,
		createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapQuote(row: QuoteRow): PaymentQuote {
	return { id: row.id, intentId: row.intent_id, payer: row.payer, sourceChainId: row.source_chain_id,
		route: row.route, settlementAmountAtomic: row.settlement_amount_atomic,
		platformFeeAtomic: row.platform_fee_atomic, cctpFeeAtomic: row.cctp_fee_atomic,
		grossPayerAmountAtomic: row.gross_payer_amount_atomic,
		feePolicyId: row.fee_policy_id, feePolicyVersion: row.fee_policy_version,
		feeRuleId: row.fee_rule_id, platformFeeBps: row.platform_fee_bps,
		platformFeeBearer: row.platform_fee_bearer, platformFeeRecipient: row.platform_fee_recipient,
		routeFeeCapBps: row.route_fee_cap_bps, feeSource: row.fee_source,
		feeObservedAt: row.fee_observed_at, expiresAt: row.expires_at, quoteHash: row.quote_hash,
		createdAt: row.created_at };
}

export function mapAttempt(row: AttemptRow): PaymentAttempt {
	return { id: row.id, attemptHash: row.attempt_hash, intentId: row.intent_id, quoteId: row.quote_id,
		payerUserId: row.payer_user_id, payerAddress: row.payer_address, sourceChainId: row.source_chain_id,
		route: row.route, status: row.status, routerAddress: row.router_address,
		authorizationHash: row.authorization_hash, authorization: JSON.parse(row.authorization_json) as Record<string, unknown>,
		signature: row.signature, checkoutCapabilityHash: row.checkout_capability_hash,
		payerProofSignature: row.payer_proof_signature, payerProofMessageHash: row.payer_proof_message_hash,
		validAfter: row.valid_after, validUntil: row.valid_until,
		userOpHash: row.user_op_hash, sourceTxHash: row.source_tx_hash, destinationTxHash: row.destination_tx_hash,
		settlementAmountAtomic: row.settlement_amount_atomic, platformFeeAtomic: row.platform_fee_atomic,
		cctpFeeAtomic: row.cctp_fee_atomic, grossPayerAmountAtomic: row.gross_payer_amount_atomic,
		feePolicyId: row.fee_policy_id, feePolicyVersion: row.fee_policy_version,
		feeRuleId: row.fee_rule_id, platformFeeBps: row.platform_fee_bps,
		platformFeeBearer: row.platform_fee_bearer, platformFeeRecipient: row.platform_fee_recipient,
		routeFeeCapBps: row.route_fee_cap_bps, settledAmountAtomic: row.settled_amount_atomic,
		expiresAt: new Date(row.valid_until * 1000).toISOString(), createdAt: row.created_at, updatedAt: row.updated_at };
}
