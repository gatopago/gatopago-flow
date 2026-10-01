import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import type { PaymentIntent } from "../src/domain/models";
import { FeePolicyError, resolvePaymentFee } from "../src/services/feePolicy";

const intent: PaymentIntent = {
	id: "pi_fee_policy",
	merchantId: "mrc_fee_policy",
	linkId: "link_fee_policy",
	amount: "10",
	amountAtomic: "10000000",
	amountMode: "fixed",
	currency: "USDC",
	reference: "Order",
	metadata: {},
	mode: "live",
	status: "awaiting_payment",
	settlementWallet: "0x00000000000000000000000000000000000000A1",
	settlementChainId: 421614,
	settlementAccountVersion: 1,
	paidAmountAtomic: "0",
	paidTxHash: null,
	paidAt: null,
	expiresAt: null,
	createdAt: "2026-08-24T00:00:00.000Z",
	updatedAt: "2026-08-24T00:00:00.000Z",
};

function environment(policy?: unknown): Bindings {
	return {
		PAYMENT_FEE_POLICY_JSON: policy === undefined ? undefined : JSON.stringify(policy),
		PAYMENT_PLATFORM_FEE_RECIPIENT: "0x00000000000000000000000000000000000000f1",
		PAYMENT_ROUTER_PREFLIGHT_ENABLED: "true",
	} as Bindings;
}

describe("payment fee policy", () => {
	it("is free when no explicit versioned rule exists", () => {
		const resolved = resolvePaymentFee(environment(), { intent, sourceChainId: 421614,
			route: "local", routeFeeCapBps: 100 });
		expect(resolved).toMatchObject({ policyId: "free-default", ruleId: "free-default",
			platformFeeBps: 0, platformFeeAtomic: "0", platformFeeBearer: "none",
			platformFeeRecipient: null });
	});

	it("charges only when an explicit scoped rule matches", () => {
		const env = environment({ policyId: "commercial-v3", version: 3, rules: [
			{ id: "fast-live", priority: 100, feeBps: 25, modes: ["live"],
				merchantIds: [intent.merchantId], routes: ["cctp_fast"], sourceChainIds: [84532] },
		] });
		const charged = resolvePaymentFee(env, { intent, sourceChainId: 84532,
			route: "cctp_fast", routeFeeCapBps: 100 });
		expect(charged).toMatchObject({ policyId: "commercial-v3", policyVersion: 3,
			ruleId: "fast-live", platformFeeBps: 25, platformFeeAtomic: "25000",
			platformFeeBearer: "payer" });
		const unmatched = resolvePaymentFee(env, { intent, sourceChainId: 421614,
			route: "local", routeFeeCapBps: 100 });
		expect(unmatched.platformFeeAtomic).toBe("0");
	});

	it("fails before signing when policy exceeds the deployed router cap", () => {
		const env = environment({ policyId: "commercial-v1", version: 1,
			rules: [{ id: "base-fee", priority: 1, feeBps: 1, sourceChainIds: [84532] }] });
		expect(() => resolvePaymentFee(env, { intent, sourceChainId: 84532,
			route: "cctp_standard", routeFeeCapBps: 0 }))
			.toThrowError(expect.objectContaining<Partial<FeePolicyError>>({ code: "ROUTER_FEE_CAP_EXCEEDED" }));
	});

	it("fails closed when equal-priority rules disagree", () => {
		const env = environment({ policyId: "ambiguous-v1", version: 1, rules: [
			{ id: "one", priority: 10, feeBps: 10 },
			{ id: "two", priority: 10, feeBps: 20 },
		] });
		expect(() => resolvePaymentFee(env, { intent, sourceChainId: 421614,
			route: "local", routeFeeCapBps: 100 }))
			.toThrowError(expect.objectContaining<Partial<FeePolicyError>>({ code: "AMBIGUOUS_FEE_POLICY" }));
	});

	it("cannot enable a paid rule while on-chain preflight is disabled", () => {
		const env = environment({ policyId: "commercial-v1", version: 1,
			rules: [{ id: "local-fee", priority: 1, feeBps: 10, routes: ["local"] }] });
		env.PAYMENT_ROUTER_PREFLIGHT_ENABLED = "false";
		expect(() => resolvePaymentFee(env, { intent, sourceChainId: 421614,
			route: "local", routeFeeCapBps: 100 }))
			.toThrowError(expect.objectContaining<Partial<FeePolicyError>>({ code: "ROUTER_PREFLIGHT_REQUIRED" }));
	});

	it("rejects unknown scope fields instead of accidentally making a rule global", () => {
		const env = environment({ policyId: "commercial-v1", version: 1, rules: [
			{ id: "typo", priority: 1, feeBps: 10, merchantId: intent.merchantId },
		] });
		expect(() => resolvePaymentFee(env, { intent, sourceChainId: 421614,
			route: "local", routeFeeCapBps: 100 }))
			.toThrowError(expect.objectContaining<Partial<FeePolicyError>>({ code: "INVALID_FEE_POLICY" }));
	});
});
