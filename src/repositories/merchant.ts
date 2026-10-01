import type { Bindings } from "../env";
import { all, changed, first, nowIso, run } from "../stores/db";
import { randomSecret, sha256Hex } from "../services/crypto";

export type ApiMode = "test" | "live";
export type ApiKeySummary = {
	id: string; mode: ApiMode; prefix: string; name: string; lastUsedAt: string | null;
	revokedAt: string | null; createdAt: string;
};

type ApiKeyRow = {
	id: string; merchant_id: string; mode: ApiMode; prefix: string; key_hash: string;
	name: string; last_used_at: string | null; revoked_at: string | null; created_at: string;
};

function summary(row: ApiKeyRow): ApiKeySummary {
	return { id: row.id, mode: row.mode, prefix: row.prefix, name: row.name,
		lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, createdAt: row.created_at };
}

export async function createApiKey(env: Bindings, merchantId: string, mode: ApiMode, name: string): Promise<{ secret: string; key: ApiKeySummary }> {
	const raw = `sk_${mode}_${randomSecret(24)}`;
	const timestamp = nowIso();
	const row: ApiKeyRow = { id: `key_${crypto.randomUUID()}`, merchant_id: merchantId, mode,
		prefix: raw.slice(0, 16), key_hash: await sha256Hex(raw), name, last_used_at: null,
		revoked_at: null, created_at: timestamp };
	await run(env, "INSERT INTO api_keys(id, merchant_id, mode, prefix, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[row.id, row.merchant_id, row.mode, row.prefix, row.key_hash, row.name, row.created_at]);
	return { secret: raw, key: summary(row) };
}

export async function authenticateApiKey(env: Bindings, raw: string): Promise<{ merchantId: string; mode: ApiMode } | null> {
	if (!/^sk_(?:test|live)_[0-9a-f]{48}$/u.test(raw)) return null;
	const row = await first<ApiKeyRow>(env,
		"SELECT id, merchant_id, mode, prefix, key_hash, name, last_used_at, revoked_at, created_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1",
		[await sha256Hex(raw)]);
	if (!row) return null;
	await run(env, "UPDATE api_keys SET last_used_at = ? WHERE id = ?", [nowIso(), row.id]);
	return { merchantId: row.merchant_id, mode: row.mode };
}

export async function listApiKeys(env: Bindings, merchantId: string): Promise<ApiKeySummary[]> {
	return (await all<ApiKeyRow>(env,
		"SELECT id, merchant_id, mode, prefix, key_hash, name, last_used_at, revoked_at, created_at FROM api_keys WHERE merchant_id = ? ORDER BY created_at DESC",
		[merchantId])).map(summary);
}

export async function revokeApiKey(env: Bindings, merchantId: string, id: string): Promise<boolean> {
	return changed(await run(env, "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL", [nowIso(), id, merchantId]));
}

type WebhookRow = { id: string; merchant_id: string; url: string; secret_ciphertext: string;
	secret_key_id: string; mode: ApiMode; enabled_events: string | null;
	status: "active" | "disabled"; created_at: string; updated_at: string };

export type WebhookSummary = { id: string; url: string; mode: ApiMode; events: string[] | null;
	status: "active" | "disabled"; createdAt: string; updatedAt: string };

function decodedKey(encoded: string, label: string): Uint8Array {
	const raw = /^[0-9a-fA-F]{64}$/u.test(encoded)
		? Uint8Array.from(encoded.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16))
		: Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
	if (raw.byteLength !== 32) throw new Error(`${label} must be 32 bytes`);
	return raw;
}

function currentKeyId(env: Bindings): string {
	const id = env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID?.trim();
	if (!id || !/^[A-Za-z0-9_.-]{1,64}$/u.test(id)) throw new Error("Webhook encryption key ID is invalid");
	return id;
}

function previousKeys(env: Bindings): Record<string, string> {
	if (!env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS?.trim()) return {};
	let parsed: unknown;
	try { parsed = JSON.parse(env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS); }
	catch { throw new Error("Previous webhook encryption keyring is malformed"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Previous webhook encryption keyring is malformed");
	}
	const entries = Object.entries(parsed);
	if (entries.length > 16 || entries.some(([id, value]) =>
		!/^[A-Za-z0-9_.-]{1,64}$/u.test(id) || typeof value !== "string" || !value)) {
		throw new Error("Previous webhook encryption keyring is invalid");
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function encodedKeyFor(env: Bindings, keyId: string): string {
	const activeId = currentKeyId(env);
	if (keyId === activeId) {
		if (!env.WEBHOOK_SECRET_ENCRYPTION_KEY) throw new Error("Webhook encryption key is not configured");
		return env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	}
	const encoded = previousKeys(env)[keyId];
	if (!encoded) throw new Error(`Webhook encryption key ${keyId} is unavailable`);
	return encoded;
}

async function encryptionKey(env: Bindings, keyId: string): Promise<CryptoKey> {
	const raw = decodedKey(encodedKeyFor(env, keyId), `Webhook encryption key ${keyId}`);
	return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function unbase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function webhookAad(keyId: string): ArrayBuffer {
	return new TextEncoder().encode(`gatopago-webhook:${keyId}`).buffer as ArrayBuffer;
}

export async function encryptWebhookSecret(env: Bindings, secret: string): Promise<{ ciphertext: string; keyId: string }> {
	const keyId = currentKeyId(env);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: webhookAad(keyId) },
		await encryptionKey(env, keyId), new TextEncoder().encode(secret)));
	return { ciphertext: `enc:v2:${keyId}:${base64(nonce)}.${base64(ciphertext)}`, keyId };
}

export async function decryptWebhookSecret(env: Bindings, ciphertext: string, storedKeyId: string): Promise<string> {
	const match = ciphertext.match(/^enc:v2:([A-Za-z0-9_.-]{1,64}):(.+)$/u);
	const embeddedKeyId = match?.[1] ?? null;
	if (embeddedKeyId && embeddedKeyId !== storedKeyId) throw new Error("Webhook ciphertext key ID mismatch");
	const payload = match?.[2] ?? ciphertext;
	const [nonce, encrypted] = payload.split(".");
	if (!nonce || !encrypted) throw new Error("Invalid webhook ciphertext");
	const nonceBytes = unbase64(nonce);
	const encryptedBytes = unbase64(encrypted);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: nonceBytes.buffer as ArrayBuffer,
			...(embeddedKeyId ? { additionalData: webhookAad(storedKeyId) } : {}) },
		await encryptionKey(env, storedKeyId),
		encryptedBytes.buffer as ArrayBuffer,
	);
	return new TextDecoder().decode(plaintext);
}

export function validateWebhookEncryptionConfig(env: Bindings): string[] {
	try {
		const activeId = currentKeyId(env);
		decodedKey(encodedKeyFor(env, activeId), `Webhook encryption key ${activeId}`);
		for (const [id, encoded] of Object.entries(previousKeys(env))) {
			if (id === activeId && encoded !== env.WEBHOOK_SECRET_ENCRYPTION_KEY) {
				throw new Error("Active webhook key ID conflicts with the previous keyring");
			}
			decodedKey(encoded, `Previous webhook encryption key ${id}`);
		}
		return [];
	} catch (error) {
		return [error instanceof Error ? error.message : "Webhook encryption config is invalid"];
	}
}

export async function rotateWebhookEncryptionBatch(env: Bindings, limit = 25): Promise<{
	scanned: number; rotated: number; remaining: number;
}> {
	const activeKeyId = currentKeyId(env);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid webhook rotation batch size");
	const rows = await all<Pick<WebhookRow, "id" | "secret_ciphertext" | "secret_key_id">>(env,
		`SELECT id, secret_ciphertext, secret_key_id FROM webhook_endpoints
		 WHERE secret_key_id != ? ORDER BY updated_at, id LIMIT ?`, [activeKeyId, limit]);
	let rotated = 0;
	for (const row of rows) {
		const plaintext = await decryptWebhookSecret(env, row.secret_ciphertext, row.secret_key_id);
		const encrypted = await encryptWebhookSecret(env, plaintext);
		const result = await run(env,
			`UPDATE webhook_endpoints SET secret_ciphertext = ?, secret_key_id = ?, updated_at = ?
			 WHERE id = ? AND secret_key_id = ? AND secret_ciphertext = ?`,
			[encrypted.ciphertext, encrypted.keyId, nowIso(), row.id, row.secret_key_id, row.secret_ciphertext]);
		if (changed(result)) rotated += 1;
	}
	const remaining = await first<{ count: number }>(env,
		"SELECT COUNT(*) AS count FROM webhook_endpoints WHERE secret_key_id != ?", [activeKeyId]);
	return { scanned: rows.length, rotated, remaining: remaining?.count ?? 0 };
}

export async function createWebhookEndpoint(env: Bindings, merchantId: string, url: string,
	mode: ApiMode, events: string[] | null): Promise<{ secret: string; endpoint: WebhookSummary }> {
	const secret = `whsec_${randomSecret(32)}`;
	const encrypted = await encryptWebhookSecret(env, secret);
	const timestamp = nowIso();
	const id = `whe_${crypto.randomUUID()}`;
	await run(env, "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, mode, enabled_events, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
		[id, merchantId, url, encrypted.ciphertext, encrypted.keyId, mode, events ? JSON.stringify(events) : null, timestamp, timestamp]);
	return { secret, endpoint: { id, url, mode, events, status: "active", createdAt: timestamp, updatedAt: timestamp } };
}

export async function listWebhookEndpoints(env: Bindings, merchantId: string): Promise<WebhookSummary[]> {
	return (await all<WebhookRow>(env, "SELECT id, merchant_id, url, secret_ciphertext, secret_key_id, mode, enabled_events, status, created_at, updated_at FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at DESC", [merchantId]))
		.map((row) => ({ id: row.id, url: row.url, mode: row.mode,
			events: row.enabled_events ? JSON.parse(row.enabled_events) as string[] : null,
			status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function disableWebhookEndpoint(env: Bindings, merchantId: string, id: string): Promise<boolean> {
	return changed(await run(env, "UPDATE webhook_endpoints SET status = 'disabled', updated_at = ? WHERE id = ? AND merchant_id = ? AND status = 'active'", [nowIso(), id, merchantId]));
}

export async function listEvents(env: Bindings, merchantId: string, limit = 50, startingAfter?: string | null): Promise<Array<Record<string, unknown>>> {
	const cursor = startingAfter
		? "AND (created_at < (SELECT created_at FROM events WHERE id = ? AND merchant_id = ?) OR (created_at = (SELECT created_at FROM events WHERE id = ? AND merchant_id = ?) AND id < ?))"
		: "";
	const values = startingAfter ? [merchantId, startingAfter, merchantId, startingAfter, merchantId, startingAfter, limit] : [merchantId, limit];
	return (await all<{ id: string; type: string; object_id: string; mode: ApiMode; payload: string; created_at: string }>(env,
		`SELECT id, type, object_id, mode, payload, created_at FROM events WHERE merchant_id = ? ${cursor} ORDER BY created_at DESC, id DESC LIMIT ?`, values))
		.map((row) => ({ id: row.id, type: row.type, objectId: row.object_id,
			payload: JSON.parse(row.payload), data: JSON.parse(row.payload), mode: row.mode, createdAt: row.created_at }));
}

export async function listWebhookDeliveries(env: Bindings, merchantId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
	return all<Record<string, unknown>>(env,
		`SELECT d.id, d.event_id AS eventId, d.endpoint_id AS endpointId, e.type AS eventType, w.url,
		 d.status, d.attempt_count AS attempt, d.attempt_count AS attemptCount,
		 d.next_retry_at AS nextRetryAt, d.last_status_code AS responseCode, d.last_status_code AS lastStatusCode,
		 d.last_error AS lastError, d.delivered_at AS deliveredAt, d.created_at AS createdAt
		 FROM webhook_deliveries d JOIN events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 WHERE e.merchant_id = ? ORDER BY d.created_at DESC LIMIT ?`, [merchantId, limit]);
}

export async function resendWebhookDelivery(env: Bindings, merchantId: string, id: string): Promise<boolean> {
	return changed(await run(env,
		`UPDATE webhook_deliveries SET status = 'pending', next_retry_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
		 WHERE id = ? AND EXISTS (SELECT 1 FROM events e WHERE e.id = webhook_deliveries.event_id AND e.merchant_id = ?)`,
		[nowIso(), nowIso(), id, merchantId]));
}
