import { createPublicClient, createWalletClient, defineChain, fallback, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import type { Bindings } from "../env";

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

function configuredRpcMap(env: Bindings): Record<string, unknown> {
	if (!env.PAYMENT_RPC_URLS) throw new Error("PAYMENT_RPC_URLS is not configured");
	let parsed: unknown;
	try { parsed = JSON.parse(env.PAYMENT_RPC_URLS); } catch { throw new Error("PAYMENT_RPC_URLS is malformed"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PAYMENT_RPC_URLS is malformed");
	return parsed as Record<string, unknown>;
}

function urls(env: Bindings, chainId: number): string[] {
	const values = configuredRpcMap(env)[String(chainId)];
	if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !/^https:\/\//u.test(value))) {
		throw new Error(`No HTTPS payment RPC configured for chain ${chainId}`);
	}
	return [...new Set(values as string[])];
}

export function validatePaymentRpcRedundancy(env: Bindings, chainIds: number[]): string[] {
	let parsed: Record<string, unknown>;
	try { parsed = configuredRpcMap(env); }
	catch { return ["PAYMENT_RPC_URLS_INVALID"]; }
	const issues: string[] = [];
	for (const chainId of chainIds) {
		const values = parsed[String(chainId)];
		if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !/^https:\/\//u.test(value))) {
			issues.push(`PAYMENT_RPC_URLS_${chainId}_INVALID`);
			continue;
		}
		const providers = new Set(values.map((value) => {
			try { return new URL(value).hostname.toLowerCase(); }
			catch { return ""; }
		}).filter(Boolean));
		if (providers.size < 2) issues.push(`PAYMENT_RPC_URLS_${chainId}_REDUNDANCY_REQUIRED`);
	}
	return issues;
}

function paymentChain(chainId: number): Chain {
	const config = getPaymentNetworkCapabilities(chainId);
	if (!config) throw new Error(`Unsupported payment chain ${chainId}`);
	return defineChain({ id: chainId, name: config.name, nativeCurrency: { name: "Native", symbol: chainId === 43113 || chainId === 43114 ? "AVAX" : "ETH", decimals: 18 },
		rpcUrls: { default: { http: ["https://configured-at-runtime.invalid"] } },
		contracts: { multicall3: { address: MULTICALL3_ADDRESS } }, testnet: config.isTestnet });
}

export function paymentPublicClient(env: Bindings, chainId: number): PublicClient {
	return createPublicClient({ chain: paymentChain(chainId),
		transport: fallback(urls(env, chainId).map((url) => http(url, { timeout: 8_000, retryCount: 1 })), { rank: true }) });
}

export function paymentWalletClient(env: Bindings, chainId: number) {
	const key = env.PAYMENT_RELAYER_PRIVATE_KEY;
	if (!key || !/^(?:0x)?[0-9a-fA-F]{64}$/u.test(key)) throw new Error("Payment relayer key is not configured");
	return createWalletClient({ account: privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`),
		chain: paymentChain(chainId), transport: fallback(urls(env, chainId).map((url) => http(url, { timeout: 10_000, retryCount: 1 })), { rank: true }) });
}

export function requiredConfirmations(env: Bindings, chainId: number): number {
	if (!env.PAYMENT_CONFIRMATIONS_JSON) return getPaymentNetworkCapabilities(chainId)?.isTestnet ? 2 : 12;
	try {
		const value = (JSON.parse(env.PAYMENT_CONFIRMATIONS_JSON) as Record<string, unknown>)[String(chainId)];
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1_000 ? value : 12;
	} catch { throw new Error("PAYMENT_CONFIRMATIONS_JSON is malformed"); }
}
