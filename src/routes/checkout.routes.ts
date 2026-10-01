import { Hono, type Context } from "hono";
import { formatUnits, isHash, type Hex } from "viem";
import { ERR } from "@gatopago/shared/payment-errors";
import { PAYMENT_NETWORKS } from "@gatopago/shared/payment-networks";
import type { PaymentsContext } from "../middlewares/auth";
import { amount, walletAddress } from "../domain/validation";
import { cancelAttempt, getAttempt, getAttemptByIdempotency, getCheckoutAttempt, insertAttempt, registerSourceTransaction } from "../repositories/attempts";
import { getIntentByLink, getPaymentIntent, getPaymentLink, releaseExpiredPayerDefinedAmount } from "../repositories/intents";
import { getQuote, insertQuote } from "../repositories/quotes";
import { publicIntent, publicLink } from "../domain/presentation";
import { authorizeAttempt, buildQuote, QuoteError } from "../services/quoteEngine";
import { enqueuePaymentJob } from "../services/queue";
import {
	PaymentSourceEvidenceMismatchError,
	verifyReportedSourceTransaction,
} from "../services/reconciliation";
import { enforceRateLimit, requestIdentity } from "../middlewares/rateLimit";
import {
	CHECKOUT_CAPABILITY_HEADER,
	checkoutPayerProofMessage,
	hashCheckoutCapability,
	isCheckoutCapability,
	isCheckoutCapabilityHash,
	isCheckoutProofSignature,
	verifyCheckoutPayerProof,
} from "../services/checkoutAccess";

const routes = new Hono<PaymentsContext>();

function quotePayload(quote: Awaited<ReturnType<typeof buildQuote>>, payerProofMessage: string): Record<string, unknown> {
	return { id: quote.id, intent_id: quote.intentId, payer: quote.payer, source_chain_id: quote.sourceChainId,
		route: quote.route, settlement_amount_atomic: quote.settlementAmountAtomic,
		platform_fee_atomic: quote.platformFeeAtomic, cctp_fee_atomic: quote.cctpFeeAtomic,
		gross_payer_amount_atomic: quote.grossPayerAmountAtomic, fee_source: quote.feeSource,
		fee_policy: { id: quote.feePolicyId, version: quote.feePolicyVersion, rule_id: quote.feeRuleId },
		platform_fee_bps: quote.platformFeeBps, platform_fee_bearer: quote.platformFeeBearer,
		platform_fee_recipient: quote.platformFeeRecipient, route_fee_cap_bps: quote.routeFeeCapBps,
		fee_observed_at: quote.feeObservedAt, expires_at: quote.expiresAt, quote_hash: quote.quoteHash,
		payer_proof_message: payerProofMessage };
}

function checkoutIntent(intent: NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>>): Record<string, unknown> {
	const value = publicIntent(intent);
	delete value.metadata;
	return value;
}

function quoteIntent(
	intent: NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>>,
	requestedAmount: unknown,
): NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>> {
	if (intent.amountMode === "fixed") return intent;
	const normalized = amount(requestedAmount);
	if (intent.status !== "awaiting_payment" || intent.paidAmountAtomic !== "0") {
		throw new QuoteError("INTENT_NOT_PAYABLE", "Payment intent is not payable");
	}
	return { ...intent, amount: normalized.decimal, amountAtomic: normalized.atomic };
}

function attemptIntent(
	intent: NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>>,
	settlementAmountAtomic: string,
): NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>> {
	if (intent.amountMode === "fixed") {
		if (intent.amountAtomic !== settlementAmountAtomic) {
			throw new QuoteError("QUOTE_STALE", "Quote amount no longer matches the payment intent");
		}
		return intent;
	}
	if (intent.status !== "awaiting_payment" || intent.paidAmountAtomic !== "0") {
		throw new QuoteError("INTENT_NOT_PAYABLE", "Payment intent is not payable");
	}
	return { ...intent, amount: formatUnits(BigInt(settlementAmountAtomic), 6), amountAtomic: settlementAmountAtomic };
}

function attemptPayload(attempt: Awaited<ReturnType<typeof getAttempt>>): Record<string, unknown> | null {
	if (!attempt) return null;
	return { id: attempt.id, intent_id: attempt.intentId, payer: attempt.payerAddress,
		source_chain_id: attempt.sourceChainId, route: attempt.route, status: attempt.status,
		router: attempt.routerAddress, authorization: attempt.authorization, signature: attempt.signature,
		authorization_hash: attempt.authorizationHash, valid_after: attempt.validAfter,
		valid_until: attempt.validUntil, source_tx_hash: attempt.sourceTxHash,
		destination_tx_hash: attempt.destinationTxHash, user_op_hash: attempt.userOpHash,
		settled_amount_atomic: attempt.settledAmountAtomic,
		fee_snapshot: { policy_id: attempt.feePolicyId, policy_version: attempt.feePolicyVersion,
			rule_id: attempt.feeRuleId, platform_fee_bps: attempt.platformFeeBps,
			platform_fee_atomic: attempt.platformFeeAtomic, network_fee_max_atomic: attempt.cctpFeeAtomic,
			gross_payer_amount_atomic: attempt.grossPayerAmountAtomic,
			bearer: attempt.platformFeeBearer, recipient: attempt.platformFeeRecipient,
			route_fee_cap_bps: attempt.routeFeeCapBps } };
}

async function requestCapabilityHash(c: Context<PaymentsContext>): Promise<Hex | null> {
	const capability = c.req.header(CHECKOUT_CAPABILITY_HEADER);
	return isCheckoutCapability(capability) ? hashCheckoutCapability(capability) : null;
}

function attemptNotFound(c: Context<PaymentsContext>): Response {
	return c.json({ error: "Attempt not found", error_code: ERR.ATTEMPT_NOT_FOUND,
		requestId: c.get("requestId") }, 404);
}

async function registerAttempt(c: Context<PaymentsContext>, attemptId: string, linkId: string): Promise<Response> {
	const limited = await enforceRateLimit(c, { scope: "checkout_register", key: `${requestIdentity(c)}:${attemptId}`, limit: 60 });
	if (limited) return limited;
	const body = await c.req.json<Record<string, unknown>>();
	const txHash = typeof body.source_tx_hash === "string" ? body.source_tx_hash : "";
	if (!isHash(txHash)) return c.json({ error: "Invalid transaction hash", error_code: ERR.INVALID_TX_HASH, requestId: c.get("requestId") }, 400);
	const capabilityHash = await requestCapabilityHash(c);
	if (!capabilityHash) return attemptNotFound(c);
	const linked = await getIntentByLink(c.env, linkId);
	const current = await getCheckoutAttempt(c.env, attemptId, capabilityHash);
	if (!linked || !current || current.intentId !== linked.id) return attemptNotFound(c);
	let verified: boolean;
	try {
		verified = await verifyReportedSourceTransaction(c.env, attemptId, txHash);
	} catch (error) {
		if (error instanceof PaymentSourceEvidenceMismatchError) {
			return c.json({ error: "Transaction does not prove this payment attempt",
				error_code: ERR.PAYMENT_EVIDENCE_INVALID, requestId: c.get("requestId") }, 400);
		}
		return c.json({ error: "Transaction evidence is temporarily unavailable",
			error_code: ERR.SERVICE_UNAVAILABLE, requestId: c.get("requestId"), retryable: true }, 503);
	}
	if (!verified) {
		const current = await getCheckoutAttempt(c.env, attemptId, capabilityHash);
		if (!current) return attemptNotFound(c);
		await enqueuePaymentJob(c.env, { job: "router_watch", resourceId: current.id,
			dedupeKey: `checkout-router-watch:${current.id}:${Math.floor(Date.now() / 30_000)}`,
			partition: String(current.sourceChainId) });
		return c.json({ error: "Transaction receipt is not available yet",
			error_code: ERR.PAYMENT_EVIDENCE_PENDING, requestId: c.get("requestId"), retryable: true }, 409);
	}
	const attempt = await registerSourceTransaction(c.env, { attemptId, capabilityHash, txHash });
	if (!attempt) return attemptNotFound(c);
	await enqueuePaymentJob(c.env, { job: "attempt_reconcile", resourceId: attempt.id,
		dedupeKey: `attempt_reconcile:${attempt.id}:${txHash.toLowerCase()}`, partition: String(attempt.sourceChainId) });
	await enqueuePaymentJob(c.env, { job: "router_watch", resourceId: attempt.id,
		dedupeKey: `checkout-router-watch:${attempt.id}:${txHash.toLowerCase()}`, partition: String(attempt.sourceChainId) });
	return c.json(attemptPayload(attempt));
}

async function readAttempt(c: Context<PaymentsContext>, attemptId: string, linkId: string): Promise<Response> {
	const limited = await enforceRateLimit(c, { scope: "checkout_attempt_read", key: `${requestIdentity(c)}:${attemptId}`, limit: 240 });
	if (limited) return limited;
	const capabilityHash = await requestCapabilityHash(c);
	if (!capabilityHash) return attemptNotFound(c);
	const attempt = await getCheckoutAttempt(c.env, attemptId, capabilityHash);
	if (!attempt) return attemptNotFound(c);
	const linked = await getIntentByLink(c.env, linkId);
	if (!linked || linked.id !== attempt.intentId) return attemptNotFound(c);
	const intent = await getPaymentIntent(c.env, attempt.intentId);
	return c.json({ ...attemptPayload(attempt), intent_status: intent?.status ?? null });
}

routes.get("/:linkId", async (c) => {
	const limited = await enforceRateLimit(c, { scope: "checkout_read", key: `${requestIdentity(c)}:${c.req.param("linkId")}`, limit: 240 });
	if (limited) return limited;
	const link = await getPaymentLink(c.env, c.req.param("linkId"));
	if (!link) return c.json({ error: "Link not found", error_code: ERR.LINK_NOT_FOUND, requestId: c.get("requestId") }, 404);
	await releaseExpiredPayerDefinedAmount(c.env, link.intentId);
	const intent = await getIntentByLink(c.env, link.id);
	if (!intent) return c.json({ error: "Intent not found", error_code: ERR.INTENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	const networks = Object.values(PAYMENT_NETWORKS).filter((network) => network.paymentSource && c.env.PAYMENT_ENABLED_CHAIN_IDS.split(",").includes(String(network.chainId)))
		.map((network) => ({ chain_id: network.chainId, name: network.name,
			routes: network.isHomeChain ? ["local"] : [network.cctpFast ? "cctp_fast" : null, network.cctpStandard ? "cctp_standard" : null].filter(Boolean),
			usdc: network.usdc, permit_mode: network.permitMode }));
	const linkPayload = publicLink(link);
	if (intent.amountMode === "payer_defined" && intent.paidAmountAtomic === "0") linkPayload.amount = "0";
	return c.json({ link: linkPayload, intent: checkoutIntent(intent), networks });
});

routes.post("/:linkId/quotes", async (c) => {
	const limited = await enforceRateLimit(c, { scope: "checkout_quote", key: `${requestIdentity(c)}:${c.req.param("linkId")}`, limit: 30 });
	if (limited) return limited;
	const current = await getIntentByLink(c.env, c.req.param("linkId"));
	if (current) await releaseExpiredPayerDefinedAmount(c.env, current.id);
	const intent = await getIntentByLink(c.env, c.req.param("linkId"));
	if (!intent) return c.json({ error: "Intent not found", error_code: ERR.INTENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	const body = await c.req.json<Record<string, unknown>>();
	const payer = walletAddress(body.payer ?? body.payer_address);
	const capabilityHash = body.attempt_capability_hash;
	if (!isCheckoutCapabilityHash(capabilityHash)) {
		return c.json({ error: "Invalid checkout capability hash", error_code: ERR.INVALID_CALLDATA,
			requestId: c.get("requestId") }, 400);
	}
	const sourceChainId = Number(body.source_chain_id ?? body.sourceChainId);
	const requested = body.route === "fast" || body.route === "standard" ? body.route : "auto";
	const quote = await buildQuote(c.env, { intent: quoteIntent(intent, body.amount), payer, sourceChainId, requestedRoute: requested });
	await insertQuote(c.env, quote);
	return c.json(quotePayload(quote, checkoutPayerProofMessage({ linkId: c.req.param("linkId"), quote,
		capabilityHash })), 201);
});

routes.post("/:linkId/attempts", async (c) => {
	const limited = await enforceRateLimit(c, { scope: "checkout_attempt", key: `${requestIdentity(c)}:${c.req.param("linkId")}`, limit: 20 });
	if (limited) return limited;
	const current = await getIntentByLink(c.env, c.req.param("linkId"));
	if (current) await releaseExpiredPayerDefinedAmount(c.env, current.id);
	const intent = await getIntentByLink(c.env, c.req.param("linkId"));
	if (!intent) return c.json({ error: "Intent not found", error_code: ERR.INTENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
	if (!idempotencyKey || idempotencyKey.length > 160) return c.json({ error: "Idempotency-Key is required", error_code: ERR.INVALID_CALLDATA, requestId: c.get("requestId") }, 400);
	const body = await c.req.json<Record<string, unknown>>();
	const capability = c.req.header(CHECKOUT_CAPABILITY_HEADER);
	const payerProofSignature = body.payer_proof_signature;
	if (!isCheckoutCapability(capability) || !isCheckoutProofSignature(payerProofSignature)) {
		return c.json({ error: "Checkout wallet proof is required", error_code: ERR.AUTHORIZATION_INVALID,
			requestId: c.get("requestId") }, 400);
	}
	const capabilityHash = await hashCheckoutCapability(capability);
	const quoteId = typeof body.quote_id === "string" ? body.quote_id : typeof body.quoteId === "string" ? body.quoteId : "";
	const quote = await getQuote(c.env, quoteId);
	if (!quote || quote.intentId !== intent.id) return c.json({ error: "Quote not found", error_code: ERR.QUOTE_NOT_FOUND, requestId: c.get("requestId") }, 404);
	const replay = await getAttemptByIdempotency(c.env, { intentId: intent.id, payerAddress: quote.payer,
		sourceChainId: quote.sourceChainId, idempotencyKey });
	if (replay) {
		if (replay.checkoutCapabilityHash?.toLowerCase() !== capabilityHash.toLowerCase()) return attemptNotFound(c);
		return c.json({ ...attemptPayload(replay), idempotent_replay: true });
	}
	if (Date.parse(quote.expiresAt) <= Date.now() || Date.now() - Date.parse(quote.feeObservedAt) > 2 * 60_000) {
		return c.json({ error: "Quote is stale", error_code: ERR.QUOTE_STALE, requestId: c.get("requestId") }, 400);
	}
	const payerProofMessage = checkoutPayerProofMessage({ linkId: c.req.param("linkId"), quote,
		capabilityHash });
	const payerProof = await verifyCheckoutPayerProof({ message: payerProofMessage, payer: quote.payer,
		signature: payerProofSignature });
	if (!payerProof.valid) {
		return c.json({ error: "Checkout wallet proof is invalid", error_code: ERR.AUTHORIZATION_INVALID,
			requestId: c.get("requestId") }, 400);
	}
	const payerLimited = await enforceRateLimit(c, { scope: "checkout_attempt_payer",
		key: `${intent.id}:${quote.payer.toLowerCase()}`, limit: 5, windowSeconds: 10 * 60 });
	if (payerLimited) return payerLimited;
	const attempt = await authorizeAttempt(c.env, {
		intent: attemptIntent(intent, quote.settlementAmountAtomic),
		quote,
		payerUserId: c.get("user")?.user_id ?? null,
	});
	try {
		const stored = await insertAttempt(c.env, { attempt, idempotencyKey,
			checkoutAccess: { capabilityHash, payerProofSignature,
				payerProofMessageHash: payerProof.messageHash } });
		return c.json(attemptPayload(stored), 201);
	} catch (error) {
		const replayAfterRace = await getAttemptByIdempotency(c.env, { intentId: intent.id,
			payerAddress: quote.payer, sourceChainId: quote.sourceChainId, idempotencyKey });
		if (replayAfterRace) {
			if (replayAfterRace.checkoutCapabilityHash?.toLowerCase() !== capabilityHash.toLowerCase()) {
				return attemptNotFound(c);
			}
			return c.json({ ...attemptPayload(replayAfterRace), idempotent_replay: true });
		}
		const currentIntent = await getPaymentIntent(c.env, intent.id);
		if (!currentIntent || currentIntent.status !== "awaiting_payment") {
			return c.json({ error: "Payment intent is not payable", error_code: ERR.INTENT_NOT_PAYABLE,
				requestId: c.get("requestId") }, 409);
		}
		throw error;
	}
});

routes.post("/:linkId/attempts/:attemptId/register", (c) =>
	registerAttempt(c, c.req.param("attemptId"), c.req.param("linkId")));
routes.get("/:linkId/attempts/:attemptId", (c) =>
	readAttempt(c, c.req.param("attemptId"), c.req.param("linkId")));

routes.post("/attempts/:attemptId/cancel", async (c) => {
	const capabilityHash = await requestCapabilityHash(c);
	if (!capabilityHash) return attemptNotFound(c);
	const current = await getCheckoutAttempt(c.env, c.req.param("attemptId"), capabilityHash);
	if (!current) return attemptNotFound(c);
	const canceled = await cancelAttempt(c.env, { attemptId: c.req.param("attemptId"), capabilityHash });
	if (!canceled) return c.json({ error: "Attempt cannot be canceled while its authorization or transaction is active", error_code: ERR.ATTEMPT_ACTIVE, requestId: c.get("requestId") }, 409);
	return c.json({ id: c.req.param("attemptId"), status: "canceled" });
});

routes.onError((error, c) => {
	if (error instanceof QuoteError) {
		const status = error.code === "INTENT_NOT_PAYABLE" || error.code === "INTENT_EXPIRED" || error.code === "ATTEMPT_ACTIVE" ? 409
			: error.code === "SIGNER_UNAVAILABLE" || error.code === "FEE_UNAVAILABLE" ||
				error.code === "INVALID_FEE_POLICY" || error.code === "AMBIGUOUS_FEE_POLICY" ||
				error.code === "INVALID_ROUTE_CAPABILITY" || error.code === "ROUTER_FEE_CAP_EXCEEDED" ||
				error.code === "ROUTER_PREFLIGHT_REQUIRED" || error.code === "ROUTER_PREFLIGHT_FAILED" ? 503 : 400;
		return c.json({ error: error.message, error_code: error.code, requestId: c.get("requestId") }, status as 400);
	}
	throw error;
});

export default routes;
