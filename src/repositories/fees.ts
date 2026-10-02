import type { Bindings } from "../env";
import type { PaymentAttempt } from "../domain/models";
import type { PaymentFeeBreakdown, PaymentFeeLine } from "@gatopago/shared/fees";
import { first } from "../stores/db";
import { type FeeLedgerRow } from "./rows";

export function feeLedgerStatements(env: Bindings, attempt: PaymentAttempt): D1PreparedStatement[] {
  const timestamp = attempt.createdAt;
  const platformQuoted = BigInt(attempt.platformFeeAtomic);
  const networkQuoted = BigInt(attempt.cctpFeeAtomic);
  return [
    env.PAYMENTS_DB.prepare(
      `INSERT OR IGNORE INTO payment_fee_ledger(id, attempt_id, intent_id, fee_type, bearer,
			 quoted_amount_atomic, actual_amount_atomic, recipient, status, policy_id, policy_version,
			 rule_id, source_chain_id, route, created_at, updated_at)
			 VALUES (?, ?, ?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `fee_${attempt.id}_platform`,
      attempt.id,
      attempt.intentId,
      attempt.platformFeeBearer,
      attempt.platformFeeAtomic,
      platformQuoted === 0n ? "0" : null,
      attempt.platformFeeRecipient,
      platformQuoted === 0n ? "waived" : "quoted",
      attempt.feePolicyId,
      attempt.feePolicyVersion,
      attempt.feeRuleId,
      attempt.sourceChainId,
      attempt.route,
      timestamp,
      timestamp,
    ),
    env.PAYMENTS_DB.prepare(
      `INSERT OR IGNORE INTO payment_fee_ledger(id, attempt_id, intent_id, fee_type, bearer,
			 quoted_amount_atomic, actual_amount_atomic, recipient, status, policy_id, policy_version,
			 rule_id, source_chain_id, route, created_at, updated_at)
			 VALUES (?, ?, ?, 'network', ?, ?, ?, NULL, ?, 'circle-cctp-v2', 1, ?, ?, ?, ?, ?)`,
    ).bind(
      `fee_${attempt.id}_network`,
      attempt.id,
      attempt.intentId,
      networkQuoted === 0n ? "none" : "payer",
      attempt.cctpFeeAtomic,
      networkQuoted === 0n ? "0" : null,
      networkQuoted === 0n ? "waived" : "quoted",
      attempt.route,
      attempt.sourceChainId,
      attempt.route,
      timestamp,
      timestamp,
    ),
  ];
}

function feeLine(row: FeeLedgerRow): PaymentFeeLine {
  return {
    type: row.fee_type,
    bearer: row.bearer,
    quotedAmountAtomic: row.quoted_amount_atomic,
    actualAmountAtomic: row.actual_amount_atomic,
    recipient: row.recipient,
    status: row.status,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    ruleId: row.rule_id,
  };
}

function feeBreakdown(rows: FeeLedgerRow[]): PaymentFeeBreakdown | null {
  const platformRow = rows.find((row) => row.fee_type === "platform");
  const networkRow = rows.find((row) => row.fee_type === "network");
  if (!platformRow || !networkRow) {
    return null;
  }
  const platform = feeLine(platformRow);
  const network = feeLine(networkRow);
  const actualKnown = platform.actualAmountAtomic !== null && network.actualAmountAtomic !== null;
  return {
    currency: "USDC",
    platform,
    network,
    totalQuotedAtomic: (
      BigInt(platform.quotedAmountAtomic) + BigInt(network.quotedAmountAtomic)
    ).toString(),
    totalActualAtomic: actualKnown
      ? (BigInt(platform.actualAmountAtomic!) + BigInt(network.actualAmountAtomic!)).toString()
      : null,
  };
}

export function actualFeeBreakdown(
  attempt: PaymentAttempt,
  platformActual: string,
  networkActual: string,
): PaymentFeeBreakdown {
  const platformValue = BigInt(platformActual);
  const networkValue = BigInt(networkActual);
  return {
    currency: "USDC",
    platform: {
      type: "platform",
      bearer: attempt.platformFeeBearer,
      quotedAmountAtomic: attempt.platformFeeAtomic,
      actualAmountAtomic: platformActual,
      recipient: attempt.platformFeeRecipient,
      status: platformValue === 0n ? "waived" : "charged",
      policyId: attempt.feePolicyId,
      policyVersion: attempt.feePolicyVersion,
      ruleId: attempt.feeRuleId,
    },
    network: {
      type: "network",
      bearer: networkValue === 0n ? "none" : "payer",
      quotedAmountAtomic: attempt.cctpFeeAtomic,
      actualAmountAtomic: networkActual,
      recipient: null,
      status: networkValue === 0n ? "waived" : "charged",
      policyId: "circle-cctp-v2",
      policyVersion: 1,
      ruleId: attempt.route,
    },
    totalQuotedAtomic: (
      BigInt(attempt.platformFeeAtomic) + BigInt(attempt.cctpFeeAtomic)
    ).toString(),
    totalActualAtomic: (platformValue + networkValue).toString(),
  };
}

export function freeFeeBreakdown(): PaymentFeeBreakdown {
  const freeLine = (type: "platform" | "network", policyId: string): PaymentFeeLine => ({
    type,
    bearer: "none",
    quotedAmountAtomic: "0",
    actualAmountAtomic: "0",
    recipient: null,
    status: "waived",
    policyId,
    policyVersion: 1,
    ruleId: "free-default",
  });
  return {
    currency: "USDC",
    platform: freeLine("platform", "free-default"),
    network: freeLine("network", "sandbox"),
    totalQuotedAtomic: "0",
    totalActualAtomic: "0",
  };
}

async function getAttemptFeeBreakdown(
  env: Bindings,
  attemptId: string,
): Promise<PaymentFeeBreakdown | null> {
  const rows = await env.PAYMENTS_DB.prepare(
    `SELECT fee_type, bearer, quoted_amount_atomic, actual_amount_atomic, recipient, status,
		 policy_id, policy_version, rule_id FROM payment_fee_ledger WHERE attempt_id = ? ORDER BY fee_type`,
  )
    .bind(attemptId)
    .all<FeeLedgerRow>();
  return feeBreakdown(rows.results);
}

export async function getPaymentIntentFeeBreakdown(
  env: Bindings,
  intentId: string,
): Promise<PaymentFeeBreakdown | null> {
  const attempt = await first<{ id: string }>(
    env,
    "SELECT id FROM payment_attempts WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1",
    [intentId],
  );
  return attempt ? getAttemptFeeBreakdown(env, attempt.id) : null;
}
