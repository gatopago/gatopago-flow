import type { Bindings } from "../env";
import { nowIso } from "./db";

export type PaymentOutboxRow = {
	id: string;
	topic: "webhook_delivery";
	resource_id: string;
	attempt_count: number;
};

export async function listDuePaymentOutbox(env: Bindings, limit: number): Promise<PaymentOutboxRow[]> {
	const due = await env.PAYMENTS_DB.prepare(
		`SELECT id, topic, resource_id, attempt_count FROM payment_outbox
		 WHERE status IN ('pending','failed') AND next_attempt_at <= ?
		 ORDER BY created_at LIMIT ?`,
	).bind(nowIso(), Math.max(1, Math.min(limit, 100))).all<PaymentOutboxRow>();
	return due.results;
}

export async function markPaymentOutboxEnqueued(env: Bindings, id: string): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		"UPDATE payment_outbox SET status = 'enqueued', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status IN ('pending','failed')",
	).bind(nowIso(), id).run();
}

export async function markPaymentOutboxFailed(env: Bindings, id: string, attempt: number): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		"UPDATE payment_outbox SET status = 'failed', attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
	).bind(attempt, new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6))).toISOString(),
		nowIso(), id).run();
}
