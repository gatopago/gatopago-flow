import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { paymentModeCapabilities } from "../src/services/capabilities";

const env = (overrides: Partial<Bindings> = {}) => ({
	SETTLEMENT_CHAIN_ID: "421614",
	PAYMENT_ENABLED_CHAIN_IDS: "421614,84532,43113",
	PAYMENT_LIVE_ENABLED: "false",
	...overrides,
}) as Bindings;

describe("payment mode capabilities", () => {
	it("keeps live mode disabled by operator policy", () => {
		expect(paymentModeCapabilities(env()).modes.live).toEqual({
			enabled: false,
			reason: "feature_flag_disabled",
		});
	});

	it("cannot enable real-money keys on a testnet settlement", () => {
		expect(paymentModeCapabilities(env({ PAYMENT_LIVE_ENABLED: "true" })).modes.live).toEqual({
			enabled: false,
			reason: "settlement_is_testnet",
		});
	});

	it("also requires deployed and enabled mainnet payment routes", () => {
		expect(paymentModeCapabilities(env({ PAYMENT_LIVE_ENABLED: "true",
			SETTLEMENT_CHAIN_ID: "42161", PAYMENT_ENABLED_CHAIN_IDS: "42161,8453" })).modes.live).toEqual({
			enabled: false,
			reason: "mainnet_routes_unavailable",
		});
	});
});
