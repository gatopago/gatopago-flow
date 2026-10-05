import { bytesToHex } from "viem";
import type { Merchant } from "./auth";
import type { Config } from "./config";
import { HttpError, json, newId, now, readJson } from "./http";

const MAX_ATTEMPTS = 10;

/** Statements that record `type` for the merchant and schedule its delivery to every endpoint. */
export function recordEvent(env: Env, merchantId: string, type: string, data: unknown) {
  const id = newId("evt");
  const createdAt = now();
  return [
    env.FLOW_DB.prepare(
      "INSERT INTO events (id, merchant_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, merchantId, type, JSON.stringify(data), createdAt),
    env.FLOW_DB.prepare(
      `INSERT INTO webhook_deliveries (event_id, endpoint_id, next_attempt_at)
       SELECT ?, id, ? FROM webhook_endpoints WHERE merchant_id = ?`,
    ).bind(id, createdAt, merchantId),
  ];
}

/** `GET /v1/events`: the latest events, each with how its delivery to every endpoint went. */
export async function listEvents(env: Env, merchant: Merchant): Promise<Response> {
  const { results } = await env.FLOW_DB.prepare(
    `SELECT events.id, events.type, events.data, events.created_at,
       json_group_array(json_object(
         'endpoint', webhook_deliveries.endpoint_id,
         'attempts', webhook_deliveries.attempts,
         'delivered_at', webhook_deliveries.delivered_at,
         'last_status', webhook_deliveries.last_status
       )) FILTER (WHERE webhook_deliveries.endpoint_id IS NOT NULL) AS deliveries
     FROM events LEFT JOIN webhook_deliveries ON webhook_deliveries.event_id = events.id
     WHERE events.merchant_id = ? GROUP BY events.id ORDER BY events.created_at DESC LIMIT 100`,
  )
    .bind(merchant.id)
    .all<{ id: string; type: string; data: string; created_at: number; deliveries: string }>();
  return json({
    data: results.map((event) => ({
      ...event,
      object: "event",
      data: JSON.parse(event.data),
      deliveries: JSON.parse(event.deliveries),
    })),
  });
}

/** `POST /v1/events/:id/resend`: delivers the event again to every endpoint, from attempt one. */
export async function resendEvent(env: Env, merchant: Merchant, id: string): Promise<Response> {
  const event = await env.FLOW_DB.prepare("SELECT 1 FROM events WHERE id = ? AND merchant_id = ?")
    .bind(id, merchant.id)
    .first();
  if (!event) {
    throw new HttpError(404, "NOT_FOUND");
  }
  await env.FLOW_DB.prepare(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, next_attempt_at)
     SELECT ?, id, ? FROM webhook_endpoints WHERE merchant_id = ?
     ON CONFLICT (event_id, endpoint_id) DO UPDATE SET attempts = 0, delivered_at = NULL,
       next_attempt_at = excluded.next_attempt_at`,
  )
    .bind(id, now(), merchant.id)
    .run();
  return json({ id, object: "event", resent: true });
}

/** `POST /v1/webhook_endpoints`: the signing secret is shown only in this response. */
export async function createEndpoint(
  request: Request,
  env: Env,
  config: Config,
  merchant: Merchant,
): Promise<Response> {
  const { url } = await readJson<{ url?: string }>(request);
  if (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:") {
    throw new HttpError(400, "INVALID_URL");
  }
  const id = newId("we");
  const secret = `whsec_${bytesToHex(crypto.getRandomValues(new Uint8Array(24))).slice(2)}`;
  await env.FLOW_DB.prepare(
    "INSERT INTO webhook_endpoints (id, merchant_id, url, secret, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, merchant.id, url, await encrypt(config, secret), now())
    .run();
  return json({ id, object: "webhook_endpoint", url, secret }, 201);
}

/** `GET /v1/webhook_endpoints` */
export async function listEndpoints(env: Env, merchant: Merchant): Promise<Response> {
  const { results } = await env.FLOW_DB.prepare(
    "SELECT id, url, created_at FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at",
  )
    .bind(merchant.id)
    .all();
  return json({ data: results.map((endpoint) => ({ ...endpoint, object: "webhook_endpoint" })) });
}

/** `DELETE /v1/webhook_endpoints/:id` */
export async function deleteEndpoint(env: Env, merchant: Merchant, id: string): Promise<Response> {
  const result = await env.FLOW_DB.prepare(
    "DELETE FROM webhook_endpoints WHERE id = ? AND merchant_id = ?",
  )
    .bind(id, merchant.id)
    .run();
  if (result.meta.changes !== 1) {
    throw new HttpError(404, "NOT_FOUND");
  }
  return json({ id, deleted: true });
}

/**
 * Sends due deliveries: `POST` the event with `GatoPago-Signature: t=<time>,v1=<HMAC-SHA256 of
 * "<time>.<body>">`. Failures are retried with exponential backoff, up to 10 attempts.
 */
export async function deliverWebhooks(env: Env, config: Config): Promise<void> {
  const { results } = await env.FLOW_DB.prepare(
    `SELECT d.event_id, d.endpoint_id, d.attempts, e.type, e.data, e.created_at, w.url, w.secret
     FROM webhook_deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN webhook_endpoints w ON w.id = d.endpoint_id
     WHERE d.delivered_at IS NULL AND d.attempts < ? AND d.next_attempt_at <= ?
     ORDER BY d.next_attempt_at LIMIT 50`,
  )
    .bind(MAX_ATTEMPTS, now())
    .all<{
      event_id: string;
      endpoint_id: string;
      attempts: number;
      type: string;
      data: string;
      created_at: number;
      url: string;
      secret: string;
    }>();
  await Promise.all(
    results.map(async (delivery) => {
      const body = JSON.stringify({
        id: delivery.event_id,
        object: "event",
        type: delivery.type,
        created_at: delivery.created_at,
        data: JSON.parse(delivery.data),
      });
      const timestamp = now();
      const status = await fetch(delivery.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "GatoPago-Signature": `t=${timestamp},v1=${await hmac(await decrypt(config, delivery.secret), `${timestamp}.${body}`)}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }).then(
        (response) => (void response.body?.cancel(), response.status),
        () => 0,
      );
      const delivered = status >= 200 && status < 300;
      await env.FLOW_DB.prepare(
        `UPDATE webhook_deliveries SET attempts = attempts + 1, last_status = ?, delivered_at = ?,
         next_attempt_at = ? WHERE event_id = ? AND endpoint_id = ?`,
      )
        .bind(
          status,
          delivered ? now() : null,
          now() + 60 * 2 ** delivery.attempts,
          delivery.event_id,
          delivery.endpoint_id,
        )
        .run();
    }),
  );
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
  ).slice(2);
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unbase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function encrypt(config: Config, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    config.webhookKey,
    new TextEncoder().encode(secret),
  );
  return `${base64(iv)}.${base64(new Uint8Array(sealed))}`;
}

async function decrypt(config: Config, sealed: string): Promise<string> {
  const [iv, data] = sealed.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(iv) },
      config.webhookKey,
      unbase64(data),
    ),
  );
}
