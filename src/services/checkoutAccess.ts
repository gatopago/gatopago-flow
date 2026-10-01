import {
	hashMessage,
	recoverMessageAddress,
	type Address,
	type Hex,
} from "viem";
import type { PaymentQuote } from "../domain/models";

export const CHECKOUT_CAPABILITY_HEADER = "X-GatoPago-Checkout-Capability";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CAPABILITY_HASH_PATTERN = /^0x[0-9a-f]{64}$/u;
const SIGNATURE_PATTERN = /^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/iu;

export function isCheckoutCapability(value: unknown): value is string {
	return typeof value === "string" && CAPABILITY_PATTERN.test(value);
}

export function isCheckoutCapabilityHash(value: unknown): value is Hex {
	return typeof value === "string" && CAPABILITY_HASH_PATTERN.test(value);
}

export function isCheckoutProofSignature(value: unknown): value is Hex {
	return typeof value === "string" && SIGNATURE_PATTERN.test(value);
}

export async function hashCheckoutCapability(capability: string): Promise<Hex> {
	if (!isCheckoutCapability(capability)) throw new Error("Invalid checkout capability");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
	return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function checkoutPayerProofMessage(input: {
	linkId: string;
	quote: PaymentQuote;
	capabilityHash: Hex;
}): string {
	return [
		"GatoPago Checkout Authorization",
		"",
		"This signature authorizes one checkout attempt. It does not move funds.",
		"Version: 1",
		`Link: ${input.linkId}`,
		`Quote: ${input.quote.id}`,
		`Quote hash: ${input.quote.quoteHash.toLowerCase()}`,
		`Payer: ${input.quote.payer.toLowerCase()}`,
		`Source chain: ${input.quote.sourceChainId}`,
		`Capability hash: ${input.capabilityHash.toLowerCase()}`,
		`Expires at: ${input.quote.expiresAt}`,
	].join("\n");
}

export async function verifyCheckoutPayerProof(input: {
	message: string;
	payer: Address;
	signature: Hex;
}): Promise<{ valid: boolean; messageHash: Hex }> {
	const messageHash = hashMessage(input.message);
	try {
		const recovered = await recoverMessageAddress({ message: input.message, signature: input.signature });
		return { valid: recovered.toLowerCase() === input.payer.toLowerCase(), messageHash };
	} catch {
		return { valid: false, messageHash };
	}
}
