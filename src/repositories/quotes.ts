import type { Bindings } from "../env";
import type { PaymentQuote } from "../domain/models";
import { first } from "../stores/db";
import { type QuoteRow, QUOTE_COLUMNS, mapQuote } from './rows';

export async function getQuote(env: Bindings, id: string): Promise<PaymentQuote | null> {
	const row = await first<QuoteRow>(env, `SELECT ${QUOTE_COLUMNS} FROM payment_quotes WHERE id = ? LIMIT 1`, [id]);
	return row ? mapQuote(row) : null;
}

export async function insertQuote(env: Bindings, quote: PaymentQuote): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		`INSERT INTO payment_quotes(id, intent_id, payer, source_chain_id, route, settlement_amount_atomic,
		 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version,
		 fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps,
		 fee_source, fee_observed_at, expires_at, quote_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(quote.id, quote.intentId, quote.payer, quote.sourceChainId, quote.route,
		quote.settlementAmountAtomic, quote.platformFeeAtomic, quote.cctpFeeAtomic,
		quote.grossPayerAmountAtomic, quote.feePolicyId, quote.feePolicyVersion, quote.feeRuleId,
		quote.platformFeeBps, quote.platformFeeBearer, quote.platformFeeRecipient, quote.routeFeeCapBps,
		quote.feeSource, quote.feeObservedAt,
		quote.expiresAt, quote.quoteHash, quote.createdAt).run();
}
