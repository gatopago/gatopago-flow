import { type Address } from "viem";
import type {
  RegisterWalletPaymentExecutionCommand,
  RegisteredWalletPaymentExecution,
} from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";
import type { PaymentAttempt, PaymentQuote } from "../domain/models";
import { changed, first, nowIso, run } from "../stores/db";
import { type AttemptRow, ATTEMPT_COLUMNS, mapAttempt } from "./rows";
import { feeLedgerStatements } from "./fees";
import { quoteInsertStatement } from "./quotes";

export async function getAttempt(env: Bindings, id: string): Promise<PaymentAttempt | null> {
  const row = await first<AttemptRow>(
    env,
    `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? mapAttempt(row) : null;
}

export async function getCheckoutAttempt(
  env: Bindings,
  id: string,
  capabilityHash: `0x${string}`,
): Promise<PaymentAttempt | null> {
  const row = await first<AttemptRow>(
    env,
    `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts
		 WHERE id = ? AND checkout_capability_hash = ? LIMIT 1`,
    [id, capabilityHash.toLowerCase()],
  );
  return row ? mapAttempt(row) : null;
}

export async function getAttemptByHash(
  env: Bindings,
  attemptHash: string,
): Promise<PaymentAttempt | null> {
  const row = await first<AttemptRow>(
    env,
    `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE attempt_hash = ? LIMIT 1`,
    [attemptHash.toLowerCase()],
  );
  return row ? mapAttempt(row) : null;
}

export async function listActiveRouterAddressesByChain(
  env: Bindings,
  chainId: number,
): Promise<Address[]> {
  const result = await env.PAYMENTS_DB.prepare(
    `SELECT DISTINCT router_address FROM payment_attempts
		 WHERE source_chain_id = ? AND status IN ('reserved','submitted','processing')`,
  )
    .bind(chainId)
    .all<{ router_address: Address }>();
  return result.results.map((row) => row.router_address);
}

export async function markAttemptProcessing(
  env: Bindings,
  attemptId: string,
  sourceTxHash: string,
): Promise<void> {
  await run(
    env,
    "UPDATE payment_attempts SET status = CASE WHEN status IN " +
      "('reserved','submitted') THEN 'processing' ELSE status END, source_tx_hash = " +
      "COALESCE(source_tx_hash, ?), updated_at = ? WHERE id = ?",
    [sourceTxHash.toLowerCase(), nowIso(), attemptId],
  );
}

export async function getAttemptByIdempotency(
  env: Bindings,
  input: {
    intentId: string;
    payerAddress: Address;
    sourceChainId: number;
    idempotencyKey: string;
  },
): Promise<PaymentAttempt | null> {
  const row = await first<AttemptRow>(
    env,
    "SELECT " +
      `${ATTEMPT_COLUMNS}` +
      " FROM payment_attempts WHERE intent_id = ? AND payer_address = ? AND " +
      "source_chain_id = ? AND idempotency_key = ? LIMIT 1",
    [input.intentId, input.payerAddress, input.sourceChainId, input.idempotencyKey],
  );
  return row ? mapAttempt(row) : null;
}

export async function insertQuoteAndAttempt(
  env: Bindings,
  input: {
    quote: PaymentQuote;
    attempt: PaymentAttempt;
    idempotencyKey: string;
  },
): Promise<PaymentAttempt> {
  try {
    await env.PAYMENTS_DB.batch([
      quoteInsertStatement(env, input.quote),
      ...attemptInsertStatements(env, input),
    ]);
  } catch (error) {
    const replay = await getAttemptByIdempotency(env, {
      intentId: input.attempt.intentId,
      payerAddress: input.attempt.payerAddress,
      sourceChainId: input.attempt.sourceChainId,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) {
      return replay;
    }
    throw error;
  }
  const stored = await getAttempt(env, input.attempt.id);
  if (!stored) {
    throw new Error("Payment attempt creation was not durable");
  }
  return stored;
}

type AttemptInput = {
  attempt: PaymentAttempt;
  idempotencyKey: string;
  checkoutAccess?: {
    capabilityHash: `0x${string}`;
    payerProofSignature: `0x${string}`;
    payerProofMessageHash: `0x${string}`;
  };
};

function attemptInsertStatements(env: Bindings, input: AttemptInput): D1PreparedStatement[] {
  return [
    env.PAYMENTS_DB.prepare(
      `INSERT INTO payment_attempts(id, attempt_hash, intent_id, quote_id, payer_user_id, payer_address,
			 idempotency_key, source_chain_id, route, status, router_address, authorization_hash,
			 authorization_json, signature, checkout_capability_hash, payer_proof_signature,
			 payer_proof_message_hash, valid_after, valid_until, settlement_amount_atomic,
			 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id,
			 fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer,
			 platform_fee_recipient, route_fee_cap_bps, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.attempt.id,
      input.attempt.attemptHash,
      input.attempt.intentId,
      input.attempt.quoteId,
      input.attempt.payerUserId,
      input.attempt.payerAddress,
      input.idempotencyKey,
      input.attempt.sourceChainId,
      input.attempt.route,
      input.attempt.routerAddress,
      input.attempt.authorizationHash,
      JSON.stringify(input.attempt.authorization),
      input.attempt.signature,
      input.checkoutAccess?.capabilityHash.toLowerCase() ?? null,
      input.checkoutAccess?.payerProofSignature ?? null,
      input.checkoutAccess?.payerProofMessageHash ?? null,
      input.attempt.validAfter,
      input.attempt.validUntil,
      input.attempt.settlementAmountAtomic,
      input.attempt.platformFeeAtomic,
      input.attempt.cctpFeeAtomic,
      input.attempt.grossPayerAmountAtomic,
      input.attempt.feePolicyId,
      input.attempt.feePolicyVersion,
      input.attempt.feeRuleId,
      input.attempt.platformFeeBps,
      input.attempt.platformFeeBearer,
      input.attempt.platformFeeRecipient,
      input.attempt.routeFeeCapBps,
      input.attempt.createdAt,
      input.attempt.updatedAt,
    ),
    ...feeLedgerStatements(env, input.attempt),
  ];
}

export async function insertAttempt(env: Bindings, input: AttemptInput): Promise<PaymentAttempt> {
  await env.PAYMENTS_DB.batch(attemptInsertStatements(env, input));
  const stored = await getAttempt(env, input.attempt.id);
  if (!stored) {
    throw new Error("Payment attempt creation was not durable");
  }
  return stored;
}

export async function registerWalletExecution(
  env: Bindings,
  command: RegisterWalletPaymentExecutionCommand,
): Promise<RegisteredWalletPaymentExecution | null> {
  const replay = await first<{ attempt_id: string; user_op_hash: string }>(
    env,
    "SELECT attempt_id, user_op_hash FROM wallet_execution_commands WHERE command_id = ? LIMIT 1",
    [command.commandId],
  );
  if (replay) {
    const attempt = await getAttempt(env, replay.attempt_id);
    return attempt
      ? {
          attemptId: attempt.id,
          status:
            attempt.status === "reserved"
              ? "submitted"
              : (attempt.status as "submitted" | "processing" | "paid"),
          userOpHash: replay.user_op_hash,
          idempotentReplay: true,
        }
      : null;
  }
  const attempt = await getAttempt(env, command.attemptId);
  if (!attempt || attempt.sourceChainId !== command.sourceChainId) {
    return null;
  }
  if (attempt.userOpHash && attempt.userOpHash.toLowerCase() !== command.userOpHash.toLowerCase()) {
    return null;
  }
  const timestamp = nowIso();
  await env.PAYMENTS_DB.batch([
    env.PAYMENTS_DB.prepare(
      "UPDATE payment_attempts SET status = CASE WHEN status = 'reserved' THEN " +
        "'submitted' ELSE status END, user_op_hash = COALESCE(user_op_hash, ?), " +
        "updated_at = ? WHERE id = ? AND status IN " +
        "('reserved','submitted','processing','paid')",
    ).bind(command.userOpHash.toLowerCase(), timestamp, attempt.id),
    env.PAYMENTS_DB.prepare(
      "INSERT INTO wallet_execution_commands(command_id, attempt_id, user_op_hash, " +
        "created_at) VALUES (?, ?, ?, ?)",
    ).bind(command.commandId, attempt.id, command.userOpHash.toLowerCase(), timestamp),
  ]);
  const stored = await getAttempt(env, attempt.id);
  if (!stored) {
    return null;
  }
  return {
    attemptId: stored.id,
    status:
      stored.status === "reserved"
        ? "submitted"
        : (stored.status as "submitted" | "processing" | "paid"),
    userOpHash: command.userOpHash.toLowerCase(),
    idempotentReplay: false,
  };
}

export async function registerSourceTransaction(
  env: Bindings,
  input: {
    attemptId: string;
    capabilityHash: `0x${string}`;
    txHash: string;
  },
): Promise<PaymentAttempt | null> {
  const timestamp = nowIso();
  const txHash = input.txHash.toLowerCase();
  const capabilityHash = input.capabilityHash.toLowerCase() as `0x${string}`;
  const result = await env.PAYMENTS_DB.prepare(
    `UPDATE payment_attempts SET source_tx_hash = COALESCE(source_tx_hash, ?),
		 status = CASE WHEN status = 'reserved' THEN 'submitted' ELSE status END, updated_at = ?
		 WHERE id = ? AND checkout_capability_hash = ?
		 AND status IN ('reserved','submitted','processing','paid','overpaid')
		 AND (source_tx_hash IS NULL OR source_tx_hash = ?)`,
  )
    .bind(txHash, timestamp, input.attemptId, capabilityHash, txHash)
    .run();
  if (!changed(result)) {
    return null;
  }
  return getCheckoutAttempt(env, input.attemptId, capabilityHash);
}

export async function cancelAttempt(
  env: Bindings,
  input: {
    attemptId: string;
    capabilityHash: `0x${string}`;
  },
): Promise<boolean> {
  const result = await env.PAYMENTS_DB.prepare(
    `UPDATE payment_attempts SET status = 'canceled', updated_at = ?
		 WHERE id = ? AND checkout_capability_hash = ? AND status = 'reserved'
		 AND source_tx_hash IS NULL AND user_op_hash IS NULL`,
  )
    .bind(nowIso(), input.attemptId, input.capabilityHash.toLowerCase())
    .run();
  return changed(result);
}
