import type { Bindings } from "../env";

export type RouterCheckpoint = { block_number: number; block_hash: string };

export async function listCanonicalRouterBlocksBefore(env: Bindings, chainId: number,
	blockNumber: number): Promise<RouterCheckpoint[]> {
	const candidates = await env.PAYMENTS_DB.prepare(
		`SELECT block_number, block_hash FROM payment_chain_blocks
		 WHERE chain_id = ? AND canonical = 1 AND block_number < ?
		 ORDER BY block_number DESC LIMIT 128`,
	).bind(chainId, blockNumber).all<RouterCheckpoint>();
	return candidates.results;
}

export async function rollbackRouterJournal(env: Bindings, input: {
	chainId: number;
	checkpoint: RouterCheckpoint;
	ancestor: RouterCheckpoint;
}): Promise<number> {
	const orphaned = await env.PAYMENTS_DB.prepare(
		"SELECT COUNT(*) AS count FROM payment_chain_events WHERE chain_id = ? AND canonical = 1 AND block_number > ?",
	).bind(input.chainId, input.ancestor.block_number).first<{ count: number }>();
	const orphanedCount = orphaned?.count ?? 0;
	const timestamp = new Date().toISOString();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_chain_events SET canonical = 0 WHERE chain_id = ? AND block_number > ? AND canonical = 1",
		).bind(input.chainId, input.ancestor.block_number),
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_chain_blocks SET canonical = 0 WHERE chain_id = ? AND block_number > ? AND canonical = 1",
		).bind(input.chainId, input.ancestor.block_number),
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_stream_checkpoints SET block_number = ?, block_hash = ?, updated_at = ? WHERE chain_id = ? AND stream = 'routers'",
		).bind(input.ancestor.block_number, input.ancestor.block_hash, timestamp, input.chainId),
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_reorg_incidents(id, chain_id, stream, previous_block_number, previous_block_hash,
			 common_ancestor_number, common_ancestor_hash, orphaned_event_count, status, created_at)
			 VALUES (?, ?, 'routers', ?, ?, ?, ?, ?, 'open', ?)`,
		).bind(`reorg_${crypto.randomUUID()}`, input.chainId, input.checkpoint.block_number,
			input.checkpoint.block_hash, input.ancestor.block_number, input.ancestor.block_hash,
			orphanedCount, timestamp),
	]);
	return orphanedCount;
}

export async function getRouterCheckpoint(env: Bindings, chainId: number): Promise<RouterCheckpoint | null> {
	return env.PAYMENTS_DB.prepare(
		"SELECT block_number, block_hash FROM payment_stream_checkpoints WHERE chain_id = ? AND stream = 'routers'",
	).bind(chainId).first<RouterCheckpoint>();
}

export async function upsertPaymentChainEvent(env: Bindings, input: {
	chainId: number;
	txHash: string;
	logIndex: number;
	blockNumber: number;
	blockHash: string;
	eventName: "PaymentSettled" | "CctpPaymentBurned";
	intentHash: string | null;
	attemptHash: string | null;
	payloadJson: string;
}): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		`INSERT INTO payment_chain_events(chain_id, tx_hash, log_index, block_number, block_hash, event_name,
		 intent_hash, attempt_hash, payload_json, canonical, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET block_number = excluded.block_number,
		 block_hash = excluded.block_hash, event_name = excluded.event_name, intent_hash = excluded.intent_hash,
		 attempt_hash = excluded.attempt_hash, payload_json = excluded.payload_json, canonical = 1`,
	).bind(input.chainId, input.txHash, input.logIndex, input.blockNumber, input.blockHash,
		input.eventName, input.intentHash, input.attemptHash, input.payloadJson, new Date().toISOString()).run();
}

export async function commitRouterCheckpoint(env: Bindings, input: {
	chainId: number;
	blockNumber: number;
	blockHash: string;
	parentHash: string;
	blockTimestamp: string;
}): Promise<void> {
	const timestamp = new Date().toISOString();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_chain_blocks SET canonical = 0 WHERE chain_id = ? AND block_number = ? AND block_hash != ? AND canonical = 1",
		).bind(input.chainId, input.blockNumber, input.blockHash),
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_chain_blocks(chain_id, block_number, block_hash, parent_hash, block_timestamp, canonical)
			 VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(chain_id, block_number, block_hash) DO UPDATE SET canonical = 1`,
		).bind(input.chainId, input.blockNumber, input.blockHash, input.parentHash, input.blockTimestamp),
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_stream_checkpoints(chain_id, stream, block_number, block_hash, updated_at) VALUES (?, 'routers', ?, ?, ?)
			 ON CONFLICT(chain_id, stream) DO UPDATE SET block_number = excluded.block_number, block_hash = excluded.block_hash, updated_at = excluded.updated_at`,
		).bind(input.chainId, input.blockNumber, input.blockHash, timestamp),
	]);
}
