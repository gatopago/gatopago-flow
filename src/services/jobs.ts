import type { Bindings } from "../env";
import { parsePaymentJobMessage, type PaymentJobMessage } from "@gatopago/shared/payment-contracts";
import { decryptWebhookSecret } from "../repositories/merchant";
import { logError, logWarn } from "./logger";
import {
  advanceCctpAttestation,
  mintCctpSettlement,
  reconcileAttempt,
  scanPaymentRouters,
} from "./reconciliation";
import {
  claimPaymentJob,
  claimWebhookDelivery,
  completePaymentJob,
  failPaymentJob,
  listWebhookDeliveryJobs,
  recordWebhookNetworkFailure,
  recordWebhookResponse,
  type WebhookDeliveryJob,
} from "../stores/jobStore";

const UNKNOWN_QUEUE_RETRY_SECONDS = 15;

async function hmac(secret: string, body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deliverOne(env: Bindings, delivery: WebhookDeliveryJob): Promise<boolean> {
  const leaseOwner = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  if (!(await claimWebhookDelivery(env, delivery.id, leaseOwner, leaseUntil))) {
    return false;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    data: JSON.parse(delivery.payload),
  });
  const secret = await decryptWebhookSecret(
    env,
    delivery.secret_ciphertext,
    delivery.secret_key_id,
  );
  let response: Response;
  try {
    response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "GatoPago-Timestamp": timestamp,
        "GatoPago-Signature": `v1=${await hmac(secret, body, timestamp)}`,
        "GatoPago-Event-Id": delivery.event_id,
        "GatoPago-Delivery-Id": delivery.id,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const attempts = delivery.attempt_count + 1;
    await recordWebhookNetworkFailure(env, { id: delivery.id, leaseOwner, attempts, error });
    throw error;
  }
  await response.body?.cancel();
  if (response.ok) {
    await recordWebhookResponse(env, {
      id: delivery.id,
      leaseOwner,
      attempts: delivery.attempt_count + 1,
      statusCode: response.status,
      delivered: true,
    });
    return true;
  }
  const attempts = delivery.attempt_count + 1;
  await recordWebhookResponse(env, {
    id: delivery.id,
    leaseOwner,
    attempts,
    statusCode: response.status,
    delivered: false,
  });
  throw new Error(`Webhook returned HTTP ${response.status}`);
}

async function runPaymentJob(env: Bindings, message: PaymentJobMessage): Promise<void> {
  if (message.job === "webhook_delivery") {
    let leasePending = false;
    for (const delivery of await listWebhookDeliveryJobs(env, message.resourceId)) {
      if (!(await deliverOne(env, delivery))) {
        leasePending = true;
      }
    }
    if (leasePending) {
      throw new Error("WEBHOOK_DELIVERY_LEASE_PENDING");
    }
    return;
  }
  let completed = true;
  if (message.job === "attempt_reconcile") {
    completed = await reconcileAttempt(env, message.resourceId);
  } else if (message.job === "router_watch") {
    const chainId = Number(message.resourceId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || String(chainId) !== message.resourceId) {
      throw new Error("Invalid router watch chain ID");
    }
    completed = await scanPaymentRouters(env, chainId);
  } else if (message.job === "cctp_attestation") {
    completed = await advanceCctpAttestation(env, message.resourceId);
  } else if (message.job === "cctp_mint") {
    completed = await mintCctpSettlement(env, message.resourceId);
  }
  if (!completed) {
    throw new Error("PAYMENT_EVIDENCE_PENDING");
  }
}

export async function consumePaymentQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
): Promise<void> {
  for (const queueMessage of batch.messages) {
    const parsed = parsePaymentJobMessage(queueMessage.body);
    if (!parsed) {
      logWarn("payment_queue_message_rejected", { messageId: queueMessage.id });
      queueMessage.ack();
      continue;
    }
    try {
      const claim = await claimPaymentJob(env, parsed);
      if (claim.state === "completed") {
        // Also repairs the outbox status if Queue publish succeeded but the
        // producer crashed before marking the row as enqueued.
        await completePaymentJob(env, parsed.dedupeKey);
        queueMessage.ack();
        continue;
      }
      if (claim.state === "leased") {
        queueMessage.retry({ delaySeconds: Math.min(900, claim.retryAfterSeconds) });
        continue;
      }
      await runPaymentJob(env, parsed);
      await completePaymentJob(env, parsed.dedupeKey);
      queueMessage.ack();
    } catch (error) {
      await failPaymentJob(env, parsed.dedupeKey, error);
      logError("payment_job_failed", error, { job: parsed.job, resourceId: parsed.resourceId });
      queueMessage.retry({
        delaySeconds: Math.min(900, 15 * 2 ** Math.min(queueMessage.attempts - 1, 6)),
      });
    }
  }
}

export async function consumeFlowQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  if (batch.queue === env.PAYMENT_JOBS_QUEUE_NAME) {
    await consumePaymentQueue(batch, env);
    return;
  }
  logWarn("payment_worker_queue_rejected", {
    queue: batch.queue,
    reason: "unknown_queue",
    retryDelaySeconds: UNKNOWN_QUEUE_RETRY_SECONDS,
  });
  batch.retryAll({ delaySeconds: UNKNOWN_QUEUE_RETRY_SECONDS });
}
