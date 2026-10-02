import type { PaymentIntent, PaymentLink } from "./models";
import type { PaymentFeeBreakdown, PaymentFeeLine } from "@gatopago/shared/fees";

export function publicIntent(intent: PaymentIntent): Record<string, unknown> {
  const unconfirmedOpenAmount =
    intent.amountMode === "payer_defined" && intent.paidAmountAtomic === "0";
  const publicAmount = unconfirmedOpenAmount ? "0" : intent.amount;
  const publicAmountAtomic = unconfirmedOpenAmount ? "0" : intent.amountAtomic;
  const expected = BigInt(publicAmountAtomic);
  const paid = BigInt(intent.paidAmountAtomic);
  return {
    id: intent.id,
    object: "payment_intent",
    amount: publicAmount,
    amount_atomic: publicAmountAtomic,
    amount_mode: intent.amountMode,
    currency: intent.currency,
    reference: intent.reference,
    metadata: intent.metadata,
    status: intent.status,
    mode: intent.mode,
    tx_hash: intent.paidTxHash,
    paid_at: intent.paidAt,
    paid_amount_atomic: intent.paidAmountAtomic,
    overpaid_amount_atomic: paid > expected ? (paid - expected).toString() : "0",
    settlement_chain_id: intent.settlementChainId,
    expires_at: intent.expiresAt,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

export function publicFeeBreakdown(
  fees: PaymentFeeBreakdown | null,
): Record<string, unknown> | null {
  if (!fees) {
    return null;
  }
  const line = (value: PaymentFeeLine) => ({
    type: value.type,
    bearer: value.bearer,
    quoted_amount_atomic: value.quotedAmountAtomic,
    actual_amount_atomic: value.actualAmountAtomic,
    recipient: value.recipient,
    status: value.status,
    policy_id: value.policyId,
    policy_version: value.policyVersion,
    rule_id: value.ruleId,
  });
  return {
    currency: fees.currency,
    platform: line(fees.platform),
    network: line(fees.network),
    total_quoted_atomic: fees.totalQuotedAtomic,
    total_actual_atomic: fees.totalActualAtomic,
  };
}

export function publicLink(link: PaymentLink): Record<string, unknown> {
  return {
    id: link.id,
    intentId: link.intentId,
    amount: link.amount,
    currency: link.currency,
    reference: link.reference,
    wallet: link.wallet,
    status: link.status,
    txHash: link.txHash,
    paidAt: link.paidAt,
    paidBy: link.paidBy,
    createdAt: link.createdAt,
  };
}
