import type { PaymentJobMessage } from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";
import { nowIso } from "../stores/db";
import {
  listDuePaymentOutbox,
  markPaymentOutboxEnqueued,
  markPaymentOutboxFailed,
} from "../stores/outboxStore";

type PaymentJobInput = {
  job: PaymentJobMessage["job"];
  resourceId: string;
  dedupeKey?: string;
  partition?: string;
};

function paymentJobMessage(input: PaymentJobInput): PaymentJobMessage {
  return {
    messageVersion: 2,
    job: input.job,
    jobId: crypto.randomUUID(),
    dedupeKey: input.dedupeKey ?? `${input.job}:${input.resourceId}`,
    resourceId: input.resourceId,
    partition: input.partition ?? "default",
    attempt: 0,
    createdAt: nowIso(),
  };
}

export async function enqueuePaymentJob(env: Bindings, input: PaymentJobInput): Promise<void> {
  if (!env.PAYMENT_JOBS_QUEUE) {
    throw new Error("Payment jobs Queue is unavailable");
  }
  await env.PAYMENT_JOBS_QUEUE.send(paymentJobMessage(input), { contentType: "json" });
}

export async function schedulePaymentJob(
  env: Bindings,
  input: PaymentJobInput & { delaySeconds: number },
): Promise<void> {
  if (!Number.isSafeInteger(input.delaySeconds) || input.delaySeconds < 0) {
    throw new Error("Payment job delaySeconds must be a non-negative integer");
  }
  if (!env.PAYMENT_JOB_SCHEDULER) {
    throw new Error("Payment job scheduler is unavailable");
  }
  const partition = input.partition ?? "default";
  const scheduler = env.PAYMENT_JOB_SCHEDULER.getByName(partition);
  await scheduler.schedule({
    job: input.job,
    resourceId: input.resourceId,
    dedupeKey: input.dedupeKey ?? `${input.job}:${input.resourceId}`,
    partition,
    runAt: Date.now() + input.delaySeconds * 1_000,
  });
}

export async function flushPaymentOutbox(env: Bindings, limit = 50): Promise<number> {
  if (!env.PAYMENT_JOBS_QUEUE) {
    throw new Error("Payment jobs Queue is unavailable");
  }
  const due = await listDuePaymentOutbox(env, limit);
  let published = 0;
  for (const row of due) {
    try {
      await enqueuePaymentJob(env, {
        job: row.topic,
        resourceId: row.resource_id,
        dedupeKey: `outbox:${row.id}`,
      });
      await markPaymentOutboxEnqueued(env, row.id);
      published += 1;
    } catch (error) {
      const attempt = row.attempt_count + 1;
      await markPaymentOutboxFailed(env, row.id, attempt);
      throw error;
    }
  }
  return published;
}
