import { bytesToHex } from "viem";
import { sha256, type Merchant } from "./auth";
import type { Config } from "./config";
import { HttpError, json, newId, now, readJson } from "./http";

const presentMerchant = (merchant: Merchant) => ({ object: "merchant", ...merchant });

/** `GET /v1/merchant` */
export function readMerchant(merchant: Merchant): Response {
  return json(presentMerchant(merchant));
}

/** `POST /v1/merchant` `{ name }`: the name payers see at checkout. */
export async function updateMerchant(request: Request, env: Env, merchant: Merchant) {
  const { name } = await readJson<{ name?: unknown }>(request);
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 60) {
    throw new HttpError(400, "INVALID_NAME");
  }
  await env.FLOW_DB.prepare("UPDATE merchants SET name = ? WHERE id = ?")
    .bind(name.trim(), merchant.id)
    .run();
  return json(presentMerchant({ ...merchant, name: name.trim() }));
}

/** `POST /v1/api_keys`: the key is shown only in this response. */
export async function createApiKey(env: Env, config: Config, merchant: Merchant) {
  const key = `sk_${config.testnet ? "test" : "live"}_${bytesToHex(crypto.getRandomValues(new Uint8Array(24))).slice(2)}`;
  const id = newId("key");
  const createdAt = now();
  await env.FLOW_DB.prepare(
    "INSERT INTO api_keys (id, merchant_id, key_hash, last4, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, merchant.id, await sha256(key), key.slice(-4), createdAt)
    .run();
  return json({ id, object: "api_key", key, last4: key.slice(-4), created_at: createdAt }, 201);
}

/** `GET /v1/api_keys` */
export async function listApiKeys(env: Env, merchant: Merchant) {
  const { results } = await env.FLOW_DB.prepare(
    `SELECT id, last4, created_at FROM api_keys
     WHERE merchant_id = ? AND revoked_at IS NULL ORDER BY created_at`,
  )
    .bind(merchant.id)
    .all();
  return json({ data: results.map((key) => ({ ...key, object: "api_key" })) });
}

/** `DELETE /v1/api_keys/:id` */
export async function revokeApiKey(env: Env, merchant: Merchant, id: string) {
  const result = await env.FLOW_DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL",
  )
    .bind(now(), id, merchant.id)
    .run();
  if (result.meta.changes !== 1) {
    throw new HttpError(404, "NOT_FOUND");
  }
  return json({ id, deleted: true });
}
