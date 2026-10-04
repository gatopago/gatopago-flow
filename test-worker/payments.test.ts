import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import FlowWorker from "../src/index";
import {
  getMerchantByOwner,
  upsertSettlementAccount,
  SettlementAccountConflict,
} from "../src/repositories/accounts";
import { PaymentCommands } from "../src/commands";
import { consumePaymentQueue } from "../src/services/jobs";
import { insertQuoteAndAttempt, registerSourceTransaction } from "../src/repositories/attempts";
import { getPaymentIntent, getPaymentLink } from "../src/repositories/intents";
import { getQuote } from "../src/repositories/quotes";
import { authorizeAttempt, buildQuote } from "../src/services/quoteEngine";
import { settleAttempt } from "../src/repositories/settlement";
import { createApiKey } from "../src/repositories/merchant";
import {
  acquirePaymentSignerLease,
  releasePaymentSignerLease,
} from "../src/stores/signerLeaseStore";
import { claimWebhookDelivery, listWebhookDeliveryJobs } from "../src/stores/jobStore";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  rotateWebhookEncryptionBatch,
} from "../src/repositories/merchant";
import type { Bindings } from "../src/env";
import { privateKeyToAccount } from "viem/accounts";
import { hashCheckoutCapability } from "../src/services/checkoutAccess";

const merchantWallet = "0x00000000000000000000000000000000000000A1";
const payerAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const payer = payerAccount.address;
const checkoutCapability = "A".repeat(43);
const opsToken = "runtime-test-ops-token-32-characters";

async function seedCheckout(suffix: string): Promise<{ linkId: string; intentId: string }> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 60 * 60_000).toISOString();
  const merchantId = `mrc_${suffix}`;
  const intentId = `pi_${suffix}`;
  const linkId = `link_${suffix}`;
  await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      "INSERT INTO merchants(id, owner_user_id, settlement_wallet, settlement_chain_id, account_version, created_at, updated_at) VALUES (?, ?, ?, 421614, 1, ?, ?)",
    ).bind(merchantId, `uid_${suffix}`, merchantWallet, now, now),
    env.PAYMENTS_DB.prepare(
      "INSERT INTO payment_intents(id, merchant_id, link_id, amount_atomic, currency, reference, metadata, status, settlement_wallet, settlement_chain_id, settlement_account_version, expires_at, created_at, updated_at) VALUES (?, ?, ?, '10000000', 'USDC', 'Order', '{}', 'awaiting_payment', ?, 421614, 1, ?, ?, ?)",
    ).bind(intentId, merchantId, linkId, merchantWallet, expires, now, now),
  ]);
  return { linkId, intentId };
}

async function quote(
  linkId: string,
  chainId = 421614,
  selectedAmount?: string,
  payerAddress = payer,
  capability = checkoutCapability,
): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payer: payerAddress,
      source_chain_id: chainId,
      amount: selectedAmount,
      attempt_capability_hash: await hashCheckoutCapability(capability),
    }),
  });
  expect(response.status).toBe(chainId === 421614 ? 201 : 400);
  return response.json<Record<string, unknown>>();
}

async function attempt(
  linkId: string,
  quoted: Record<string, unknown>,
  key: string,
  capability = checkoutCapability,
  signingAccount = payerAccount,
): Promise<Response> {
  const proof = await signingAccount.signMessage({ message: String(quoted.payer_proof_message) });
  return SELF.fetch(`https://payments.test/checkout/v1/${linkId}/attempts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-GatoPago-Checkout-Capability": capability,
    },
    body: JSON.stringify({ quote_id: quoted.id, payer_proof_signature: proof }),
  });
}

beforeEach(async () => {
  await env.PAYMENTS_DB.exec(
    "DELETE FROM rate_limits; DELETE FROM webhook_deliveries; DELETE FROM payment_outbox; DELETE FROM events; DELETE FROM webhook_endpoints; DELETE FROM payment_job_runs; DELETE FROM payment_signer_leases; DELETE FROM wallet_execution_commands; DELETE FROM crosschain_operations; DELETE FROM payment_settlement_commits; DELETE FROM payment_fee_ledger; DELETE FROM payment_attempts; DELETE FROM payment_quotes; DELETE FROM payment_intents; DELETE FROM api_keys; DELETE FROM settlement_account_commands; DELETE FROM merchants;",
  );
});

describe("independent Payments Worker", () => {
  it("persists wallet reservations atomically and rolls back duplicate quotes", async () => {
    const { intentId } = await seedCheckout("wallet-reservation");
    const intent = (await getPaymentIntent(env, intentId))!;
    const reservation = async () => {
      const quote = await buildQuote(env, { intent, payer, sourceChainId: 421614 });
      const attempt = await authorizeAttempt(env, { intent, quote, payerUserId: "usr_wallet" });
      return { quote, attempt, idempotencyKey: "wallet-reservation" };
    };
    const initial = await reservation();
    const stored = await insertQuoteAndAttempt(env, initial);
    expect(stored).toMatchObject({
      id: initial.attempt.id,
      quoteId: initial.quote.id,
      payerUserId: "usr_wallet",
      checkoutCapabilityHash: null,
      payerProofSignature: null,
    });
    expect(await getQuote(env, initial.quote.id)).toEqual(initial.quote);
    const replay = await reservation();
    expect(await insertQuoteAndAttempt(env, replay)).toEqual(stored);
    expect(await getQuote(env, replay.quote.id)).toBeNull();
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_attempts WHERE intent_id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_fee_ledger WHERE attempt_id = ?",
      )
        .bind(stored.id)
        .first(),
    ).toEqual({ count: 2 });
  });

  it("serves liveness and checkout without the App Worker", async () => {
    const { linkId } = await seedCheckout("independent");
    const live = await SELF.fetch("https://payments.test/v1/health/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok", service: "gatopago-flow" });
    const response = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      intent: { amount: "10", status: "awaiting_payment" },
    });
  });

  it("rejects checkout field aliases even alongside canonical fields", async () => {
    const { linkId } = await seedCheckout("strict-checkout");
    const current = {
      payer,
      source_chain_id: 421614,
      attempt_capability_hash: await hashCheckoutCapability(checkoutCapability),
    };
    for (const alias of [{ payer_address: payer }, { sourceChainId: 421614 }]) {
      const response = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...current, ...alias }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error_code: "INVALID_CALLDATA" });
    }
    const quoted = await quote(linkId);
    const proof = await payerAccount.signMessage({ message: String(quoted.payer_proof_message) });
    const obsolete = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/attempts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "strict-checkout",
        "X-GatoPago-Checkout-Capability": checkoutCapability,
      },
      body: JSON.stringify({
        quote_id: quoted.id,
        quoteId: quoted.id,
        payer_proof_signature: proof,
      }),
    });
    expect(obsolete.status).toBe(400);
    expect(await obsolete.json()).toMatchObject({ error_code: "INVALID_CALLDATA" });
    expect((await attempt(linkId, quoted, "strict-checkout")).status).toBe(201);
  });

  it("accepts API keys only through Authorization Bearer", async () => {
    await seedCheckout("strict-api-key");
    const created = await createApiKey(env, "mrc_strict-api-key", "test", "Strict credentials");
    const obsolete = await SELF.fetch("https://payments.test/v1/payment_intents", {
      headers: { "X-Api-Key": created.secret },
    });
    expect(obsolete.status).toBe(401);
    expect(
      (
        await SELF.fetch("https://payments.test/v1/payment_intents", {
          headers: { Authorization: `Bearer ${created.secret}` },
        })
      ).status,
    ).toBe(200);
  });

  it("keeps open reservations independent and fixes the amount at first settlement", async () => {
    const { linkId, intentId } = await seedCheckout("open-amount");
    await env.PAYMENTS_DB.batch([
      env.PAYMENTS_DB.prepare(
        "UPDATE payment_intents SET amount_atomic = '0', amount_mode = 'payer_defined' WHERE id = ?",
      ).bind(intentId),
    ]);

    const checkout = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}`);
    expect(await checkout.json()).toMatchObject({
      intent: { amount: "0", amount_mode: "payer_defined" },
    });
    const missingAmount = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payer,
        source_chain_id: 421614,
        attempt_capability_hash: await hashCheckoutCapability(checkoutCapability),
      }),
    });
    expect(missingAmount.status).toBe(400);
    expect(await missingAmount.json()).toMatchObject({ error_code: "INVALID_AMOUNT" });

    const [twelve, nineteen] = await Promise.all([
      quote(linkId, 421614, "12.50"),
      quote(linkId, 421614, "19.00"),
    ]);
    const responses = await Promise.all([
      attempt(linkId, twelve, "open-amount-12"),
      attempt(linkId, nineteen, "open-amount-19"),
    ]);
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const [twelveAttempt, nineteenAttempt] = await Promise.all(
      responses.map((response) => response.json<Record<string, unknown>>()),
    );
    const stored = await env.PAYMENTS_DB.prepare(
      "SELECT amount_atomic, amount_mode FROM payment_intents WHERE id = ?",
    )
      .bind(intentId)
      .first();
    expect(stored).toEqual({ amount_atomic: "0", amount_mode: "payer_defined" });
    expect(await getPaymentLink(env, linkId)).toMatchObject({ amount: "0" });

    expect(
      (
        await settleAttempt(env, {
          attemptId: String(twelveAttempt.id),
          sourceTxHash: `0x${"41".repeat(32)}`,
          settledAmountAtomic: "12500000",
          payerAddress: payer,
        })
      ).applied,
    ).toBe(true);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT amount_atomic, paid_amount_atomic, status FROM payment_intents WHERE id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ amount_atomic: "12500000", paid_amount_atomic: "12500000", status: "paid" });
    expect(await getPaymentLink(env, linkId)).toMatchObject({ amount: "12.5", status: "paid" });

    expect(
      (
        await settleAttempt(env, {
          attemptId: String(nineteenAttempt.id),
          sourceTxHash: `0x${"42".repeat(32)}`,
          settledAmountAtomic: "19000000",
          payerAddress: payer,
        })
      ).applied,
    ).toBe(true);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT amount_atomic, paid_amount_atomic, status FROM payment_intents WHERE id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ amount_atomic: "12500000", paid_amount_atomic: "31500000", status: "overpaid" });
  });

  it("keeps detailed health hidden behind a 32+ character operations token", async () => {
    expect((await SELF.fetch("https://payments.test/v1/health/ops")).status).toBe(404);
    expect(
      (
        await SELF.fetch("https://payments.test/v1/health/ops", {
          headers: { "X-Ops-Token": "wrong-but-deliberately-long-token-value" },
        })
      ).status,
    ).toBe(404);
    const authorized = await SELF.fetch("https://payments.test/v1/health/ops", {
      headers: { "X-Ops-Token": opsToken },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ service: "gatopago-flow" });
  });

  it("starts from a fresh schema without any legacy import control", async () => {
    const table = await env.PAYMENTS_DB.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'payment_migration_control'",
    ).first();
    expect(table).toBeNull();
    const health = await SELF.fetch("https://payments.test/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ checks: { database: "ok" } });
  });

  it("serves the merchant API without the App Worker", async () => {
    await seedCheckout("api-independent");
    const created = await createApiKey(env, "mrc_api-independent", "test", "Runtime");
    const response = await SELF.fetch("https://payments.test/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "runtime-api-order",
      },
      body: JSON.stringify({ amount: "7.50", reference: "Independent API" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      amount: "7.5",
      status: "awaiting_payment",
      mode: "test",
      checkout_link_id: expect.any(String),
    });
    const simulated = await SELF.fetch(
      `https://payments.test/v1/payment_intents/${body.id as string}/simulate_payment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${created.secret}` },
      },
    );
    expect(simulated.status).toBe(200);
    expect(await simulated.json()).toMatchObject({ id: body.id, status: "paid", simulated: true });
  });

  it("rejects retired HTTP aliases instead of translating them", async () => {
    const { linkId, intentId } = await seedCheckout("retired-routes");
    const key = await createApiKey(env, "mrc_retired-routes", "test", "Current");
    expect(
      (
        await SELF.fetch(`https://payments.test/v1/payment_intents/${intentId}/onchain`, {
          headers: { Authorization: `Bearer ${key.secret}` },
        })
      ).status,
    ).toBe(404);
    const reserved = await (
      await attempt(linkId, await quote(linkId), "retired-route-order")
    ).json<Record<string, unknown>>();
    expect(
      (
        await SELF.fetch(`https://payments.test/checkout/v1/attempts/${reserved.id as string}`, {
          headers: { "X-GatoPago-Checkout-Capability": checkoutCapability },
        })
      ).status,
    ).toBe(404);
  });

  it("commits payment.created, outbox and subscribed deliveries exactly once", async () => {
    const now = new Date().toISOString();
    await env.PAYMENTS_DB.batch([
      env.PAYMENTS_DB.prepare(
        "INSERT INTO merchants(id, owner_user_id, settlement_wallet, settlement_chain_id, account_version, created_at, updated_at) VALUES ('mrc_created', 'uid_created', ?, 421614, 1, ?, ?)",
      ).bind(merchantWallet, now, now),
      env.PAYMENTS_DB.prepare(
        "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, mode, enabled_events, status, created_at, updated_at) VALUES ('whe_created', 'mrc_created', 'https://webhook.example/created', 'nonce.ciphertext', 'test', 'test', '[\"payment.created\"]', 'active', ?, ?)",
      ).bind(now, now),
    ]);
    const key = await createApiKey(env, "mrc_created", "test", "Created event");
    const request = () =>
      SELF.fetch("https://payments.test/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "created-event-once",
        },
        body: JSON.stringify({ amount: "4.25", reference: "Atomic creation" }),
      });
    const first = await request();
    expect(first.status).toBe(201);
    const firstBody = await first.json<Record<string, unknown>>();
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: firstBody.id, idempotent_replay: true });

    const counts = await env.PAYMENTS_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM events WHERE type = 'payment.created') AS events, (SELECT COUNT(*) FROM payment_outbox) AS outbox, (SELECT COUNT(*) FROM webhook_deliveries) AS deliveries",
    ).first<{ events: number; outbox: number; deliveries: number }>();
    expect(counts).toEqual({ events: 1, outbox: 1, deliveries: 1 });
    const event = await env.PAYMENTS_DB.prepare(
      "SELECT object_id, payload FROM events WHERE type = 'payment.created'",
    ).first<{ object_id: string; payload: string }>();
    expect(event?.object_id).toBe(firstBody.id);
    expect(JSON.parse(event!.payload)).toMatchObject({
      id: firstBody.id,
      object: "payment_intent",
      status: "awaiting_payment",
      amount: "4.25",
    });
  });

  it("returns one resource for concurrent requests sharing an Idempotency-Key", async () => {
    await seedCheckout("concurrent-intent");
    const key = await createApiKey(env, "mrc_concurrent-intent", "test", "Concurrent");
    const request = () =>
      SELF.fetch("https://payments.test/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "same-concurrent-order",
        },
        body: JSON.stringify({ amount: "6.25", reference: "Concurrent order" }),
      });
    const responses = await Promise.all(Array.from({ length: 8 }, request));
    const bodies = await Promise.all(
      responses.map((response) => response.json<Record<string, unknown>>()),
    );
    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(
      true,
    );
    expect(new Set(bodies.map((body) => body.id))).toHaveLength(1);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ?",
      )
        .bind("mrc_concurrent-intent", "same-concurrent-order")
        .first(),
    ).toEqual({ count: 1 });
  });

  it("enforces idempotency without letting one reservation monopolize an intent", async () => {
    const { linkId } = await seedCheckout("active");
    const quoted = await quote(linkId);
    const first = await attempt(linkId, quoted, "idem-1");
    expect(first.status).toBe(201);
    const firstBody = await first.json<Record<string, unknown>>();
    expect(firstBody).toMatchObject({
      fee_snapshot: { policy_id: "free-default", platform_fee_bps: 0, platform_fee_atomic: "0" },
    });
    const feeRows = await env.PAYMENTS_DB.prepare(
      "SELECT fee_type, quoted_amount_atomic, actual_amount_atomic, status FROM payment_fee_ledger WHERE attempt_id = ? ORDER BY fee_type",
    )
      .bind(firstBody.id)
      .all<Record<string, unknown>>();
    expect(feeRows.results).toEqual([
      {
        fee_type: "network",
        quoted_amount_atomic: "0",
        actual_amount_atomic: "0",
        status: "waived",
      },
      {
        fee_type: "platform",
        quoted_amount_atomic: "0",
        actual_amount_atomic: "0",
        status: "waived",
      },
    ]);
    await expect(
      env.PAYMENTS_DB.prepare("UPDATE payment_attempts SET platform_fee_bps = 101 WHERE id = ?")
        .bind(firstBody.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.PAYMENTS_DB.prepare(
        "UPDATE payment_fee_ledger SET actual_amount_atomic = 'not-an-amount' WHERE attempt_id = ?",
      )
        .bind(firstBody.id)
        .run(),
    ).rejects.toThrow();
    const replay = await attempt(linkId, quoted, "idem-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: firstBody.id, idempotent_replay: true });
    const independent = await attempt(linkId, quoted, "idem-2");
    expect(independent.status).toBe(201);
    const independentBody = await independent.json<Record<string, unknown>>();
    expect(independentBody.id).not.toBe(firstBody.id);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_attempts WHERE intent_id = ? AND status = 'reserved'",
      )
        .bind("pi_active")
        .first(),
    ).toEqual({ count: 2 });
  });

  it("does not let an attacker reservation block a legitimate payer", async () => {
    const attacker = privateKeyToAccount(`0x${"33".repeat(32)}`);
    const attackerCapability = "C".repeat(43);
    const { linkId } = await seedCheckout("adversarial-reservation");
    const attackerQuote = await quote(
      linkId,
      421614,
      undefined,
      attacker.address,
      attackerCapability,
    );
    const attackerAttempt = await attempt(
      linkId,
      attackerQuote,
      "attacker-reservation",
      attackerCapability,
      attacker,
    );
    expect(attackerAttempt.status).toBe(201);

    const legitimateQuote = await quote(linkId);
    const legitimateAttempt = await attempt(linkId, legitimateQuote, "legitimate-reservation");
    expect(legitimateAttempt.status).toBe(201);
    const [attackerBody, legitimateBody] = await Promise.all([
      attackerAttempt.json<Record<string, unknown>>(),
      legitimateAttempt.json<Record<string, unknown>>(),
    ]);
    expect(attackerBody.id).not.toBe(legitimateBody.id);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_attempts WHERE intent_id = ? AND status = 'reserved'",
      )
        .bind("pi_adversarial-reservation")
        .first(),
    ).toEqual({ count: 2 });
  });

  it("does not let an attacker reservation block merchant cancellation", async () => {
    const attacker = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const attackerCapability = "D".repeat(43);
    const { linkId, intentId } = await seedCheckout("cancel-with-reservation");
    const key = await createApiKey(env, "mrc_cancel-with-reservation", "test", "Cancel");
    await env.PAYMENTS_DB.batch([
      env.PAYMENTS_DB.prepare(
        "UPDATE payment_intents SET amount_atomic = '0', amount_mode = 'payer_defined' WHERE id = ?",
      ).bind(intentId),
    ]);
    const attackerQuote = await quote(linkId, 421614, "10", attacker.address, attackerCapability);
    const attackerAttempt = await attempt(
      linkId,
      attackerQuote,
      "cancel-attacker",
      attackerCapability,
      attacker,
    );
    expect(attackerAttempt.status).toBe(201);
    const attackerBody = await attackerAttempt.json<Record<string, unknown>>();

    const canceled = await SELF.fetch(
      `https://payments.test/v1/payment_intents/${intentId}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key.secret}` },
      },
    );
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({ id: intentId, status: "canceled" });
    expect(
      (
        await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/quotes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payer,
            source_chain_id: 421614,
            amount: "10",
            attempt_capability_hash: await hashCheckoutCapability(checkoutCapability),
          }),
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await settleAttempt(env, {
          attemptId: String(attackerBody.id),
          sourceTxHash: `0x${"43".repeat(32)}`,
          settledAmountAtomic: "10000000",
          payerAddress: attacker.address,
        })
      ).applied,
    ).toBe(true);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT amount_atomic, status, paid_amount_atomic FROM payment_intents WHERE id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ amount_atomic: "10000000", status: "paid", paid_amount_atomic: "10000000" });
    expect(await getPaymentLink(env, linkId)).toMatchObject({ amount: "10", status: "paid" });
  });

  it("requires wallet proof and a scoped capability for public attempts", async () => {
    const { linkId } = await seedCheckout("checkout-access");
    const quoted = await quote(linkId);
    const missingProof = await SELF.fetch(`https://payments.test/checkout/v1/${linkId}/attempts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "missing-proof",
        "X-GatoPago-Checkout-Capability": checkoutCapability,
      },
      body: JSON.stringify({ quote_id: quoted.id }),
    });
    expect(missingProof.status).toBe(400);
    expect(await missingProof.json()).toMatchObject({ error_code: "AUTHORIZATION_INVALID" });
    expect(
      await env.PAYMENTS_DB.prepare("SELECT COUNT(*) AS count FROM payment_attempts").first(),
    ).toEqual({ count: 0 });

    const created = await attempt(linkId, quoted, "protected-attempt");
    expect(created.status).toBe(201);
    const body = await created.json<Record<string, unknown>>();
    const attemptId = String(body.id);
    const publicRead = await SELF.fetch(
      `https://payments.test/checkout/v1/${linkId}/attempts/${attemptId}`,
    );
    expect(publicRead.status).toBe(404);
    const wrongCapability = "B".repeat(43);
    const wrongRead = await SELF.fetch(
      `https://payments.test/checkout/v1/${linkId}/attempts/${attemptId}`,
      {
        headers: { "X-GatoPago-Checkout-Capability": wrongCapability },
      },
    );
    expect(wrongRead.status).toBe(404);

    const replayWithWrongCapability = await attempt(
      linkId,
      quoted,
      "protected-attempt",
      wrongCapability,
    );
    expect(replayWithWrongCapability.status).toBe(404);
    const independent = await attempt(linkId, quoted, "another-protected-attempt");
    expect(independent.status).toBe(201);
    const independentBody = await independent.json<Record<string, unknown>>();
    expect(independentBody.id).not.toBe(attemptId);
    expect(JSON.stringify(independentBody)).not.toContain(String(body.authorization_hash));
  });

  it("does not accept unverified hashes, uses compare-and-set, and releases stale submitted attempts", async () => {
    const { linkId } = await seedCheckout("registration-cas");
    const quoted = await quote(linkId);
    const created = await attempt(linkId, quoted, "registration-cas-attempt");
    const body = await created.json<Record<string, unknown>>();
    const attemptId = String(body.id);
    const firstHash = `0x${"31".repeat(32)}`;
    const secondHash = `0x${"32".repeat(32)}`;
    const register = (capability: string, sourceTxHash: string) =>
      SELF.fetch(`https://payments.test/checkout/v1/${linkId}/attempts/${attemptId}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GatoPago-Checkout-Capability": capability,
        },
        body: JSON.stringify({ source_tx_hash: sourceTxHash }),
      });

    const spoofed = await SELF.fetch(
      `https://payments.test/checkout/v1/${linkId}/attempts/${attemptId}/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GatoPago-Checkout-Capability": checkoutCapability,
        },
        body: JSON.stringify({ payer: merchantWallet, source_tx_hash: firstHash }),
      },
    );
    expect(spoofed.status).toBe(400);
    expect(await spoofed.json()).toMatchObject({ error_code: "INVALID_CALLDATA" });
    expect((await register("B".repeat(43), firstHash)).status).toBe(404);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, source_tx_hash FROM payment_attempts WHERE id = ?",
      )
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "reserved", source_tx_hash: null });

    const unavailable = await register(checkoutCapability, firstHash);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error_code: "SERVICE_UNAVAILABLE",
      retryable: true,
    });
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, source_tx_hash FROM payment_attempts WHERE id = ?",
      )
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "reserved", source_tx_hash: null });

    const capabilityHash = await hashCheckoutCapability(checkoutCapability);
    expect(
      await registerSourceTransaction(env, { attemptId, capabilityHash, txHash: firstHash }),
    ).toMatchObject({ id: attemptId, sourceTxHash: firstHash, status: "submitted" });
    expect(
      await registerSourceTransaction(env, { attemptId, capabilityHash, txHash: secondHash }),
    ).toBeNull();
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, source_tx_hash FROM payment_attempts WHERE id = ?",
      )
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "submitted", source_tx_hash: firstHash });

    await env.PAYMENTS_DB.prepare("UPDATE payment_attempts SET valid_until = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 16 * 60, attemptId)
      .run();
    expect((await SELF.fetch(`https://payments.test/checkout/v1/${linkId}`)).status).toBe(200);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, last_error_code FROM payment_attempts WHERE id = ?",
      )
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "expired", last_error_code: "PAYMENT_EVIDENCE_TIMEOUT" });
  });

  it("keeps an expired authorization observable during the receipt evidence grace window", async () => {
    const { linkId } = await seedCheckout("reserved-grace");
    const quoted = await quote(linkId);
    const created = await attempt(linkId, quoted, "reserved-grace-attempt");
    const body = await created.json<Record<string, unknown>>();
    const attemptId = String(body.id);
    await env.PAYMENTS_DB.prepare("UPDATE payment_attempts SET valid_until = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 60, attemptId)
      .run();

    expect((await SELF.fetch(`https://payments.test/checkout/v1/${linkId}`)).status).toBe(200);
    expect(
      await env.PAYMENTS_DB.prepare("SELECT status FROM payment_attempts WHERE id = ?")
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "reserved" });

    await env.PAYMENTS_DB.prepare("UPDATE payment_attempts SET valid_until = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 16 * 60, attemptId)
      .run();
    expect((await SELF.fetch(`https://payments.test/checkout/v1/${linkId}`)).status).toBe(200);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, last_error_code FROM payment_attempts WHERE id = ?",
      )
        .bind(attemptId)
        .first(),
    ).toEqual({ status: "expired", last_error_code: "PAYMENT_EVIDENCE_TIMEOUT" });
  });

  it("lets the proven checkout session cancel an unbroadcast reservation immediately", async () => {
    const { linkId } = await seedCheckout("cancel-capability");
    const quoted = await quote(linkId);
    const created = await attempt(linkId, quoted, "cancel-capability-attempt");
    const body = await created.json<Record<string, unknown>>();
    const response = await SELF.fetch(
      `https://payments.test/checkout/v1/attempts/${body.id as string}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GatoPago-Checkout-Capability": checkoutCapability,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: body.id, status: "canceled" });
  });

  it("rejects stale fees and disabled chains", async () => {
    const { linkId } = await seedCheckout("stale");
    const quoted = await quote(linkId);
    await env.PAYMENTS_DB.prepare(
      "UPDATE payment_quotes SET fee_observed_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(
        new Date(Date.now() - 10 * 60_000).toISOString(),
        new Date(Date.now() - 1_000).toISOString(),
        quoted.id,
      )
      .run();
    const stale = await attempt(linkId, quoted, "stale-1");
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error_code: "QUOTE_STALE" });
    const disabled = await quote(linkId, 999999);
    expect(disabled).toMatchObject({ error_code: "CHAIN_DISABLED" });
  });

  it("makes duplicate Queue deliveries and settlements economically inert", async () => {
    const { linkId } = await seedCheckout("dedupe");
    const quoted = await quote(linkId);
    const created = await attempt(linkId, quoted, "dedupe-attempt");
    const createdBody = await created.json<Record<string, unknown>>();
    const messageBody = {
      messageVersion: 2 as const,
      job: "attempt_reconcile" as const,
      jobId: "job-1",
      dedupeKey: "router:dedupe",
      resourceId: createdBody.id as string,
      partition: "421614",
      attempt: 0,
      createdAt: new Date().toISOString(),
    };
    const makeMessage = () => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: messageBody,
      attempts: 1,
      ack() {},
      retry() {},
    });
    await consumePaymentQueue(
      { queue: "test", messages: [makeMessage()] } as unknown as MessageBatch<unknown>,
      env,
    );
    await consumePaymentQueue(
      { queue: "test", messages: [makeMessage()] } as unknown as MessageBatch<unknown>,
      env,
    );
    const runs = await env.PAYMENTS_DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_job_runs WHERE dedupe_key = 'router:dedupe'",
    ).first<{ count: number }>();
    expect(runs?.count).toBe(1);

    await env.PAYMENTS_DB.prepare(
      "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, status, created_at, updated_at) SELECT 'whe_dedupe', merchant_id, 'https://webhook.example/receive', 'nonce.ciphertext', 'test', 'active', created_at, updated_at FROM payment_intents WHERE id = 'pi_dedupe'",
    ).run();
    const firstSettlement = await settleAttempt(env, {
      attemptId: createdBody.id as string,
      sourceTxHash: `0x${"12".repeat(32)}`,
      settledAmountAtomic: "10000000",
      payerAddress: payer,
    });
    const replaySettlement = await settleAttempt(env, {
      attemptId: createdBody.id as string,
      sourceTxHash: `0x${"12".repeat(32)}`,
      settledAmountAtomic: "10000000",
      payerAddress: payer,
    });
    expect(firstSettlement.applied).toBe(true);
    expect(replaySettlement.applied).toBe(false);
    const counts = await env.PAYMENTS_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM webhook_deliveries) AS deliveries",
    ).first<{ events: number; deliveries: number }>();
    expect(counts).toEqual({ events: 1, deliveries: 1 });
    const event = await env.PAYMENTS_DB.prepare("SELECT payload FROM events LIMIT 1").first<{
      payload: string;
    }>();
    expect(JSON.parse(event!.payload)).toMatchObject({
      fee_breakdown: {
        currency: "USDC",
        total_quoted_atomic: "0",
        total_actual_atomic: "0",
        platform: { status: "waived", actual_amount_atomic: "0" },
        network: { status: "waived", actual_amount_atomic: "0" },
      },
    });
  });

  it("serializes concurrent settlements without losing paid value", async () => {
    const { linkId, intentId } = await seedCheckout("settlement-cas");
    const quoted = await quote(linkId);
    const first = await attempt(linkId, quoted, "settlement-cas-first");
    const second = await attempt(linkId, quoted, "settlement-cas-second");
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstBody, secondBody] = await Promise.all([
      first.json<Record<string, unknown>>(),
      second.json<Record<string, unknown>>(),
    ]);

    const results = await Promise.all([
      settleAttempt(env, {
        attemptId: String(firstBody.id),
        sourceTxHash: `0x${"51".repeat(32)}`,
        settledAmountAtomic: "10000000",
        payerAddress: payer,
      }),
      settleAttempt(env, {
        attemptId: String(secondBody.id),
        sourceTxHash: `0x${"52".repeat(32)}`,
        settledAmountAtomic: "10000000",
        payerAddress: payer,
      }),
    ]);
    expect(results.every((result) => result.applied)).toBe(true);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, paid_amount_atomic FROM payment_intents WHERE id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ status: "overpaid", paid_amount_atomic: "20000000" });
    const attempts = await env.PAYMENTS_DB.prepare(
      "SELECT status FROM payment_attempts WHERE intent_id = ? ORDER BY status",
    )
      .bind(intentId)
      .all<{ status: string }>();
    expect(attempts.results.map((row) => row.status).sort()).toEqual(["overpaid", "paid"]);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_settlement_commits WHERE intent_id = ?",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE object_id = ? AND type IN ('payment.paid','payment.overpaid')",
      )
        .bind(intentId)
        .first(),
    ).toEqual({ count: 2 });

    const replay = await settleAttempt(env, {
      attemptId: String(firstBody.id),
      sourceTxHash: `0x${"51".repeat(32)}`,
      settledAmountAtomic: "10000000",
      payerAddress: payer,
    });
    expect(replay.applied).toBe(false);
    expect(
      await env.PAYMENTS_DB.prepare("SELECT paid_amount_atomic FROM payment_intents WHERE id = ?")
        .bind(intentId)
        .first(),
    ).toEqual({ paid_amount_atomic: "20000000" });
  });

  it("records the actual delivered amount and exposes CCTP-style overpayment coherently", async () => {
    const { linkId, intentId } = await seedCheckout("actual-mint");
    const quoted = await quote(linkId);
    const created = await attempt(linkId, quoted, "actual-mint-attempt");
    const createdBody = await created.json<Record<string, unknown>>();
    const result = await settleAttempt(env, {
      attemptId: createdBody.id as string,
      sourceTxHash: `0x${"78".repeat(32)}`,
      destinationTxHash: `0x${"90".repeat(32)}`,
      settledAmountAtomic: "10010000",
      payerAddress: payer,
    });
    expect(result.applied).toBe(true);
    const stored = await env.PAYMENTS_DB.prepare(
      "SELECT status, paid_amount_atomic FROM payment_intents WHERE id = ?",
    )
      .bind(intentId)
      .first();
    expect(stored).toEqual({ status: "overpaid", paid_amount_atomic: "10010000" });
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, settled_amount_atomic FROM payment_attempts WHERE id = ?",
      )
        .bind(createdBody.id)
        .first(),
    ).toEqual({ status: "overpaid", settled_amount_atomic: "10010000" });
    const event = await env.PAYMENTS_DB.prepare(
      "SELECT type, payload FROM events WHERE object_id = ? AND type = 'payment.overpaid'",
    )
      .bind(intentId)
      .first<{ type: string; payload: string }>();
    expect(JSON.parse(event!.payload)).toMatchObject({
      expected_amount_atomic: "10000000",
      settled_amount_atomic: "10010000",
      paid_amount_atomic: "10010000",
      overpaid_amount_atomic: "10000",
    });
  });

  it("rejects router watch jobs that use attempt IDs", async () => {
    const body = {
      messageVersion: 2 as const,
      job: "router_watch" as const,
      jobId: "job-retired-router",
      dedupeKey: "retired:router",
      resourceId: "pa_retired",
      partition: "421614",
      attempt: 0,
      createdAt: new Date().toISOString(),
    };
    const batch = createMessageBatch(env.PAYMENT_JOBS_QUEUE_NAME, [
      { id: "retired-router", timestamp: new Date(), body, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await new FlowWorker(ctx, env).queue(batch);
    expect(await getQueueResult(batch, ctx)).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: "retired-router" }],
    });
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, last_error FROM payment_job_runs WHERE dedupe_key = ?",
      )
        .bind(body.dedupeKey)
        .first(),
    ).toEqual({ status: "failed", last_error: "Invalid router watch chain ID" });
  });

  it("retries a redelivery held by a live lease instead of acknowledging lost work", async () => {
    const timestamp = new Date().toISOString();
    const lease = new Date(Date.now() + 16 * 60_000).toISOString();
    const body = {
      messageVersion: 2 as const,
      job: "attempt_reconcile" as const,
      jobId: "job-crashed",
      dedupeKey: "crash:redelivery",
      resourceId: "rotation_crashed",
      partition: "default",
      attempt: 0,
      createdAt: timestamp,
    };
    await env.PAYMENTS_DB.prepare(
      "INSERT INTO payment_job_runs(dedupe_key, job_id, job, resource_id, status, lease_expires_at, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', ?, 1, ?, ?)",
    )
      .bind(body.dedupeKey, body.jobId, body.job, body.resourceId, lease, timestamp, timestamp)
      .run();

    let acknowledgements = 0;
    let retryDelay = 0;
    const message = {
      id: "queue-redelivery",
      timestamp: new Date(),
      body,
      attempts: 2,
      ack() {
        acknowledgements += 1;
      },
      retry(options?: { delaySeconds?: number }) {
        retryDelay = options?.delaySeconds ?? 0;
      },
    };
    await consumePaymentQueue(
      { queue: "test", messages: [message] } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(acknowledgements).toBe(0);
    expect(retryDelay).toBeGreaterThan(0);
    expect(retryDelay).toBeLessThanOrEqual(900);

    await env.PAYMENTS_DB.prepare(
      "UPDATE payment_job_runs SET lease_expires_at = ? WHERE dedupe_key = ?",
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), body.dedupeKey)
      .run();
    await consumePaymentQueue(
      { queue: "test", messages: [message] } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(acknowledgements).toBe(1);
    expect(
      await env.PAYMENTS_DB.prepare("SELECT status FROM payment_job_runs WHERE dedupe_key = ?")
        .bind(body.dedupeKey)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("allows only one concurrent CCTP signer lease per chain and signer", async () => {
    const key = "cctp-mint:421614:0x00000000000000000000000000000000000000aa";
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => acquirePaymentSignerLease(env, key, 120_000)),
    );
    const winners = contenders.filter((owner): owner is string => typeof owner === "string");
    expect(winners).toHaveLength(1);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_signer_leases WHERE lease_key = ?",
      )
        .bind(key)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    await releasePaymentSignerLease(env, key, winners[0]!);
    expect(await acquirePaymentSignerLease(env, key, 120_000)).toEqual(expect.any(String));
  });

  it("reclaims an expired processing webhook lease", async () => {
    await seedCheckout("expired-webhook");
    const timestamp = new Date().toISOString();
    const expired = new Date(Date.now() - 1_000).toISOString();
    await env.PAYMENTS_DB.batch([
      env.PAYMENTS_DB.prepare(
        "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, status, created_at, updated_at) VALUES ('whe_expired', 'mrc_expired-webhook', 'https://webhook.example/expired', 'invalid.ciphertext', 'runtime-test', 'active', ?, ?)",
      ).bind(timestamp, timestamp),
      env.PAYMENTS_DB.prepare(
        "INSERT INTO events(id, merchant_id, type, object_id, mode, payload, created_at) VALUES ('evt_expired', 'mrc_expired-webhook', 'payment.paid', 'pi_expired-webhook', 'test', '{}', ?)",
      ).bind(timestamp),
      env.PAYMENTS_DB.prepare(
        "INSERT INTO webhook_deliveries(id, event_id, endpoint_id, status, next_retry_at, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('whd_expired', 'evt_expired', 'whe_expired', 'processing', ?, 'crashed-worker', ?, ?, ?)",
      ).bind(expired, expired, timestamp, timestamp),
    ]);
    expect(await listWebhookDeliveryJobs(env, "evt_expired")).toHaveLength(1);
    const nextLease = new Date(Date.now() + 30_000).toISOString();
    expect(await claimWebhookDelivery(env, "whd_expired", "recovery-worker", nextLease)).toBe(true);
    expect(
      await env.PAYMENTS_DB.prepare(
        "SELECT status, lease_owner, lease_expires_at FROM webhook_deliveries WHERE id = 'whd_expired'",
      ).first(),
    ).toEqual({
      status: "processing",
      lease_owner: "recovery-worker",
      lease_expires_at: nextLease,
    });
  });

  it("rejects webhook ciphertext without the current authenticated envelope", async () => {
    const encrypted = await encryptWebhookSecret(env, "whsec_strict-envelope");
    const payload = encrypted.ciphertext.split(":").slice(3).join(":");
    for (const obsolete of [
      payload,
      encrypted.ciphertext.replace("enc:v2:", "enc:v1:"),
      `${encrypted.ciphertext}.extra`,
    ]) {
      await expect(decryptWebhookSecret(env, obsolete, encrypted.keyId)).rejects.toThrow(
        "Invalid webhook ciphertext",
      );
    }
    await expect(decryptWebhookSecret(env, encrypted.ciphertext, "wrong-key-id")).rejects.toThrow(
      "key ID mismatch",
    );
    expect(await decryptWebhookSecret(env, encrypted.ciphertext, encrypted.keyId)).toBe(
      "whsec_strict-envelope",
    );
    await expect(
      encryptWebhookSecret(
        { ...env, WEBHOOK_SECRET_ENCRYPTION_KEY: "ab".repeat(32) },
        "whsec_hex-key",
      ),
    ).rejects.toThrow("must be 32 bytes");
  });

  it("rotates webhook keys within the current ciphertext format using compare-and-set", async () => {
    await seedCheckout("key-rotation");
    const oldEnv = {
      WEBHOOK_SECRET_ENCRYPTION_KEY: btoa("abcdef0123456789abcdef0123456789"),
      WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "runtime-old",
      WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: "{}",
    } as Bindings;
    const secret = "whsec_rotation-survives";
    const encrypted = await encryptWebhookSecret(oldEnv, secret);
    const timestamp = new Date().toISOString();
    await env.PAYMENTS_DB.prepare(
      "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, status, created_at, updated_at) VALUES ('whe_rotate', 'mrc_key-rotation', 'https://webhook.example/rotate', ?, ?, 'active', ?, ?)",
    )
      .bind(encrypted.ciphertext, encrypted.keyId, timestamp, timestamp)
      .run();
    expect(await decryptWebhookSecret(env, encrypted.ciphertext, "runtime-old")).toBe(secret);
    expect(await rotateWebhookEncryptionBatch(env, 25)).toEqual({
      scanned: 1,
      rotated: 1,
      remaining: 0,
    });
    const rotated = await env.PAYMENTS_DB.prepare(
      "SELECT secret_ciphertext, secret_key_id FROM webhook_endpoints WHERE id = 'whe_rotate'",
    ).first<{ secret_ciphertext: string; secret_key_id: string }>();
    expect(rotated?.secret_key_id).toBe("runtime-test");
    expect(rotated?.secret_ciphertext).toMatch(/^enc:v2:runtime-test:/u);
    expect(
      await decryptWebhookSecret(env, rotated!.secret_ciphertext, rotated!.secret_key_id),
    ).toBe(secret);
  });

  it("coalesces delayed work durably by payment partition", async () => {
    const partition = `runtime-${crypto.randomUUID()}`;
    const stub = env.PAYMENT_JOB_SCHEDULER.getByName(partition);
    const earlier = Date.now() + 30_000;
    const first = await stub.schedule({
      job: "cctp_attestation",
      resourceId: "op_runtime",
      dedupeKey: "cctp-attestation:op_runtime",
      partition,
      runAt: earlier,
    });
    const second = await stub.schedule({
      job: "cctp_attestation",
      resourceId: "op_runtime",
      dedupeKey: "cctp-attestation:op_runtime",
      partition,
      runAt: earlier + 30_000,
    });
    expect(first).toEqual({ accepted: true, generation: 1, runAt: earlier });
    expect(second).toEqual({ accepted: true, generation: 2, runAt: earlier });
    await stub.schedule({
      job: "attempt_reconcile",
      resourceId: "missing_runtime_attempt",
      dedupeKey: "reconcile:runtime",
      partition,
      runAt: 0,
    });
    await runInDurableObject(stub, async (instance) => {
      if (typeof instance.alarm !== "function") {
        throw new Error("PaymentJobScheduler alarm handler is missing");
      }
      await instance.alarm();
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get<{ generation: number; runAt: number }>(
        `job:cctp_attestation:${partition}:op_runtime`,
      );
      expect(stored).toMatchObject({ generation: 2, runAt: earlier });
      expect(
        await state.storage.get(`job:attempt_reconcile:${partition}:missing_runtime_attempt`),
      ).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(earlier);
    });
  });
});

describe("settlement account commands", () => {
  const base = {
    commandId: "settlement-command",
    ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
    accountVersion: 1,
    walletAddress: merchantWallet,
    chainId: 421614,
  } satisfies Parameters<typeof upsertSettlementAccount>[1];

  it("returns the original result after a later version has been applied", async () => {
    const first = await upsertSettlementAccount(env, base);
    await upsertSettlementAccount(env, {
      ...base,
      commandId: "newer",
      accountVersion: 2,
      walletAddress: payer,
    });
    expect(await upsertSettlementAccount(env, base)).toEqual(first);
    expect(await getMerchantByOwner(env, base.ownerUserId)).toMatchObject({
      accountVersion: 2,
      settlementWallet: payer.toLowerCase(),
    });
  });

  it.each([
    { ownerUserId: "another-owner" },
    { accountVersion: 2 },
    { walletAddress: payer },
    { chainId: 84532 },
  ])("rejects command ID reuse with changed fields: %j", async (change) => {
    await upsertSettlementAccount(env, base);
    await expect(upsertSettlementAccount(env, { ...base, ...change })).rejects.toBeInstanceOf(
      SettlementAccountConflict,
    );
    expect(await getMerchantByOwner(env, base.ownerUserId)).toMatchObject({
      accountVersion: 1,
      settlementWallet: merchantWallet.toLowerCase(),
    });
    expect(await getMerchantByOwner(env, "another-owner")).toBeNull();
  });

  it("keeps concurrent duplicate commands idempotent", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => upsertSettlementAccount(env, base)),
    );
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    expect(
      await env.PAYMENTS_DB.prepare("SELECT count(*) AS n FROM settlement_account_commands").first(
        "n",
      ),
    ).toBe(1);
  });

  it("records version decisions atomically and never downgrades the account", async () => {
    await upsertSettlementAccount(env, base);
    const newer = { ...base, commandId: "version-3", accountVersion: 3, walletAddress: payer };
    const older = { ...base, commandId: "version-2", accountVersion: 2 };
    const [newerResult, olderResult] = await Promise.all([
      upsertSettlementAccount(env, newer),
      upsertSettlementAccount(env, older),
    ]);
    expect(newerResult.applied).toBe(true);
    expect(await getMerchantByOwner(env, base.ownerUserId)).toMatchObject({
      accountVersion: 3,
      settlementWallet: payer.toLowerCase(),
    });
    expect(await upsertSettlementAccount(env, older)).toEqual(olderResult);
    const recorded = await env.PAYMENTS_DB.prepare(
      "SELECT account_version, applied FROM settlement_account_commands ORDER BY rowid",
    ).all<{ account_version: number; applied: number }>();
    let version = 0;
    for (const row of recorded.results) {
      expect(row.applied).toBe(row.account_version > version ? 1 : 0);
      version = Math.max(version, row.account_version);
    }
    expect(await upsertSettlementAccount(env, { ...base, commandId: "stale" })).toMatchObject({
      applied: false,
    });
  });

  it("rolls back the command record when the account write fails", async () => {
    await env.PAYMENTS_DB.exec(
      "CREATE TRIGGER reject_account_insert BEFORE INSERT ON merchants BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;",
    );
    try {
      await expect(upsertSettlementAccount(env, base)).rejects.toThrow();
      expect(
        await env.PAYMENTS_DB.prepare(
          "SELECT count(*) AS n FROM settlement_account_commands",
        ).first("n"),
      ).toBe(0);
    } finally {
      await env.PAYMENTS_DB.exec("DROP TRIGGER reject_account_insert;");
    }
    expect(await upsertSettlementAccount(env, base)).toMatchObject({ applied: true });
  });

  it("reports conflicting RPC retries explicitly", async () => {
    const commands = new PaymentCommands(env);
    const command = {
      contractVersion: 3 as const,
      commandId: base.commandId,
      claim: {
        service: "gatopago-wallet-core" as const,
        requestId: "request-1",
        userId: base.ownerUserId,
      },
      walletAddress: base.walletAddress,
      accountVersion: 1,
      chainId: base.chainId,
    };
    expect(await commands.upsertSettlementAccount(command)).toMatchObject({ ok: true });
    expect(await commands.upsertSettlementAccount({ ...command, accountVersion: 2 })).toMatchObject(
      { ok: false, error: "CONFLICT" },
    );
  });
});

it("dispatches the configured runtime queue through the Worker entrypoint", async () => {
  const ctx = createExecutionContext();
  const batch = createMessageBatch(env.PAYMENT_JOBS_QUEUE_NAME, [
    {
      id: "queue-routing",
      timestamp: new Date(),
      attempts: 1,
      body: {
        messageVersion: 2,
        job: "webhook_delivery",
        jobId: "routing-job",
        dedupeKey: "routing-key",
        resourceId: "event-without-deliveries",
        partition: "default",
        attempt: 0,
        createdAt: new Date().toISOString(),
      },
    },
  ]);
  const worker = new FlowWorker(ctx, env);
  await worker.queue(batch);
  const result = await getQueueResult(batch, ctx);
  expect(result.retryBatch.retry).toBe(false);
  expect(result.retryMessages).toEqual([]);
  expect(
    await env.PAYMENTS_DB.prepare("SELECT status FROM payment_job_runs WHERE dedupe_key = ?")
      .bind("routing-key")
      .first("status"),
  ).toBe("completed");
});
