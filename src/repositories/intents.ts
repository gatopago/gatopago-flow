import { formatUnits } from "viem";
import type { Bindings } from "../env";
import type { Merchant, PaymentIntent, PaymentLink } from "../domain/models";
import { changed, first, nowIso } from "../stores/db";
import { type IntentRow, INTENT_COLUMNS, mapIntent, type LinkRow, mapLink } from "./rows";

export async function createPaymentIntent(
  env: Bindings,
  input: {
    merchant: Merchant;
    amountAtomic: string;
    reference: string;
    amountMode?: PaymentIntent["amountMode"];
    metadata: Record<string, unknown>;
    expiresAt: string;
    idempotencyKey?: string | null;
    mode?: "test" | "live";
  },
): Promise<{ intent: PaymentIntent; link: PaymentLink; replay: boolean }> {
  if (input.idempotencyKey) {
    const existing = await first<IntentRow>(
      env,
      `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.merchant.id, input.idempotencyKey],
    );
    if (existing) {
      const intent = mapIntent(existing);
      const link = intent.linkId ? await getPaymentLink(env, intent.linkId) : null;
      if (!link) {
        throw new Error("Idempotent intent is missing its checkout link");
      }
      return { intent, link, replay: true };
    }
  }
  const intentId = `pi_${crypto.randomUUID()}`;
  const linkId = crypto.randomUUID();
  const timestamp = nowIso();
  const mode = input.mode ?? "test";
  const amountMode = input.amountMode ?? "fixed";
  const eventId = `evt_created_${intentId}`;
  const eventPayload = JSON.stringify({
    id: intentId,
    object: "payment_intent",
    amount: formatUnits(BigInt(input.amountAtomic), 6),
    amount_atomic: input.amountAtomic,
    amount_mode: amountMode,
    currency: "USDC",
    reference: input.reference,
    metadata: input.metadata,
    status: "awaiting_payment",
    mode,
    tx_hash: null,
    paid_at: null,
    settlement_chain_id: input.merchant.settlementChainId,
    expires_at: input.expiresAt,
    created_at: timestamp,
    updated_at: timestamp,
  });
  try {
    await env.PAYMENTS_DB.batch([
      env.PAYMENTS_DB.prepare(
        `INSERT INTO payment_intents(id, merchant_id, link_id, idempotency_key, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        intentId,
        input.merchant.id,
        linkId,
        input.idempotencyKey ?? null,
        input.amountAtomic,
        amountMode,
        input.reference,
        JSON.stringify(input.metadata),
        mode,
        input.merchant.settlementWallet,
        input.merchant.settlementChainId,
        input.merchant.accountVersion,
        input.expiresAt,
        timestamp,
        timestamp,
      ),
      env.PAYMENTS_DB.prepare(
        "INSERT INTO events(id, merchant_id, type, object_id, dedupe_key, mode, " +
          "payload, created_at) VALUES (?, ?, 'payment.created', ?, ?, ?, ?, ?)",
      ).bind(
        eventId,
        input.merchant.id,
        intentId,
        `intent:${intentId}:created`,
        mode,
        eventPayload,
        timestamp,
      ),
      env.PAYMENTS_DB.prepare(
        "INSERT INTO payment_outbox(id, topic, resource_id, payload, status, " +
          "next_attempt_at, created_at, updated_at) VALUES (?, 'webhook_delivery', ?, ?, " +
          "'pending', ?, ?, ?)",
      ).bind(
        `out_${eventId}`,
        eventId,
        JSON.stringify({ eventId }),
        timestamp,
        timestamp,
        timestamp,
      ),
      env.PAYMENTS_DB.prepare(
        `INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status, next_retry_at, created_at, updated_at)
			 SELECT 'whd_' || ? || '_' || id, ?, id, 'pending', ?, ?, ? FROM webhook_endpoints
			 WHERE merchant_id = ? AND status = 'active' AND mode = ?
			 AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = 'payment.created'))`,
      ).bind(eventId, eventId, timestamp, timestamp, timestamp, input.merchant.id, mode),
    ]);
  } catch (error) {
    if (input.idempotencyKey) {
      const winner = await first<IntentRow>(
        env,
        `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`,
        [input.merchant.id, input.idempotencyKey],
      );
      if (winner) {
        const intent = mapIntent(winner);
        const link = intent.linkId ? await getPaymentLink(env, intent.linkId) : null;
        if (link) {
          return { intent, link, replay: true };
        }
      }
    }
    throw error;
  }
  const intent = await getPaymentIntent(env, intentId);
  const link = await getPaymentLink(env, linkId);
  if (!intent || !link) {
    throw new Error("Payment intent creation was not durable");
  }
  return { intent, link, replay: false };
}

export async function getPaymentIntent(env: Bindings, id: string): Promise<PaymentIntent | null> {
  const row = await first<IntentRow>(
    env,
    `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? mapIntent(row) : null;
}

export async function getIntentByLink(
  env: Bindings,
  linkId: string,
): Promise<PaymentIntent | null> {
  const row = await first<IntentRow>(
    env,
    `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE link_id = ? LIMIT 1`,
    [linkId],
  );
  return row ? mapIntent(row) : null;
}

export async function getPaymentLink(env: Bindings, id: string): Promise<PaymentLink | null> {
  const row = await first<LinkRow>(
    env,
    `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE link_id = ? LIMIT 1`,
    [id],
  );
  return row ? mapLink(row) : null;
}

export async function listPaymentLinks(
  env: Bindings,
  ownerUserId: string,
  limit = 20,
): Promise<PaymentLink[]> {
  const rows = await env.PAYMENTS_DB.prepare(
    "SELECT i.* FROM merchants m JOIN payment_intents i ON i.merchant_id = m.id " +
      "WHERE m.owner_user_id = ? AND i.link_id IS NOT NULL ORDER BY i.created_at " +
      "DESC, i.id DESC LIMIT ?",
  )
    .bind(ownerUserId, limit)
    .all<LinkRow>();
  return rows.results.map(mapLink);
}

export async function listPaymentIntents(
  env: Bindings,
  merchantId: string,
  limit = 50,
  input: {
    startingAfter?: string | null;
    status?: PaymentIntent["status"] | null;
    mode?: PaymentIntent["mode"] | null;
  } = {},
): Promise<PaymentIntent[]> {
  const conditions = ["merchant_id = ?"];
  const values: unknown[] = [merchantId];
  if (input.status) {
    conditions.push("status = ?");
    values.push(input.status);
  }
  if (input.mode) {
    conditions.push("mode = ?");
    values.push(input.mode);
  }
  if (input.startingAfter) {
    conditions.push(`(created_at < (SELECT created_at FROM payment_intents WHERE id = ? AND merchant_id = ?)
		 OR (created_at = (SELECT created_at FROM payment_intents WHERE id = ? AND merchant_id = ?) AND id < ?))`);
    values.push(
      input.startingAfter,
      merchantId,
      input.startingAfter,
      merchantId,
      input.startingAfter,
    );
  }
  values.push(limit);
  const rows = await env.PAYMENTS_DB.prepare(
    "SELECT " +
      `${INTENT_COLUMNS}` +
      " FROM payment_intents WHERE " +
      `${conditions.join(" AND ")}` +
      " ORDER BY created_at DESC, id DESC LIMIT ?",
  )
    .bind(...values)
    .all<IntentRow>();
  return rows.results.map(mapIntent);
}

export async function cancelPaymentIntent(
  env: Bindings,
  merchantId: string,
  id: string,
): Promise<boolean> {
  const timestamp = nowIso();
  const result = await env.PAYMENTS_DB.prepare(
    "UPDATE payment_intents SET status = 'canceled', updated_at = ? WHERE id = ? " +
      "AND merchant_id = ? AND status = 'awaiting_payment'",
  )
    .bind(timestamp, id, merchantId)
    .run();
  return changed(result);
}

const ATTEMPT_EVIDENCE_GRACE_SECONDS = 15 * 60;

export async function releaseExpiredPayerDefinedAmount(
  env: Bindings,
  intentId: string,
): Promise<void> {
  const timestamp = nowIso();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      `UPDATE payment_attempts SET status = 'expired', last_error_code = 'PAYMENT_EVIDENCE_TIMEOUT', updated_at = ?
			 WHERE intent_id = ? AND status IN ('reserved','submitted') AND valid_until < ?`,
    ).bind(timestamp, intentId, nowSeconds - ATTEMPT_EVIDENCE_GRACE_SECONDS),
    env.PAYMENTS_DB.prepare(
      `UPDATE payment_intents SET amount_atomic = '0', updated_at = ?
			 WHERE id = ? AND amount_mode = 'payer_defined' AND status = 'awaiting_payment'
			 AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE intent_id = ? AND status IN ('reserved','submitted','processing'))`,
    ).bind(timestamp, intentId, intentId),
  ]);
}
