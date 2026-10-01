import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Bindings } from "../src/env";
import { paymentPublicClient } from "../src/services/clients";
import {
	assertPaymentRouterReadyForAuthorization,
	collectPaymentRouterHealth,
	type PaymentRouterObservation,
	type PaymentRouterTarget,
	validatePaymentRouterPreflightConfig,
} from "../src/services/routerHealth";

const AUTHORIZATION_KEY = `0x${"11".repeat(32)}` as const;
const TREASURY = "0x00000000000000000000000000000000000000f1" as const;

function environment(extra: Partial<Bindings> = {}): Bindings {
	return {
		PAYMENT_ENABLED_CHAIN_IDS: "421614",
		PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY: AUTHORIZATION_KEY,
		PAYMENT_AUTHORIZATION_TTL_SECONDS: "600",
		PAYMENT_ROUTER_PREFLIGHT_ENABLED: "true",
		PAYMENT_RPC_URLS: JSON.stringify({ 421614: ["https://rpc-one.example", "https://rpc-two.example"] }),
		...extra,
	} as Bindings;
}

function healthy(target: PaymentRouterTarget, extra: Partial<PaymentRouterObservation> = {}): PaymentRouterObservation {
	return {
		codePresent: true,
		maxPlatformFeeBps: BigInt(target.declaredMaxPlatformFeeBps),
		usdc: target.usdc,
		treasury: TREASURY,
		authorizationSigner: privateKeyToAccount(AUTHORIZATION_KEY).address,
		paused: false,
		tokenMessenger: target.tokenMessenger,
		settlementChainId: target.kind === "cctp" ? BigInt(target.settlementChainId) : null,
		fastTransferEnabled: target.fastTransferEnabled,
		...extra,
	};
}

describe("payment router preflight", () => {
	it("uses the canonical Multicall3 deployment to keep each router observation bounded", () => {
		const client = paymentPublicClient(environment(), 421614);
		expect(client.chain?.contracts?.multicall3?.address.toLowerCase())
			.toBe("0xca11bde05977b3631167028862be2a173976ca11");
	});

	it("validates the deployed execution surface against the signer and immutable manifest", async () => {
		const health = await collectPaymentRouterHealth(environment(), async (_env, target) => healthy(target));

		expect(health).toMatchObject({ status: "ok", issues: [], routes: [
			{ chainId: 421614, kind: "local", status: "ok", observedMaxPlatformFeeBps: "100" },
		] });
	});

	it("does not require treasury equality while the commercial policy remains free", async () => {
		const health = await collectPaymentRouterHealth(environment(), async (_env, target) => healthy(target, {
			treasury: "0x00000000000000000000000000000000000000a2",
		}));

		expect(health.status).toBe("ok");
	});

	it("fails closed on signer, pause or treasury drift before signing a paid authorization", async () => {
		const env = environment({
			PAYMENT_PLATFORM_FEE_RECIPIENT: TREASURY,
			PAYMENT_FEE_POLICY_JSON: JSON.stringify({ policyId: "paid-v1", version: 1, rules: [
				{ id: "local", priority: 1, feeBps: 25, routes: ["local"] },
			] }),
		});
		const reader = async (_env: Bindings, target: PaymentRouterTarget) => healthy(target, {
			authorizationSigner: "0x00000000000000000000000000000000000000a3",
			treasury: "0x00000000000000000000000000000000000000a4",
			paused: true,
		});
		const health = await collectPaymentRouterHealth(env, reader);

		expect(health.status).toBe("error");
		expect(health.issues).toEqual(expect.arrayContaining([
			"payment_router_421614_local_authorization_signer_mismatch",
			"payment_router_421614_local_treasury_mismatch",
			"payment_router_421614_local_paused",
		]));
		await expect(assertPaymentRouterReadyForAuthorization(env, {
			chainId: 421614,
			route: "local",
			platformFeeBps: 25,
			platformFeeRecipient: TREASURY,
		}, reader)).rejects.toThrow("preflight failed");
	});

	it("does not call RPC when preflight is deliberately disabled for a free test environment", async () => {
		const reader = vi.fn();
		const health = await collectPaymentRouterHealth(environment({
			PAYMENT_ROUTER_PREFLIGHT_ENABLED: "false",
		}), reader);

		expect(health.status).toBe("disabled");
		expect(reader).not.toHaveBeenCalled();
	});

	it("reports a malformed fee policy as degraded instead of throwing from health", async () => {
		const env = environment({ PAYMENT_FEE_POLICY_JSON: "{" });
		const health = await collectPaymentRouterHealth(env, async (_env, target) => healthy(target));

		expect(health.status).toBe("error");
		expect(health.issues).toContain("payment_fee_policy_invalid");
		expect(validatePaymentRouterPreflightConfig(env)).toContain("PAYMENT_FEE_POLICY_INVALID");
	});

	it("keeps health available with recent public observations but still fails authorization closed", async () => {
		const env = environment();
		await collectPaymentRouterHealth(env, async (_env, target) => healthy(target));
		const unavailable = async () => { throw new Error("rpc unavailable"); };
		const health = await collectPaymentRouterHealth(env, unavailable);

		expect(health.status).toBe("degraded");
		expect(health.routes[0]).toMatchObject({ status: "degraded",
			issues: ["payment_router_421614_local_rpc_stale"] });
		await expect(assertPaymentRouterReadyForAuthorization(env, {
			chainId: 421614, route: "local", platformFeeBps: 0, platformFeeRecipient: null,
		}, unavailable)).rejects.toThrow("rpc_unavailable");
	});

	it("requires two distinct RPC providers for every enabled preflight chain", () => {
		const issues = validatePaymentRouterPreflightConfig(environment({
			PAYMENT_RPC_URLS: JSON.stringify({ 421614: ["https://only-one.example/rpc"] }),
		}));
		expect(issues).toContain("PAYMENT_RPC_URLS_421614_REDUNDANCY_REQUIRED");
	});
});
