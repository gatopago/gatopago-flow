import { type Address } from "viem";
import type { Bindings } from "../env";
import { changed, first, nowIso, run } from "../stores/db";

export async function upsertCrosschainOperation(
  env: Bindings,
  input: {
    attemptId: string;
    sourceChainId: number;
    destinationChainId: number;
    route: "cctp_fast" | "cctp_standard";
    sourceTxHash: string;
    messageHash: string;
    message: string;
    burnAmountAtomic: string;
    platformFeeAtomic: string;
  },
): Promise<string> {
  const id = `cctp_${input.attemptId}`;
  const timestamp = nowIso();
  await run(
    env,
    `INSERT INTO crosschain_operations(op_id, attempt_id, source_chain_id, destination_chain_id, route,
		 status, source_tx_hash, message_hash, message, burn_amount_atomic, platform_fee_atomic,
		 next_attempt_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'burned', ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(attempt_id) DO UPDATE SET source_tx_hash = COALESCE(crosschain_operations.source_tx_hash, excluded.source_tx_hash),
		 message_hash = COALESCE(crosschain_operations.message_hash, excluded.message_hash), message = COALESCE(crosschain_operations.message, excluded.message),
		 burn_amount_atomic = COALESCE(crosschain_operations.burn_amount_atomic, excluded.burn_amount_atomic),
		 platform_fee_atomic = COALESCE(crosschain_operations.platform_fee_atomic, excluded.platform_fee_atomic),
		 updated_at = excluded.updated_at`,
    [
      id,
      input.attemptId,
      input.sourceChainId,
      input.destinationChainId,
      input.route,
      input.sourceTxHash.toLowerCase(),
      input.messageHash.toLowerCase(),
      input.message,
      input.burnAmountAtomic,
      input.platformFeeAtomic,
      timestamp,
      timestamp,
      timestamp,
    ],
  );
  return id;
}

export async function getCrosschainOperation(
  env: Bindings,
  opId: string,
): Promise<{
  opId: string;
  attemptId: string;
  sourceChainId: number;
  destinationChainId: number;
  status: string;
  sourceTxHash: string | null;
  messageHash: string | null;
  message: string | null;
  attestation: string | null;
  burnAmountAtomic: string | null;
  platformFeeAtomic: string | null;
  networkFeeAtomic: string | null;
  destinationTxHash: string | null;
  messageNonce: string | null;
  mintedAmountAtomic: string | null;
  mintRawTransaction: string | null;
  attemptCount: number;
}> {
  const row = await first<{
    op_id: string;
    attempt_id: string;
    source_chain_id: number;
    destination_chain_id: number;
    status: string;
    source_tx_hash: string | null;
    message_hash: string | null;
    message: string | null;
    attestation: string | null;
    burn_amount_atomic: string | null;
    platform_fee_atomic: string | null;
    network_fee_atomic: string | null;
    destination_tx_hash: string | null;
    message_nonce: string | null;
    minted_amount_atomic: string | null;
    mint_raw_transaction: string | null;
    attempt_count: number;
  }>(
    env,
    `SELECT op_id, attempt_id, source_chain_id, destination_chain_id, status, source_tx_hash,
		 message_hash, message, attestation, burn_amount_atomic, platform_fee_atomic, network_fee_atomic,
		 destination_tx_hash, message_nonce, minted_amount_atomic, mint_raw_transaction, attempt_count
		 FROM crosschain_operations WHERE op_id = ? LIMIT 1`,
    [opId],
  );
  if (!row) {
    throw new Error("Crosschain operation not found");
  }
  return {
    opId: row.op_id,
    attemptId: row.attempt_id,
    sourceChainId: row.source_chain_id,
    destinationChainId: row.destination_chain_id,
    status: row.status,
    sourceTxHash: row.source_tx_hash,
    messageHash: row.message_hash,
    message: row.message,
    attestation: row.attestation,
    burnAmountAtomic: row.burn_amount_atomic,
    platformFeeAtomic: row.platform_fee_atomic,
    networkFeeAtomic: row.network_fee_atomic,
    destinationTxHash: row.destination_tx_hash,
    messageNonce: row.message_nonce,
    mintedAmountAtomic: row.minted_amount_atomic,
    mintRawTransaction: row.mint_raw_transaction,
    attemptCount: row.attempt_count,
  };
}

export async function updateCrosschainOperation(
  env: Bindings,
  opId: string,
  fields: {
    status: string;
    message?: string | null;
    attestation?: string | null;
    destinationTxHash?: string | null;
    networkFeeAtomic?: string | null;
    messageNonce?: string | null;
    mintedAmountAtomic?: string | null;
    lastErrorCode?: string | null;
  },
): Promise<void> {
  await run(
    env,
    `UPDATE crosschain_operations SET status = ?, message = COALESCE(?, message), attestation = COALESCE(?, attestation),
		destination_tx_hash = COALESCE(?, destination_tx_hash), network_fee_atomic = COALESCE(?, network_fee_atomic),
		message_nonce = COALESCE(?, message_nonce), minted_amount_atomic = COALESCE(?, minted_amount_atomic),
		last_error_code = ?,
		next_attempt_at = ?, updated_at = ? WHERE op_id = ?`,
    [
      fields.status,
      fields.message ?? null,
      fields.attestation ?? null,
      fields.destinationTxHash ?? null,
      fields.networkFeeAtomic ?? null,
      fields.messageNonce ?? null,
      fields.mintedAmountAtomic ?? null,
      fields.lastErrorCode ?? null,
      new Date(Date.now() + 30_000).toISOString(),
      nowIso(),
      opId,
    ],
  );
}

export async function recordCrosschainMintPrepared(
  env: Bindings,
  input: {
    opId: string;
    txHash: string;
    rawTransaction: string;
    signerAddress: Address;
    nonce: number;
  },
): Promise<boolean> {
  const timestamp = nowIso();
  const results = await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      `UPDATE crosschain_operations SET destination_tx_hash = ?, mint_raw_transaction = ?,
			 mint_signer_address = ?, mint_nonce = ?, attempt_count = attempt_count + 1,
			 last_error_code = NULL, updated_at = ?
			 WHERE op_id = ? AND status = 'minting' AND destination_tx_hash IS NULL`,
    ).bind(
      input.txHash.toLowerCase(),
      input.rawTransaction,
      input.signerAddress.toLowerCase(),
      input.nonce,
      timestamp,
      input.opId,
    ),
    env.PAYMENTS_DB.prepare(
      `INSERT OR IGNORE INTO crosschain_mint_attempts(id, op_id, tx_hash, status, created_at, updated_at)
			 SELECT ?, op_id, ?, 'prepared', ?, ? FROM crosschain_operations
			 WHERE op_id = ? AND destination_tx_hash = ?`,
    ).bind(
      `cma_${crypto.randomUUID().replaceAll("-", "")}`,
      input.txHash.toLowerCase(),
      timestamp,
      timestamp,
      input.opId,
      input.txHash.toLowerCase(),
    ),
  ]);
  return changed(results[0]);
}

export async function recordCrosschainMintBroadcast(
  env: Bindings,
  opId: string,
  txHash: string,
): Promise<void> {
  const timestamp = nowIso();
  await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      `UPDATE crosschain_operations SET mint_broadcast_at = COALESCE(mint_broadcast_at, ?), updated_at = ?
			 WHERE op_id = ? AND destination_tx_hash = ? AND status = 'minting'`,
    ).bind(timestamp, timestamp, opId, txHash.toLowerCase()),
    env.PAYMENTS_DB.prepare(
      `UPDATE crosschain_mint_attempts SET status = 'broadcast', updated_at = ?
			 WHERE op_id = ? AND tx_hash = ?`,
    ).bind(timestamp, opId, txHash.toLowerCase()),
  ]);
}

export async function recordCrosschainMintResult(
  env: Bindings,
  opId: string,
  txHash: string,
  status: "pending" | "success" | "reverted" | "unknown",
): Promise<void> {
  const timestamp = nowIso();
  await run(
    env,
    `INSERT INTO crosschain_mint_attempts(id, op_id, tx_hash, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(tx_hash) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    [
      `cma_${crypto.randomUUID().replaceAll("-", "")}`,
      opId,
      txHash.toLowerCase(),
      status,
      timestamp,
      timestamp,
    ],
  );
}

export async function clearRevertedCrosschainMint(
  env: Bindings,
  opId: string,
  txHash: string,
): Promise<void> {
  const timestamp = nowIso();
  await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      `UPDATE crosschain_mint_attempts SET status = 'reverted', updated_at = ?
			 WHERE op_id = ? AND tx_hash = ?`,
    ).bind(timestamp, opId, txHash.toLowerCase()),
    env.PAYMENTS_DB.prepare(
      `UPDATE crosschain_operations SET destination_tx_hash = NULL, mint_raw_transaction = NULL,
			 mint_signer_address = NULL, mint_nonce = NULL, mint_broadcast_at = NULL,
			 last_error_code = 'CCTP_MINT_REVERTED', next_attempt_at = ?, updated_at = ?
			 WHERE op_id = ? AND status = 'minting' AND destination_tx_hash = ?`,
    ).bind(new Date(Date.now() + 30_000).toISOString(), timestamp, opId, txHash.toLowerCase()),
  ]);
}
