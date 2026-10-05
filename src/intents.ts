import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import type { Merchant } from "./auth";
import type { Config } from "./config";
import { HttpError, json, newId, now, readJson } from "./http";
import { recordEvent } from "./webhooks";

export interface IntentRow {
  id: string;
  onchain_id: string;
  merchant_id: string;
  amount: string;
  description: string | null;
  metadata: string | null;
  status: "requires_payment" | "processing" | "succeeded" | "canceled" | "expired";
  expires_at: number;
  created_at: number;
  network: string | null;
  transaction_hash: string | null;
  payer: string | null;
  paid_at: number | null;
}

const DAY = 86_400;

export function presentIntent(row: IntentRow, config: Config) {
  return {
    id: row.id,
    object: "payment_intent",
    amount: formatUnits(BigInt(row.amount), 6),
    currency: "USDC",
    status: row.status,
    description: row.description,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    checkout_url: `${config.webOrigin}/pay/${row.id}`,
    expires_at: row.expires_at,
    created_at: row.created_at,
    livemode: !config.testnet,
    payment: row.network
      ? {
          network: row.network,
          transaction_hash: row.transaction_hash,
          payer: row.payer,
          paid_at: row.paid_at,
        }
      : null,
  };
}

export async function intentRow(env: Env, id: string, merchantId?: string): Promise<IntentRow> {
  const row = await env.FLOW_DB.prepare("SELECT * FROM payment_intents WHERE id = ?")
    .bind(id)
    .first<IntentRow>();
  if (!row || (merchantId && row.merchant_id !== merchantId)) {
    throw new HttpError(404, "NOT_FOUND");
  }
  return row;
}

/**
 * `POST /v1/payment_intents` `{ amount: "18.00", description?, metadata?, expires_in? }`. A repeated
 * `Idempotency-Key` returns the intent the first request created.
 */
export async function createIntent(
  request: Request,
  env: Env,
  config: Config,
  merchant: Merchant,
): Promise<Response> {
  const body = await readJson<{
    amount?: unknown;
    description?: unknown;
    metadata?: unknown;
    expires_in?: unknown;
  }>(request);
  if (typeof body.amount !== "string" || !/^\d{1,7}(\.\d{1,6})?$/.test(body.amount)) {
    throw new HttpError(400, "INVALID_AMOUNT");
  }
  const amount = parseUnits(body.amount, 6);
  if (amount <= 0n) {
    throw new HttpError(400, "INVALID_AMOUNT");
  }
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" || body.description.length > 200)
  ) {
    throw new HttpError(400, "INVALID_DESCRIPTION");
  }
  const metadata = body.metadata ?? {};
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length > 20 ||
    Object.values(metadata).some((value) => typeof value !== "string" || value.length > 500)
  ) {
    throw new HttpError(400, "INVALID_METADATA");
  }
  const expiresIn = body.expires_in ?? DAY;
  if (
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 300 ||
    expiresIn > 7 * DAY
  ) {
    throw new HttpError(400, "INVALID_EXPIRES_IN");
  }
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey !== null && !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
    throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY");
  }

  const id = newId("pi");
  const createdAt = now();
  const row = await env.FLOW_DB.prepare(
    `INSERT INTO payment_intents (id, onchain_id, merchant_id, amount, description, metadata, status,
       expires_at, created_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, 'requires_payment', ?, ?, ?)
     ON CONFLICT (merchant_id, idempotency_key) DO NOTHING RETURNING *`,
  )
    .bind(
      id,
      keccak256(toHex(id)),
      merchant.id,
      amount.toString(),
      body.description ?? null,
      JSON.stringify(metadata),
      createdAt + expiresIn,
      createdAt,
      idempotencyKey,
    )
    .first<IntentRow>();
  if (!row) {
    const existing = await env.FLOW_DB.prepare(
      "SELECT * FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ?",
    )
      .bind(merchant.id, idempotencyKey)
      .first<IntentRow>();
    return json(presentIntent(existing!, config));
  }
  await env.FLOW_DB.batch(
    recordEvent(env, merchant.id, "payment_intent.created", presentIntent(row, config)),
  );
  return json(presentIntent(row, config), 201);
}

/** `GET /v1/payment_intents` */
export async function listIntents(env: Env, config: Config, merchant: Merchant): Promise<Response> {
  const { results } = await env.FLOW_DB.prepare(
    "SELECT * FROM payment_intents WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(merchant.id)
    .all<IntentRow>();
  return json({ data: results.map((row) => presentIntent(row, config)) });
}

/** `GET /v1/payment_intents/:id` */
export async function readIntent(env: Env, config: Config, merchant: Merchant, id: string) {
  return json(presentIntent(await intentRow(env, id, merchant.id), config));
}

/** `POST /v1/payment_intents/:id/cancel`: only before it is paid. */
export async function cancelIntent(env: Env, config: Config, merchant: Merchant, id: string) {
  await intentRow(env, id, merchant.id);
  const row = await env.FLOW_DB.prepare(
    `UPDATE payment_intents SET status = 'canceled'
     WHERE id = ? AND status = 'requires_payment' RETURNING *`,
  )
    .bind(id)
    .first<IntentRow>();
  if (!row) {
    throw new HttpError(409, "INTENT_NOT_CANCELABLE");
  }
  await env.FLOW_DB.batch(
    recordEvent(env, merchant.id, "payment_intent.canceled", presentIntent(row, config)),
  );
  return json(presentIntent(row, config));
}

/** `POST /v1/payment_intents/:id/simulate`: testnet only, marks it paid without a transaction. */
export async function simulatePayment(env: Env, config: Config, merchant: Merchant, id: string) {
  if (!config.testnet) {
    throw new HttpError(404, "NOT_FOUND");
  }
  if ((await intentRow(env, id, merchant.id)).status !== "requires_payment") {
    throw new HttpError(409, "INTENT_NOT_PAYABLE");
  }
  const row = await markSucceeded(env, config, id, {
    network: config.home.id,
    transactionHash: null,
    payer: null,
  });
  return json(presentIntent(row!, config));
}

/**
 * Records who paid and emits `payment_intent.succeeded`; null when it already succeeded. Money that
 * arrives is recorded even after the intent expired or was canceled.
 */
export async function markSucceeded(
  env: Env,
  config: Config,
  id: string,
  payment: { network: string; transactionHash: string | null; payer: string | null },
): Promise<IntentRow | null> {
  const row = await env.FLOW_DB.prepare(
    `UPDATE payment_intents SET status = 'succeeded', network = ?, transaction_hash = ?, payer = ?,
       paid_at = ?
     WHERE id = ? AND status != 'succeeded' RETURNING *`,
  )
    .bind(payment.network, payment.transactionHash, payment.payer, now(), id)
    .first<IntentRow>();
  if (row) {
    await env.FLOW_DB.batch(
      recordEvent(env, row.merchant_id, "payment_intent.succeeded", presentIntent(row, config)),
    );
  }
  return row;
}

/** Intents nobody paid in time. */
export async function expireIntents(env: Env, config: Config): Promise<void> {
  const { results } = await env.FLOW_DB.prepare(
    `UPDATE payment_intents SET status = 'expired'
     WHERE status = 'requires_payment' AND expires_at <= ? RETURNING *`,
  )
    .bind(now())
    .all<IntentRow>();
  if (results.length) {
    await env.FLOW_DB.batch(
      results.flatMap((row) =>
        recordEvent(env, row.merchant_id, "payment_intent.expired", presentIntent(row, config)),
      ),
    );
  }
}
