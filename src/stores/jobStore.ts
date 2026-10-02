import type { PaymentJobMessage } from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";
import { changed, first, nowIso, run } from "./db";

const JOB_LEASE_MS = 16 * 60_000;

type JobClaim =
  { state: "claimed" } | { state: "completed" } | { state: "leased"; retryAfterSeconds: number };

type JobRun = { status: "processing" | "completed" | "failed"; lease_expires_at: string | null };

export async function claimPaymentJob(
  env: Bindings,
  message: PaymentJobMessage,
): Promise<JobClaim> {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const lease = new Date(now + JOB_LEASE_MS).toISOString();
  const inserted = await run(
    env,
    "INSERT OR IGNORE INTO payment_job_runs(dedupe_key, job_id, job, resource_id, " +
      "status, lease_expires_at, attempt_count, created_at, updated_at) VALUES (?, " +
      "?, ?, ?, 'processing', ?, 1, ?, ?)",
    [
      message.dedupeKey,
      message.jobId,
      message.job,
      message.resourceId,
      lease,
      timestamp,
      timestamp,
    ],
  );
  if (changed(inserted)) {
    return { state: "claimed" };
  }

  const existing = await first<JobRun>(
    env,
    "SELECT status, lease_expires_at FROM payment_job_runs WHERE dedupe_key = ? LIMIT 1",
    [message.dedupeKey],
  );
  if (existing?.status === "completed") {
    return { state: "completed" };
  }
  const leaseExpiresAt = existing?.lease_expires_at ? Date.parse(existing.lease_expires_at) : 0;
  if (existing?.status === "processing" && leaseExpiresAt > now) {
    return {
      state: "leased",
      retryAfterSeconds: Math.max(1, Math.ceil((leaseExpiresAt - now) / 1_000)),
    };
  }

  const reclaimed = await run(
    env,
    "UPDATE payment_job_runs SET job_id = ?, job = ?, resource_id = ?, status = " +
      "'processing', lease_expires_at = ?, attempt_count = attempt_count + 1, " +
      "last_error = NULL, updated_at = ? WHERE dedupe_key = ? AND status != " +
      "'completed' AND (status = 'failed' OR lease_expires_at IS NULL OR " +
      "lease_expires_at <= ?)",
    [
      message.jobId,
      message.job,
      message.resourceId,
      lease,
      timestamp,
      message.dedupeKey,
      timestamp,
    ],
  );
  if (changed(reclaimed)) {
    return { state: "claimed" };
  }

  const winner = await first<JobRun>(
    env,
    "SELECT status, lease_expires_at FROM payment_job_runs WHERE dedupe_key = ? LIMIT 1",
    [message.dedupeKey],
  );
  if (winner?.status === "completed") {
    return { state: "completed" };
  }
  const winnerLease = winner?.lease_expires_at ? Date.parse(winner.lease_expires_at) : now + 1_000;
  return {
    state: "leased",
    retryAfterSeconds: Math.max(1, Math.ceil((winnerLease - now) / 1_000)),
  };
}

export async function completePaymentJob(env: Bindings, dedupeKey: string): Promise<void> {
  const timestamp = nowIso();
  const statements = [
    env.PAYMENTS_DB.prepare(
      "UPDATE payment_job_runs SET status = 'completed', lease_expires_at = NULL, " +
        "last_error = NULL, updated_at = ?, completed_at = COALESCE(completed_at, ?) " +
        "WHERE dedupe_key = ?",
    ).bind(timestamp, timestamp, dedupeKey),
  ];
  if (dedupeKey.startsWith("outbox:")) {
    statements.push(
      env.PAYMENTS_DB.prepare(
        "UPDATE payment_outbox SET status = 'completed', updated_at = ? WHERE id = ? AND status != 'completed'",
      ).bind(timestamp, dedupeKey.slice("outbox:".length)),
    );
  }
  await env.PAYMENTS_DB.batch(statements);
}

export async function failPaymentJob(
  env: Bindings,
  dedupeKey: string,
  error: unknown,
): Promise<void> {
  await run(
    env,
    "UPDATE payment_job_runs SET status = 'failed', lease_expires_at = NULL, " +
      "last_error = ?, updated_at = ? WHERE dedupe_key = ?",
    [
      error instanceof Error ? error.message.slice(0, 500) : "Unknown job error",
      nowIso(),
      dedupeKey,
    ],
  );
}

export type WebhookDeliveryJob = {
  id: string;
  url: string;
  secret_ciphertext: string;
  secret_key_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  attempt_count: number;
  status: "pending" | "processing" | "failed";
  lease_expires_at: string | null;
};

export async function listWebhookDeliveryJobs(
  env: Bindings,
  resourceId: string,
): Promise<WebhookDeliveryJob[]> {
  const result = await env.PAYMENTS_DB.prepare(
    `SELECT d.id, w.url, w.secret_ciphertext, w.secret_key_id, e.id AS event_id, e.type AS event_type,
		 e.payload, d.attempt_count, d.status, d.lease_expires_at
		 FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 JOIN events e ON e.id = d.event_id
		 WHERE (d.id = ? OR d.event_id = ?) AND d.status IN ('pending','processing','failed')
		 AND w.status = 'active'`,
  )
    .bind(resourceId, resourceId)
    .all<WebhookDeliveryJob>();
  return result.results;
}

export async function claimWebhookDelivery(
  env: Bindings,
  id: string,
  leaseOwner: string,
  leaseUntil: string,
): Promise<boolean> {
  const timestamp = nowIso();
  return changed(
    await run(
      env,
      `UPDATE webhook_deliveries SET status = 'processing', lease_owner = ?, lease_expires_at = ?, updated_at = ?
		 WHERE id = ? AND (
			(status IN ('pending','failed') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)) OR
			(status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
		 )`,
      [leaseOwner, leaseUntil, timestamp, id, timestamp, timestamp],
    ),
  );
}

export async function recordWebhookNetworkFailure(
  env: Bindings,
  input: {
    id: string;
    leaseOwner: string;
    attempts: number;
    error: unknown;
  },
): Promise<void> {
  await run(
    env,
    "UPDATE webhook_deliveries SET status = ?, attempt_count = ?, next_retry_at = " +
      "?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = " +
      "? WHERE id = ? AND lease_owner = ?",
    [
      input.attempts >= 8 ? "dead" : "failed",
      input.attempts,
      new Date(Date.now() + Math.min(3_600_000, 15_000 * 2 ** input.attempts)).toISOString(),
      input.error instanceof Error ? input.error.message.slice(0, 500) : "Webhook network error",
      nowIso(),
      input.id,
      input.leaseOwner,
    ],
  );
}

export async function recordWebhookResponse(
  env: Bindings,
  input: {
    id: string;
    leaseOwner: string;
    attempts: number;
    statusCode: number;
    delivered: boolean;
  },
): Promise<void> {
  const timestamp = nowIso();
  if (input.delivered) {
    await run(
      env,
      "UPDATE webhook_deliveries SET status = 'delivered', attempt_count = ?, " +
        "last_status_code = ?, delivered_at = ?, lease_owner = NULL, lease_expires_at " +
        "= NULL, last_error = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?",
      [input.attempts, input.statusCode, timestamp, timestamp, input.id, input.leaseOwner],
    );
    return;
  }
  await run(
    env,
    "UPDATE webhook_deliveries SET status = ?, attempt_count = ?, next_retry_at = " +
      "?, last_status_code = ?, lease_owner = NULL, lease_expires_at = NULL, " +
      "last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
    [
      input.attempts >= 8 ? "dead" : "failed",
      input.attempts,
      new Date(Date.now() + Math.min(3_600_000, 15_000 * 2 ** input.attempts)).toISOString(),
      input.statusCode,
      `HTTP ${input.statusCode}`,
      timestamp,
      input.id,
      input.leaseOwner,
    ],
  );
}
