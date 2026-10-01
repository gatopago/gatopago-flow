import type { Bindings } from "../env";

export async function incrementRateLimit(env: Bindings, input: {
	scope: string; keyHash: string; windowStart: number;
}): Promise<number | null> {
	const timestamp = new Date().toISOString();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			"INSERT OR IGNORE INTO rate_limits(scope, key_hash, window_start, count, updated_at) VALUES (?, ?, ?, 0, ?)",
		).bind(input.scope, input.keyHash, input.windowStart, timestamp),
		env.PAYMENTS_DB.prepare(
			"UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE scope = ? AND key_hash = ? AND window_start = ?",
		).bind(timestamp, input.scope, input.keyHash, input.windowStart),
	]);
	const row = await env.PAYMENTS_DB.prepare(
		"SELECT count FROM rate_limits WHERE scope = ? AND key_hash = ? AND window_start = ?",
	).bind(input.scope, input.keyHash, input.windowStart).first<{ count: number }>();
	return row?.count ?? null;
}
