import type { Hex } from "viem";
import type { Bindings } from "../../env";
import { discardResponseBody, readJsonBounded } from "../../services/http";

type CircleFee = { finalityThreshold: number; minimumFee: number };

export type CircleCctpMessage = {
	message: Hex;
	attestation: Hex;
	status: string;
	cctpVersion: number;
	decodedMessage?: {
		sourceDomain?: string;
		destinationDomain?: string;
		decodedMessageBody?: {
			burnToken?: string;
			mintRecipient?: string;
			amount?: string;
			messageSender?: string;
		};
	};
};

export class CircleFeeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CircleFeeError";
	}
}

function circleHeaders(env: Bindings): Record<string, string> {
	return {
		Accept: "application/json",
		...(env.CIRCLE_API_KEY ? { Authorization: `Bearer ${env.CIRCLE_API_KEY}` } : {}),
	};
}

function circleBaseUrl(env: Bindings): string {
	return env.CIRCLE_API_BASE_URL.replace(/\/+$/u, "");
}

export async function getLiveCctpFee(env: Bindings, input: {
	sourceDomain: number;
	destinationDomain: number;
	finalityThreshold: 1000 | 2000;
	settlementAmountAtomic: bigint;
}): Promise<{ minimumFeeBps: number; maxFeeAtomic: bigint; observedAt: string }> {
	const response = await fetch(
		`${circleBaseUrl(env)}/v2/burn/USDC/fees/${input.sourceDomain}/${input.destinationDomain}`,
		{ headers: circleHeaders(env), signal: AbortSignal.timeout(5_000) },
	);
	if (!response.ok) {
		await discardResponseBody(response);
		throw new CircleFeeError(`Circle fee API returned ${response.status}`);
	}
	const payload = await readJsonBounded<unknown>(response, 32 * 1024);
	if (!Array.isArray(payload)) throw new CircleFeeError("Circle fee response is malformed");
	const fee = payload.find((candidate): candidate is CircleFee => {
		if (!candidate || typeof candidate !== "object") return false;
		const value = candidate as Record<string, unknown>;
		return value.finalityThreshold === input.finalityThreshold &&
			typeof value.minimumFee === "number" && Number.isFinite(value.minimumFee) &&
			value.minimumFee >= 0 && value.minimumFee <= 100;
	});
	if (!fee) throw new CircleFeeError("Circle did not return the requested finality fee");

	const hundredthsOfBps = BigInt(Math.ceil(fee.minimumFee * 100));
	const denominator = 1_000_000n;
	const protocolFee = (input.settlementAmountAtomic * hundredthsOfBps + denominator - 1n) / denominator;
	const maxFeeAtomic = (protocolFee * 120n + 99n) / 100n;
	return { minimumFeeBps: fee.minimumFee, maxFeeAtomic, observedAt: new Date().toISOString() };
}

export async function getCctpMessages(env: Bindings, input: {
	sourceDomain: number;
	transactionHash: string;
}): Promise<CircleCctpMessage[] | null> {
	const url = `${circleBaseUrl(env)}/v2/messages/${input.sourceDomain}?transactionHash=${encodeURIComponent(input.transactionHash)}`;
	const response = await fetch(url, {
		headers: circleHeaders(env),
		signal: AbortSignal.timeout(8_000),
	});
	if (response.status === 404) {
		await discardResponseBody(response);
		return null;
	}
	if (!response.ok) {
		await discardResponseBody(response);
		throw new Error(`Circle messages API returned ${response.status}`);
	}
	const payload = await readJsonBounded<{ messages?: CircleCctpMessage[] }>(response, 256 * 1024);
	return payload.messages ?? [];
}
