import { enqueuePaymentJob, flushPaymentOutbox } from "./services/queue";
import { logError, logInfo } from "./services/logger";
import { rotateWebhookEncryptionBatch, validateWebhookEncryptionConfig } from "./repositories/merchant";
import { cleanupExpiredRateLimits, listActivePaymentChainIds } from "./stores/opsStore";
import type { Bindings } from "./env";

export async function runMaintenance(env: Bindings): Promise<void> {
		await flushPaymentOutbox(env);
		const webhookEncryptionIssues = validateWebhookEncryptionConfig(env);
		if (webhookEncryptionIssues.length === 0) {
			try {
				const rotation = await rotateWebhookEncryptionBatch(env, 25);
				if (rotation.rotated > 0) logInfo("webhook_encryption_keys_rotated", rotation);
			} catch (error) {
				logError("webhook_encryption_rotation_failed", error, {});
			}
		} else {
			logError("webhook_encryption_rotation_blocked", new Error(webhookEncryptionIssues.join("; ")), {});
		}
		await cleanupExpiredRateLimits(env, Math.floor(Date.now() / 1_000) - 86_400);
		const activeChainIds = await listActivePaymentChainIds(env);
		const minute = Math.floor(Date.now() / 60_000);
		for (const chainId of activeChainIds) {
			await enqueuePaymentJob(env, { job: "router_watch", resourceId: String(chainId),
				dedupeKey: `scheduled-router-watch:${chainId}:${minute}`, partition: String(chainId) });
		}
	}
