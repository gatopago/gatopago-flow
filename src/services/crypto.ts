import { bytesToHex, keccak256, toBytes, type Hex } from "viem";

export function sha256Hex(value: string): Promise<string> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
		.then((digest) => bytesToHex(new Uint8Array(digest)));
}

export function stableMetadataHash(metadata: unknown): Hex {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return keccak256(toBytes("{}"));
	const record = metadata as Record<string, unknown>;
	const stable = JSON.stringify(Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])));
	return keccak256(toBytes(stable));
}

export function uuidHash(id: string): Hex {
	return keccak256(toBytes(id));
}

export function randomSecret(bytes = 32): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes))).slice(2);
}
