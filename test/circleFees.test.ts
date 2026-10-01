import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import type { PaymentIntent } from "../src/domain/models";
import { CircleFeeError, getLiveCctpFee } from "../src/rails/onchain/circleClient";
import { buildQuote } from "../src/services/quoteEngine";

const payer = "0x00000000000000000000000000000000000000b2" as const;
const intent: PaymentIntent = {
	id: "pi_fee", merchantId: "mrc_fee", linkId: "link_fee", amount: "10", amountAtomic: "10000000",
	amountMode: "fixed",
	currency: "USDC", reference: "Fee test", metadata: {}, mode: "test", status: "awaiting_payment",
	settlementWallet: "0x00000000000000000000000000000000000000a1", settlementChainId: 421614,
	settlementAccountVersion: 1, paidAmountAtomic: "0", paidTxHash: null, paidAt: null, expiresAt: null,
	createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
};
const bindings = {
	PAYMENT_ENABLED_CHAIN_IDS: "421614,84532,43113",
	PAYMENT_AUTHORIZATION_TTL_SECONDS: "600", SETTLEMENT_CHAIN_ID: "421614",
	CIRCLE_API_BASE_URL: "https://iris-api-sandbox.circle.com",
} as Bindings;

afterEach(() => vi.unstubAllGlobals());

describe("live CCTP fees", () => {
	it("rounds a live decimal fee up and adds only the visible ceiling", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json([
			{ finalityThreshold: 1000, minimumFee: 1.3 },
			{ finalityThreshold: 2000, minimumFee: 0 },
		])));
		await expect(getLiveCctpFee(bindings, { sourceDomain: 6, destinationDomain: 3,
			finalityThreshold: 1000, settlementAmountAtomic: 10_000_000n })).resolves.toMatchObject({
			minimumFeeBps: 1.3, maxFeeAtomic: 1_560n,
		});
	});

	it.each([
		["unavailable", vi.fn(async () => new Response("upstream", { status: 503 }))],
		["malformed", vi.fn(async () => Response.json({ minimumFee: 1.3 }))],
		["timed out", vi.fn(async () => { throw new DOMException("Circle fee request timed out", "TimeoutError"); })],
	])("fails closed when Circle is %s", async (_case, fetchMock) => {
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLiveCctpFee(bindings, { sourceDomain: 6, destinationDomain: 3,
			finalityThreshold: 1000, settlementAmountAtomic: 10_000_000n })).rejects.toBeInstanceOf(
			_case === "timed out" ? DOMException : CircleFeeError,
		);
	});

	it("selects Base Fast/Standard and keeps Avalanche Standard-only", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json([
			{ finalityThreshold: 1000, minimumFee: 1 },
			{ finalityThreshold: 2000, minimumFee: 0 },
		])));
		await expect(buildQuote(bindings, { intent, payer, sourceChainId: 84532 })).resolves.toMatchObject({ route: "cctp_fast" });
		await expect(buildQuote(bindings, { intent, payer, sourceChainId: 84532, requestedRoute: "standard" })).resolves.toMatchObject({ route: "cctp_standard" });
		await expect(buildQuote(bindings, { intent, payer, sourceChainId: 43113 })).resolves.toMatchObject({ route: "cctp_standard" });
		await expect(buildQuote(bindings, { intent, payer, sourceChainId: 43113, requestedRoute: "fast" }))
			.rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
	});

	it("rejects an expired intent before producing calldata", async () => {
		await expect(buildQuote(bindings, { intent: { ...intent, expiresAt: "2020-01-01T00:00:00.000Z" },
			payer, sourceChainId: 421614 })).rejects.toMatchObject({ code: "INTENT_EXPIRED" });
	});
});
