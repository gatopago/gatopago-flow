import type { Bindings } from "../env";
import { changed, nowIso } from "./db";

export async function acquirePaymentSignerLease(
	env: Bindings,
	leaseKey: string,
	ttlMs: number,
): Promise<string | null> {
	if (!leaseKey || leaseKey.length > 160) throw new Error("Invalid payment signer lease key");
	const now = nowIso();
	const expiresAt = new Date(Date.now() + ttlMs).toISOString();
	const owner = crypto.randomUUID();
	const updated = await env.PAYMENTS_DB.prepare(
		`UPDATE payment_signer_leases SET owner = ?, expires_at = ?, updated_at = ?
		 WHERE lease_key = ? AND expires_at <= ?`,
	).bind(owner, expiresAt, now, leaseKey, now).run();
	if (changed(updated)) return owner;
	const inserted = await env.PAYMENTS_DB.prepare(
		"INSERT OR IGNORE INTO payment_signer_leases(lease_key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)",
	).bind(leaseKey, owner, expiresAt, now).run();
	return changed(inserted) ? owner : null;
}

export async function releasePaymentSignerLease(
	env: Bindings,
	leaseKey: string,
	owner: string,
): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		"DELETE FROM payment_signer_leases WHERE lease_key = ? AND owner = ?",
	).bind(leaseKey, owner).run();
}
