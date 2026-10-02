import { Hono } from "hono";
import { ERR } from "@gatopago/shared/payment-errors";
import { getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import type { PaymentsContext } from "../middlewares/auth";
import { requireApiKey } from "../middlewares/apiAuth";
import { amount, futureExpiry, metadata, requestBody, shortText } from "../domain/validation";
import { cancelPaymentIntent, createPaymentIntent, getPaymentIntent, listPaymentIntents } from "../repositories/intents";
import { getMerchantById } from "../repositories/accounts";
import { getPaymentIntentFeeBreakdown } from "../repositories/fees";
import { publicFeeBreakdown, publicIntent } from "../domain/presentation";
import { simulatePaymentIntent } from "../repositories/settlement";
import { listEvents } from "../repositories/merchant";
import { flushPaymentOutbox } from "../services/queue";
import { enforceRateLimit } from "../middlewares/rateLimit";
import { paymentModeCapabilities } from "../services/capabilities";

const routes = new Hono<PaymentsContext>();
routes.use("*", requireApiKey);
routes.use("*", async (c, next) => {
	const limited = await enforceRateLimit(c, { scope: "merchant_api", key: c.get("merchantId") ?? "invalid", limit: 600 });
	if (limited) return limited;
	await next();
});

routes.post("/payment_intents", async (c) => {
	const merchant = await getMerchantById(c.env, c.get("merchantId")!);
	if (!merchant || merchant.status !== "active") return c.json({ error: "Merchant is unavailable", error_code: ERR.MERCHANT_NOT_CONFIGURED, requestId: c.get("requestId") }, 409);
	const network = getPaymentNetworkCapabilities(merchant.settlementChainId);
	const expectedMode = network?.isTestnet === false ? "live" : "test";
	if (c.get("apiMode") !== expectedMode) return c.json({ error: "This API-key mode is not enabled for the settlement network",
		error_code: ERR.SERVICE_UNAVAILABLE, requestId: c.get("requestId") }, 503);
	const capabilities = paymentModeCapabilities(c.env, merchant.settlementChainId);
	if (c.get("apiMode") === "live" && !capabilities.modes.live.enabled) {
		return c.json({ error: "Live payments are not enabled for the configured settlement network",
			error_code: ERR.SERVICE_UNAVAILABLE, requestId: c.get("requestId"),
			live_mode_reason: capabilities.modes.live.reason }, 503);
	}
	const body = requestBody(await c.req.json(), ["amount", "currency", "reference", "metadata", "expires_at"]);
	const normalized = amount(body.amount);
	if (body.currency && String(body.currency).toUpperCase() !== "USDC") return c.json({ error: "Only USDC settlement is supported", error_code: ERR.UNSUPPORTED_CURRENCY, requestId: c.get("requestId") }, 400);
	const created = await createPaymentIntent(c.env, {
		merchant, amountAtomic: normalized.atomic,
		reference: shortText(body.reference, 160), metadata: metadata(body.metadata),
		expiresAt: futureExpiry(body.expires_at), idempotencyKey: c.req.header("Idempotency-Key") ?? null,
		mode: c.get("apiMode") ?? "test",
	});
	return c.json({ ...publicIntent(created.intent), checkout_link_id: created.link.id,
		checkout_url: `${c.env.CHECKOUT_BASE_URL}?id=${encodeURIComponent(created.link.id)}`,
		idempotent_replay: created.replay }, created.replay ? 200 : 201);
});

routes.get("/payment_intents", async (c) => {
	return c.json({ data: (await listPaymentIntents(c.env, c.get("merchantId")!, 100)).map(publicIntent) });
});

routes.get("/payment_intents/:id", async (c) => {
	const intent = await getPaymentIntent(c.env, c.req.param("id"));
	if (!intent || intent.merchantId !== c.get("merchantId")) return c.json({ error: "Intent not found", error_code: ERR.INTENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	return c.json({ ...publicIntent(intent),
		fee_breakdown: publicFeeBreakdown(await getPaymentIntentFeeBreakdown(c.env, intent.id)) });
});

routes.post("/payment_intents/:id/cancel", async (c) => {
	const canceled = await cancelPaymentIntent(c.env, c.get("merchantId")!, c.req.param("id"));
	if (!canceled) return c.json({ error: "Intent cannot be canceled in its current state", error_code: ERR.INTENT_NOT_PAYABLE, requestId: c.get("requestId") }, 409);
	const intent = await getPaymentIntent(c.env, c.req.param("id"));
	return c.json(intent ? publicIntent(intent) : { id: c.req.param("id"), status: "canceled" });
});

routes.post("/payment_intents/:id/simulate_payment", async (c) => {
	if (c.get("apiMode") !== "test") return c.json({ error: "Simulation is sandbox-only", error_code: ERR.SANDBOX_ONLY, requestId: c.get("requestId") }, 400);
	const intent = await getPaymentIntent(c.env, c.req.param("id"));
	if (!intent || intent.merchantId !== c.get("merchantId")) return c.json({ error: "Intent not found", error_code: ERR.INTENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	const paid = await simulatePaymentIntent(c.env, c.get("merchantId")!, intent.id);
	if (!paid) return c.json({ error: "Intent is not payable", error_code: ERR.INTENT_NOT_PAYABLE, requestId: c.get("requestId") }, 409);
	await flushPaymentOutbox(c.env, 10);
	return c.json({ ...publicIntent(paid), simulated: true });
});

routes.get("/events", async (c) => c.json({ data: await listEvents(c.env, c.get("merchantId")!, 100) }));
routes.get("/events/:id", async (c) => {
	const event = (await listEvents(c.env, c.get("merchantId")!, 100)).find((item) => item.id === c.req.param("id"));
	if (!event) return c.json({ error: "Event not found", error_code: ERR.EVENT_NOT_FOUND, requestId: c.get("requestId") }, 404);
	return c.json(event);
});

export default routes;
