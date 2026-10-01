import { Hono } from "hono";
import { ERR } from "@gatopago/shared/payment-errors";
import type { PaymentsContext } from "../middlewares/auth";
import { requireAuth } from "../middlewares/auth";
import { futureExpiry, metadata, optionalAmount, shortText } from "../domain/validation";
import { createPaymentIntent, getPaymentLink, listPaymentLinks } from "../repositories/intents";
import { getMerchantByOwner } from "../repositories/accounts";
import { publicLink } from "../domain/presentation";
import { getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import { enforceRateLimit, requestIdentity } from "../middlewares/rateLimit";

const routes = new Hono<PaymentsContext>();

routes.post("/", requireAuth, async (c) => {
	const limited = await enforceRateLimit(c, { scope: "links_write", key: c.get("user")!.user_id, limit: 60 });
	if (limited) return limited;
	const user = c.get("user")!;
	const merchant = await getMerchantByOwner(c.env, user.user_id);
	if (!merchant || merchant.status !== "active") {
		return c.json({ error: "Settlement account is not configured", error_code: ERR.MERCHANT_NOT_CONFIGURED, requestId: c.get("requestId") }, 409);
	}
	const body = await c.req.json<Record<string, unknown>>();
	const normalized = optionalAmount(body.amount);
	if (body.currency && String(body.currency).toUpperCase() !== "USDC") {
		return c.json({ error: "Universal Checkout currently settles USDC", error_code: ERR.UNSUPPORTED_CURRENCY, requestId: c.get("requestId") }, 400);
	}
	const created = await createPaymentIntent(c.env, {
		merchant,
		amountAtomic: normalized.atomic,
		amountMode: normalized.mode,
		reference: shortText(body.reference, 160),
		metadata: metadata(body.metadata),
		expiresAt: futureExpiry(body.expires_at ?? body.expiresAt),
		idempotencyKey: c.req.header("Idempotency-Key") ?? null,
		mode: getPaymentNetworkCapabilities(merchant.settlementChainId)?.isTestnet === false ? "live" : "test",
	});
	return c.json({ ...publicLink(created.link), intent: created.intent.id, idempotent_replay: created.replay }, created.replay ? 200 : 201);
});

routes.get("/", requireAuth, async (c) => {
	const limited = await enforceRateLimit(c, { scope: "links_owner_read", key: c.get("user")!.user_id, limit: 240 });
	if (limited) return limited;
	const links = await listPaymentLinks(c.env, c.get("user")!.user_id, 50);
	return c.json({ links: links.map(publicLink) });
});

routes.get("/:id", async (c) => {
	const limited = await enforceRateLimit(c, { scope: "links_public_read", key: `${requestIdentity(c)}:${c.req.param("id")}`, limit: 240 });
	if (limited) return limited;
	const link = await getPaymentLink(c.env, c.req.param("id"));
	if (!link) return c.json({ error: "Link not found", error_code: ERR.LINK_NOT_FOUND, requestId: c.get("requestId") }, 404);
	return c.json(publicLink(link));
});

export default routes;
