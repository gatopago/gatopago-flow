import type { Context, Next } from "hono";
import { ERR } from "@gatopago/shared/payment-errors";
import type { PaymentsContext } from "./auth";
import { authenticateApiKey } from "../repositories/merchant";

export async function requireApiKey(c: Context<PaymentsContext>, next: Next): Promise<Response | void> {
	const authorization = c.req.header("Authorization");
	const raw = authorization?.startsWith("Bearer ") ? authorization.slice(7) : c.req.header("X-Api-Key");
	const auth = raw ? await authenticateApiKey(c.env, raw) : null;
	if (!auth) return c.json({ error: "Invalid API key", error_code: ERR.UNAUTHENTICATED, requestId: c.get("requestId") }, 401);
	c.set("merchantId", auth.merchantId);
	c.set("apiMode", auth.mode);
	await next();
}
