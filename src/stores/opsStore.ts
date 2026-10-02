import type { Bindings } from "../env";

type PaymentOpsCounts = {
	activeAttempts: number;
	pendingWebhooks: number;
	pendingOutbox: number;
	activeJobLeases: number;
	openReorgIncidents: number;
	pendingFeeEvidence: number;
	webhookKeysPendingRotation: number;
};

export async function paymentDatabaseAvailable(env: Bindings): Promise<boolean> {
	try {
		await env.PAYMENTS_DB.prepare("SELECT 1 AS ok").first();
		return true;
	} catch {
		return false;
	}
}

export async function paymentOpsCounts(env: Bindings): Promise<PaymentOpsCounts | null> {
	return env.PAYMENTS_DB.prepare(
		`SELECT
		 (SELECT COUNT(*) FROM payment_attempts WHERE status IN ('reserved','submitted','processing')) AS activeAttempts,
		 (SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('pending','processing','failed')) AS pendingWebhooks,
		 (SELECT COUNT(*) FROM payment_outbox WHERE status IN ('pending','enqueued','failed')) AS pendingOutbox,
		 (SELECT COUNT(*) FROM payment_job_runs WHERE status = 'processing') AS activeJobLeases,
		 (SELECT COUNT(*) FROM payment_reorg_incidents WHERE status = 'open') AS openReorgIncidents,
		 (SELECT COUNT(*) FROM payment_fee_ledger WHERE status = 'quoted') AS pendingFeeEvidence,
		 (SELECT COUNT(*) FROM webhook_endpoints WHERE secret_key_id != ?) AS webhookKeysPendingRotation`,
	).bind(env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID ?? "").first<PaymentOpsCounts>();
}

export async function cleanupExpiredRateLimits(env: Bindings, beforeEpochSeconds: number): Promise<void> {
	await env.PAYMENTS_DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
		.bind(beforeEpochSeconds).run();
}

export async function listActivePaymentChainIds(env: Bindings): Promise<number[]> {
	const active = await env.PAYMENTS_DB.prepare(
		"SELECT DISTINCT source_chain_id FROM payment_attempts WHERE status IN ('reserved','submitted','processing')",
	).all<{ source_chain_id: number }>();
	return active.results.map((row) => row.source_chain_id);
}
