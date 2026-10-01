import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { paymentRouterAbi } from "@gatopago/shared/payment-abis";
import type { PaymentAttempt, PaymentIntent } from "../src/domain/models";
import {
	PaymentSourceEvidenceMismatchError,
	validatePaymentSourceReceipt,
} from "../src/services/reconciliation";

const payer = "0x00000000000000000000000000000000000000a1" as const;
const merchant = "0x00000000000000000000000000000000000000b2" as const;
const router = "0x00000000000000000000000000000000000000c3" as const;
const attemptHash = `0x${"11".repeat(32)}` as Hex;
const intentHash = `0x${"22".repeat(32)}` as Hex;
const metadataHash = `0x${"33".repeat(32)}` as Hex;

const attempt = {
	id: "pat_evidence",
	attemptHash,
	intentId: "pi_evidence",
	payerAddress: payer,
	sourceChainId: 421614,
	route: "local",
	routerAddress: router,
	authorization: { intentId: intentHash },
	settlementAmountAtomic: "10000000",
	platformFeeAtomic: "0",
} as unknown as PaymentAttempt;

const intent = {
	id: "pi_evidence",
	settlementWallet: merchant,
} as unknown as PaymentIntent;

function settledLog(overrides: { attemptId?: Hex; payer?: `0x${string}` } = {}) {
	const eventPayer = overrides.payer ?? payer;
	return {
		address: router,
		topics: encodeEventTopics({
			abi: paymentRouterAbi,
			eventName: "PaymentSettled",
			args: { intentId: intentHash, attemptId: overrides.attemptId ?? attemptHash, payer: eventPayer },
		}),
		data: encodeAbiParameters(
			[
				{ name: "merchant", type: "address" },
				{ name: "settlementAmount", type: "uint256" },
				{ name: "platformFee", type: "uint256" },
				{ name: "metadataHash", type: "bytes32" },
			],
			[merchant, 10_000_000n, 0n, metadataHash],
		),
	};
}

function receipt(overrides: Record<string, unknown> = {}) {
	return {
		status: "success",
		from: payer,
		to: router,
		logs: [settledLog()],
		...overrides,
	} as never;
}

describe("reported checkout transaction evidence", () => {
	it("accepts only the receipt emitted by the signed router for the signed attempt", () => {
		const result = validatePaymentSourceReceipt({ attempt, intent, receipt: receipt() });
		expect(result.args).toMatchObject({
			intentId: intentHash,
			attemptId: attemptHash,
			payer: getAddress(payer),
			merchant: getAddress(merchant),
			settlementAmount: 10_000_000n,
			platformFee: 0n,
		});
	});

	it.each([
		["wrong transaction sender", receipt({ from: merchant })],
		["wrong transaction target", receipt({ to: merchant })],
		["missing router event", receipt({ logs: [] })],
		["event for another attempt", receipt({ logs: [settledLog({ attemptId: `0x${"44".repeat(32)}` })] })],
		["reverted receipt", receipt({ status: "reverted" })],
	])("rejects %s", (_label, candidate) => {
		expect(() => validatePaymentSourceReceipt({ attempt, intent, receipt: candidate }))
			.toThrow(PaymentSourceEvidenceMismatchError);
	});
});
