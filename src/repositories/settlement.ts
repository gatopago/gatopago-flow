import { formatUnits, type Address } from "viem";
import type { Bindings } from "../env";
import type { PaymentAttemptStatus, PaymentIntent } from "../domain/models";
import { changed, nowIso } from "../stores/db";
import { getAttempt } from './attempts';
import { getPaymentIntent } from './intents';
import { actualFeeBreakdown, freeFeeBreakdown } from './fees';
import { publicFeeBreakdown, publicIntent } from '../domain/presentation';

export async function recordAttemptFeeEvidence(env: Bindings, input: {
	attemptId: string;
	platformFeeAtomic: string;
	networkFeeAtomic?: string;
	chargedTxHash: string;
}): Promise<void> {
	const attempt = await getAttempt(env, input.attemptId);
	if (!attempt) throw new Error("Payment attempt is missing for fee evidence");
	const platformActual = BigInt(input.platformFeeAtomic);
	if (platformActual !== BigInt(attempt.platformFeeAtomic)) {
		throw new Error("Actual platform fee does not match the signed attempt");
	}
	const networkActual = input.networkFeeAtomic === undefined ? null : BigInt(input.networkFeeAtomic);
	if (networkActual !== null && (networkActual < 0n || networkActual > BigInt(attempt.cctpFeeAtomic))) {
		throw new Error("Actual network fee exceeds the signed quote");
	}
	const timestamp = nowIso();
	const statements = [
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_fee_ledger SET actual_amount_atomic = ?, status = ?, charged_tx_hash = ?, updated_at = ?
			 WHERE attempt_id = ? AND fee_type = 'platform'`,
		).bind(platformActual.toString(), platformActual === 0n ? "waived" : "charged",
			input.chargedTxHash.toLowerCase(), timestamp, attempt.id),
	];
	if (networkActual !== null) statements.push(env.PAYMENTS_DB.prepare(
			`UPDATE payment_fee_ledger SET actual_amount_atomic = ?, status = ?, charged_tx_hash = ?, updated_at = ?
			 WHERE attempt_id = ? AND fee_type = 'network'`,
		).bind(networkActual.toString(), networkActual === 0n ? "waived" : "charged",
			input.chargedTxHash.toLowerCase(), timestamp, attempt.id));
	await env.PAYMENTS_DB.batch(statements);
}

export async function settleAttempt(env: Bindings, input: {
	attemptId: string; sourceTxHash: string; destinationTxHash?: string | null; settledAmountAtomic: string;
	payerAddress: Address; platformFeeAtomic?: string; networkFeeAtomic?: string;
}): Promise<{ applied: boolean; intent: PaymentIntent | null; eventId: string | null }> {
	const initialAttempt = await getAttempt(env, input.attemptId);
	if (!initialAttempt) return { applied: false, intent: null, eventId: null };
	const eventId = `evt_${initialAttempt.id}`;
	const initialIntent = await getPaymentIntent(env, initialAttempt.intentId);
	if (!initialIntent) return { applied: false, intent: null, eventId: null };
	if (initialAttempt.status === "paid" || initialAttempt.status === "overpaid") {
		return { applied: false, intent: initialIntent, eventId };
	}
	const settledAmount = BigInt(input.settledAmountAtomic);
	if (settledAmount <= 0n) throw new Error("Settled amount must be positive");
	const platformFeeAtomic = input.platformFeeAtomic ?? initialAttempt.platformFeeAtomic;
	if (initialAttempt.route !== "local" && input.networkFeeAtomic === undefined) {
		throw new Error("Actual CCTP network fee is required before settlement");
	}
	const networkFeeAtomic = input.networkFeeAtomic ?? "0";
	await recordAttemptFeeEvidence(env, { attemptId: initialAttempt.id, platformFeeAtomic, networkFeeAtomic,
		chargedTxHash: input.sourceTxHash });
	const fees = actualFeeBreakdown(initialAttempt, platformFeeAtomic, networkFeeAtomic);

	for (let retry = 0; retry < 5; retry += 1) {
		const attempt = await getAttempt(env, input.attemptId);
		if (!attempt) return { applied: false, intent: null, eventId: null };
		const intent = await getPaymentIntent(env, attempt.intentId);
		if (!intent) return { applied: false, intent: null, eventId: null };
		if (attempt.status === "paid" || attempt.status === "overpaid") {
			return { applied: false, intent, eventId };
		}
		if (!(["reserved", "submitted", "processing"] as PaymentAttemptStatus[]).includes(attempt.status)) {
			return { applied: false, intent, eventId };
		}

		const previousPaid = BigInt(intent.paidAmountAtomic);
		const firstOpenSettlement = intent.amountMode === "payer_defined" && previousPaid === 0n;
		const expected = firstOpenSettlement ? BigInt(attempt.settlementAmountAtomic) : BigInt(intent.amountAtomic);
		const paid = previousPaid + settledAmount;
		const overpaid = paid > expected ? paid - expected : 0n;
		const status = paid > expected ? "overpaid" : "paid";
		const eventType = status === "overpaid" ? "payment.overpaid" : "payment.paid";
		const canonicalAmount = firstOpenSettlement ? formatUnits(expected, 6) : intent.amount;
		const timestamp = nowIso();
		const settlementTxHash = (input.destinationTxHash ?? input.sourceTxHash).toLowerCase();
		const commitId = `stc_${crypto.randomUUID()}`;
		const payload = JSON.stringify({ id: intent.id, object: "payment_intent", status,
			amount: canonicalAmount, currency: intent.currency, reference: intent.reference,
			metadata: intent.metadata, expected_amount_atomic: expected.toString(),
			settled_amount_atomic: settledAmount.toString(), paid_amount_atomic: paid.toString(),
			overpaid_amount_atomic: overpaid.toString(), source_tx_hash: input.sourceTxHash.toLowerCase(),
			destination_tx_hash: input.destinationTxHash?.toLowerCase() ?? null,
			fee_breakdown: publicFeeBreakdown(fees) });
		const endpoints = await env.PAYMENTS_DB.prepare(
			"SELECT id FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active' AND mode = ? AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = ?))",
		).bind(intent.merchantId, intent.mode, eventType).all<{ id: string }>();
		const commitExists = "EXISTS (SELECT 1 FROM payment_settlement_commits WHERE commit_id = ?)";
		const statements: D1PreparedStatement[] = [
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO payment_settlement_commits(commit_id, attempt_id, intent_id,
				 previous_paid_amount_atomic, settled_amount_atomic, resulting_paid_amount_atomic,
				 expected_amount_atomic, resulting_status, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
					 SELECT 1 FROM payment_intents AS payment_intent
					 JOIN payment_attempts AS payment_attempt ON payment_attempt.intent_id = payment_intent.id
					 WHERE payment_intent.id = ? AND payment_intent.paid_amount_atomic = ?
					 AND payment_intent.status IN ('awaiting_payment','processing','paid','overpaid','canceled')
					 AND payment_attempt.id = ? AND payment_attempt.status IN ('reserved','submitted','processing')
				 )`,
			).bind(commitId, attempt.id, intent.id, previousPaid.toString(), settledAmount.toString(),
				paid.toString(), expected.toString(), status, timestamp, intent.id,
				previousPaid.toString(), attempt.id),
			env.PAYMENTS_DB.prepare(
				`UPDATE payment_attempts SET status = ?, source_tx_hash = COALESCE(source_tx_hash, ?),
				 destination_tx_hash = COALESCE(destination_tx_hash, ?), settled_amount_atomic = ?, updated_at = ?
				 WHERE id = ? AND ${commitExists}`,
			).bind(status, input.sourceTxHash.toLowerCase(), input.destinationTxHash?.toLowerCase() ?? null,
				settledAmount.toString(), timestamp, attempt.id, commitId),
			env.PAYMENTS_DB.prepare(
				`UPDATE payment_intents SET amount_atomic = ?, status = ?, paid_amount_atomic = ?,
				 paid_tx_hash = COALESCE(paid_tx_hash, ?), paid_at = COALESCE(paid_at, ?), paid_by = COALESCE(paid_by, ?), updated_at = ?
				 WHERE id = ? AND ${commitExists}`,
			).bind(expected.toString(), status, paid.toString(), settlementTxHash,
				timestamp, input.payerAddress, timestamp, intent.id, commitId),
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${commitExists}`,
			).bind(eventId, intent.merchantId, eventType, intent.id, `settlement:${attempt.id}`,
				intent.mode, payload, timestamp, commitId),
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO payment_outbox(id, topic, resource_id, payload, status,
				 next_attempt_at, created_at, updated_at)
				 SELECT ?, 'webhook_delivery', ?, ?, 'pending', ?, ?, ? WHERE ${commitExists}`,
			).bind(`out_${eventId}`, eventId, JSON.stringify({ eventId }), timestamp, timestamp, timestamp, commitId),
		];
		for (const endpoint of endpoints.results) {
			statements.push(env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status,
				 next_retry_at, created_at, updated_at)
				 SELECT ?, ?, ?, 'pending', ?, ?, ? WHERE ${commitExists}`,
			).bind(`whd_${eventId}_${endpoint.id}`, eventId, endpoint.id, timestamp, timestamp, timestamp, commitId));
		}
		const results = await env.PAYMENTS_DB.batch(statements);
		if (changed(results[0])) {
			return { applied: true, intent: await getPaymentIntent(env, intent.id), eventId };
		}
	}

	const latestAttempt = await getAttempt(env, input.attemptId);
	const latestIntent = latestAttempt ? await getPaymentIntent(env, latestAttempt.intentId) : null;
	if (latestAttempt?.status === "paid" || latestAttempt?.status === "overpaid") {
		return { applied: false, intent: latestIntent, eventId };
	}
	throw new Error("Payment settlement compare-and-set retries were exhausted");
}

export async function simulatePaymentIntent(env: Bindings, merchantId: string, id: string): Promise<PaymentIntent | null> {
	const intent = await getPaymentIntent(env, id);
	if (!intent || intent.merchantId !== merchantId || intent.mode !== "test" || intent.status !== "awaiting_payment") return null;
	const timestamp = nowIso();
	const eventId = `evt_sandbox_${intent.id}`;
	const txHash = `sandbox_${intent.id}`;
	const payload = JSON.stringify({ ...publicIntent(intent), status: "paid", tx_hash: txHash,
		paid_amount_atomic: intent.amountAtomic, paid_at: timestamp, simulated: true,
		fee_breakdown: publicFeeBreakdown(freeFeeBreakdown()) });
	const endpoints = await env.PAYMENTS_DB.prepare(
		"SELECT id FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active' AND mode = 'test' AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = 'payment.paid'))",
	).bind(merchantId).all<{ id: string }>();
	const statements: D1PreparedStatement[] = [
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_intents SET status = 'paid', paid_amount_atomic = amount_atomic, paid_by = 'sandbox', paid_tx_hash = ?, paid_at = ?, updated_at = ? WHERE id = ? AND merchant_id = ? AND mode = 'test' AND status = 'awaiting_payment'",
		).bind(txHash, timestamp, timestamp, intent.id, merchantId),
		env.PAYMENTS_DB.prepare(
			"INSERT OR IGNORE INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at) VALUES (?, ?, 'payment.paid', ?, ?, 'test', ?, ?)",
		).bind(eventId, merchantId, intent.id, `sandbox:${intent.id}:paid`, payload, timestamp),
		env.PAYMENTS_DB.prepare(
			"INSERT OR IGNORE INTO payment_outbox(id, topic, resource_id, payload, status, next_attempt_at, created_at, updated_at) VALUES (?, 'webhook_delivery', ?, ?, 'pending', ?, ?, ?)",
		).bind(`out_${eventId}`, eventId, JSON.stringify({ eventId }), timestamp, timestamp, timestamp),
	];
	for (const endpoint of endpoints.results) statements.push(env.PAYMENTS_DB.prepare(
		"INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status, next_retry_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
	).bind(`whd_${eventId}_${endpoint.id}`, eventId, endpoint.id, timestamp, timestamp, timestamp));
	const results = await env.PAYMENTS_DB.batch(statements);
	return changed(results[0]) ? getPaymentIntent(env, intent.id) : null;
}
