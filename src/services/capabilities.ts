import { getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import type { Bindings } from "../env";

type LivePaymentReason =
	| "feature_flag_disabled"
	| "settlement_network_unknown"
	| "settlement_is_testnet"
	| "mainnet_routes_unavailable";

type PaymentModeCapabilities = {
	settlement: { chainId: number | null; name: string | null; isTestnet: boolean | null };
	modes: {
		test: { enabled: true };
		live: { enabled: boolean; reason: LivePaymentReason | null };
	};
};

function enabledChainIds(env: Bindings): number[] {
	return env.PAYMENT_ENABLED_CHAIN_IDS.split(",")
		.map((value) => Number(value.trim()))
		.filter(Number.isSafeInteger);
}

/** Live mode needs both an operator flag and an actually routable mainnet. */
export function paymentModeCapabilities(env: Bindings, settlementChainId?: number | null): PaymentModeCapabilities {
	const configuredSettlement = settlementChainId ?? Number(env.SETTLEMENT_CHAIN_ID);
	const chainId = Number.isSafeInteger(configuredSettlement) ? configuredSettlement : null;
	const settlement = chainId === null ? null : getPaymentNetworkCapabilities(chainId);
	let reason: LivePaymentReason | null = null;
	if (env.PAYMENT_LIVE_ENABLED !== "true") reason = "feature_flag_disabled";
	else if (!settlement) reason = "settlement_network_unknown";
	else if (settlement.isTestnet) reason = "settlement_is_testnet";
	else {
		const hasRoutableMainnetSource = enabledChainIds(env).some((sourceChainId) => {
			const source = getPaymentNetworkCapabilities(sourceChainId);
			return source?.isTestnet === false && source.paymentSource && source.settlementChainId === chainId &&
				Boolean(source.localPaymentRouter || source.cctpPaymentRouter);
		});
		if (!hasRoutableMainnetSource) reason = "mainnet_routes_unavailable";
	}
	return {
		settlement: { chainId, name: settlement?.name ?? null, isTestnet: settlement?.isTestnet ?? null },
		modes: { test: { enabled: true }, live: { enabled: reason === null, reason } },
	};
}
