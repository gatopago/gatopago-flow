import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { paymentAuthorizationDomain, paymentAuthorizationTypes } from "@gatopago/shared/payment-authorizations";

describe("local router authorization", () => {
	it("does not validate after an economic field is manipulated", async () => {
		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		const typed = {
			domain: { ...paymentAuthorizationDomain, chainId: 421614,
				verifyingContract: "0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4" as const },
			types: paymentAuthorizationTypes,
			primaryType: "PaymentAuthorization" as const,
			message: { intentId: `0x${"01".repeat(32)}` as const, attemptId: `0x${"02".repeat(32)}` as const,
				payer: account.address, merchant: "0x0000000000000000000000000000000000000001" as const,
				settlementAmount: 1_000_000n, platformFee: 0n, validAfter: 1,
				validUntil: 2_000_000_000, metadataHash: `0x${"00".repeat(32)}` as const },
		};
		const signature = await account.signTypedData(typed);
		expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
		expect(await recoverTypedDataAddress({ ...typed, message: { ...typed.message, settlementAmount: 2_000_000n }, signature })).not.toBe(account.address);
	});
});
