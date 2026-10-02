import { Hono, type Context } from "hono";
import { ERR } from "@gatopago/shared/payment-errors";
import type { PaymentsContext } from "../middlewares/auth";
import { requireAuth } from "../middlewares/auth";
import {
  amount,
  DomainValidationError,
  futureExpiry,
  metadata,
  requestBody,
  shortText,
} from "../domain/validation";
import { createPaymentIntent, getPaymentIntent, listPaymentIntents } from "../repositories/intents";
import { getMerchantByOwner } from "../repositories/accounts";
import { getPaymentIntentFeeBreakdown } from "../repositories/fees";
import { publicFeeBreakdown, publicIntent } from "../domain/presentation";
import { simulatePaymentIntent } from "../repositories/settlement";
import {
  createApiKey,
  createWebhookEndpoint,
  disableWebhookEndpoint,
  listApiKeys,
  listEvents,
  listWebhookDeliveries,
  listWebhookEndpoints,
  resendWebhookDelivery,
  revokeApiKey,
  type ApiMode,
} from "../repositories/merchant";
import { enqueuePaymentJob, flushPaymentOutbox } from "../services/queue";
import { enforceRateLimit } from "../middlewares/rateLimit";
import { paymentModeCapabilities } from "../services/capabilities";

const routes = new Hono<PaymentsContext>();
routes.use("*", requireAuth);
routes.use("*", async (c, next) => {
  const limited = await enforceRateLimit(c, {
    scope: "dashboard",
    key: c.get("user")!.user_id,
    limit: 300,
  });
  if (limited) {
    return limited;
  }
  await next();
});

async function merchant(c: Context<PaymentsContext>) {
  return getMerchantByOwner(c.env, c.get("user")!.user_id);
}

routes.get("/", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json(
      {
        error: "Merchant is not configured",
        error_code: ERR.MERCHANT_NOT_CONFIGURED,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  return c.json({
    id: value.id,
    name: value.displayName,
    settlement_wallet: value.settlementWallet,
    settlement_chain_id: value.settlementChainId,
    account_version: value.accountVersion,
    status: value.status,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  });
});

routes.get("/capabilities", async (c) => {
  const value = await merchant(c);
  return c.json(paymentModeCapabilities(c.env, value?.settlementChainId));
});

function liveModeUnavailable(
  c: Context<PaymentsContext>,
  mode: ApiMode,
  settlementChainId: number,
): Response | null {
  if (mode !== "live") {
    return null;
  }
  const capabilities = paymentModeCapabilities(c.env, settlementChainId);
  if (capabilities.modes.live.enabled) {
    return null;
  }
  return c.json(
    {
      error: "Live payments are not enabled for the configured settlement network",
      error_code: ERR.SERVICE_UNAVAILABLE,
      requestId: c.get("requestId"),
      live_mode_reason: capabilities.modes.live.reason,
    },
    503,
  );
}

routes.post("/keys", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json(
      {
        error: "Merchant is not configured",
        error_code: ERR.MERCHANT_NOT_CONFIGURED,
        requestId: c.get("requestId"),
      },
      409,
    );
  }
  const body = requestBody(await c.req.json(), ["mode", "name"]);
  const mode: ApiMode = body.mode === "live" ? "live" : "test";
  const unavailable = liveModeUnavailable(c, mode, value.settlementChainId);
  if (unavailable) {
    return unavailable;
  }
  const created = await createApiKey(c.env, value.id, mode, shortText(body.name, 80, "Default"));
  return c.json(
    {
      id: created.key.id,
      key: created.secret,
      prefix: created.key.prefix,
      mode: created.key.mode,
      name: created.key.name,
      created_at: created.key.createdAt,
    },
    201,
  );
});

routes.get("/keys", async (c) => {
  const value = await merchant(c);
  return c.json({
    data: value
      ? (await listApiKeys(c.env, value.id)).map((key) => ({
          id: key.id,
          prefix: key.prefix,
          mode: key.mode,
          name: key.name,
          last_used_at: key.lastUsedAt,
          revoked: !!key.revokedAt,
          created_at: key.createdAt,
        }))
      : [],
  });
});

routes.delete("/keys/:id", async (c) => {
  const value = await merchant(c);
  if (!value || !(await revokeApiKey(c.env, value.id, c.req.param("id")))) {
    return c.json(
      {
        error: "API key not found",
        error_code: ERR.INVALID_API_KEY,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  return c.json({ id: c.req.param("id"), revoked: true });
});

function webhookUrl(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("Invalid webhook URL");
  }
  const parsed = new URL(input);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(parsed.hostname) ||
    parsed.hostname.includes(":")
  ) {
    throw new Error("Invalid webhook URL");
  }
  return parsed.toString();
}

routes.post("/webhooks", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json(
      {
        error: "Merchant is not configured",
        error_code: ERR.MERCHANT_NOT_CONFIGURED,
        requestId: c.get("requestId"),
      },
      409,
    );
  }
  let body: Record<string, unknown>;
  let url: string;
  try {
    body = requestBody(await c.req.json(), ["url", "mode", "events"]);
    url = webhookUrl(body.url);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw error;
    }
    return c.json(
      {
        error: "Webhook URL must be a public HTTPS URL",
        error_code: ERR.INVALID_WEBHOOK_URL,
        requestId: c.get("requestId"),
      },
      400,
    );
  }
  const mode: ApiMode = body.mode === "live" ? "live" : "test";
  const unavailable = liveModeUnavailable(c, mode, value.settlementChainId);
  if (unavailable) {
    return unavailable;
  }
  const events =
    Array.isArray(body.events) && body.events.every((event) => typeof event === "string")
      ? (body.events.slice(0, 20) as string[])
      : null;
  const created = await createWebhookEndpoint(c.env, value.id, url, mode, events);
  return c.json(
    {
      id: created.endpoint.id,
      url: created.endpoint.url,
      secret: created.secret,
      mode: created.endpoint.mode,
      events: created.endpoint.events,
      status: created.endpoint.status,
      created_at: created.endpoint.createdAt,
    },
    201,
  );
});

routes.get("/webhooks", async (c) => {
  const value = await merchant(c);
  return c.json({
    data: value
      ? (await listWebhookEndpoints(c.env, value.id)).map((endpoint) => ({
          id: endpoint.id,
          url: endpoint.url,
          mode: endpoint.mode,
          events: endpoint.events,
          status: endpoint.status,
          created_at: endpoint.createdAt,
        }))
      : [],
  });
});

routes.delete("/webhooks/:id", async (c) => {
  const value = await merchant(c);
  if (!value || !(await disableWebhookEndpoint(c.env, value.id, c.req.param("id")))) {
    return c.json(
      {
        error: "Webhook not found",
        error_code: ERR.OPERATION_NOT_FOUND,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  return c.json({ id: c.req.param("id"), disabled: true });
});

routes.get("/payment_intents", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json({ data: [], has_more: false });
  }
  const parsed = Number(c.req.query("limit") ?? 100);
  const limit = Number.isSafeInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 100;
  const validStatuses = new Set([
    "awaiting_payment",
    "processing",
    "paid",
    "overpaid",
    "canceled",
    "expired",
    "failed",
  ]);
  const status = c.req.query("status");
  const mode = c.req.query("mode");
  const intents = await listPaymentIntents(c.env, value.id, limit + 1, {
    startingAfter: c.req.query("starting_after") ?? null,
    status: status && validStatuses.has(status) ? (status as "paid") : null,
    mode: mode === "test" || mode === "live" ? mode : null,
  });
  return c.json({
    data: intents.slice(0, limit).map(publicIntent),
    has_more: intents.length > limit,
  });
});

routes.get("/payment_intents/:id", async (c) => {
  const value = await merchant(c);
  const intent = await getPaymentIntent(c.env, c.req.param("id"));
  if (!value || !intent || intent.merchantId !== value.id) {
    return c.json(
      {
        error: "Intent not found",
        error_code: ERR.INTENT_NOT_FOUND,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  const feeBreakdown = await getPaymentIntentFeeBreakdown(c.env, intent.id);
  return c.json({
    ...publicIntent(intent),
    checkout_url: intent.linkId
      ? `${c.env.CHECKOUT_BASE_URL}?id=${encodeURIComponent(intent.linkId)}`
      : null,
    fee_breakdown: publicFeeBreakdown(feeBreakdown),
  });
});

routes.get("/events", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json({ data: [], has_more: false });
  }
  const parsed = Number(c.req.query("limit") ?? 100);
  const limit = Number.isSafeInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 100;
  const events = await listEvents(
    c.env,
    value.id,
    limit + 1,
    c.req.query("starting_after") ?? null,
  );
  return c.json({ data: events.slice(0, limit), has_more: events.length > limit });
});

routes.get("/webhook_deliveries", async (c) => {
  const value = await merchant(c);
  return c.json({ data: value ? await listWebhookDeliveries(c.env, value.id, 100) : [] });
});

routes.post("/webhook_deliveries/:id/resend", async (c) => {
  const value = await merchant(c);
  if (!value || !(await resendWebhookDelivery(c.env, value.id, c.req.param("id")))) {
    return c.json(
      {
        error: "Delivery not found",
        error_code: ERR.OPERATION_NOT_FOUND,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  await enqueuePaymentJob(c.env, {
    job: "webhook_delivery",
    resourceId: c.req.param("id"),
    dedupeKey: `webhook_manual:${c.req.param("id")}:${crypto.randomUUID()}`,
  });
  return c.json({ id: c.req.param("id"), queued: true });
});

routes.post("/sandbox/charge", async (c) => {
  const value = await merchant(c);
  if (!value) {
    return c.json(
      {
        error: "Merchant is not configured",
        error_code: ERR.MERCHANT_NOT_CONFIGURED,
        requestId: c.get("requestId"),
      },
      409,
    );
  }
  const body = requestBody(await c.req.json(), ["amount", "reference", "metadata", "expires_at"]);
  const normalized = amount(body.amount);
  const created = await createPaymentIntent(c.env, {
    merchant: value,
    amountAtomic: normalized.atomic,
    reference: shortText(body.reference, 160),
    metadata: metadata(body.metadata),
    expiresAt: futureExpiry(body.expires_at),
    mode: "test",
  });
  return c.json(
    {
      ...publicIntent(created.intent),
      checkout_url: `${c.env.CHECKOUT_BASE_URL}?id=${encodeURIComponent(created.link.id)}`,
    },
    201,
  );
});

routes.post("/sandbox/simulate/:id", async (c) => {
  const value = await merchant(c);
  const intent = value ? await simulatePaymentIntent(c.env, value.id, c.req.param("id")) : null;
  if (!intent) {
    return c.json(
      {
        error: "Test intent is not payable",
        error_code: ERR.INTENT_NOT_PAYABLE,
        requestId: c.get("requestId"),
      },
      409,
    );
  }
  await flushPaymentOutbox(c.env, 10);
  return c.json(publicIntent(intent));
});

export default routes;
