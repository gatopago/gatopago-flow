import { getAddress, isAddress, parseUnits, type Address } from "viem";

export class DomainValidationError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "DomainValidationError";
	}
}

export function walletAddress(value: unknown): Address {
	if (typeof value !== "string" || !isAddress(value, { strict: false })) {
		throw new DomainValidationError("INVALID_WALLET", "Invalid wallet address");
	}
	return getAddress(value);
}

export function amount(value: unknown): { decimal: string; atomic: string } {
	if (typeof value !== "string" && typeof value !== "number") {
		throw new DomainValidationError("INVALID_AMOUNT", "Amount must be a positive USDC value");
	}
	const decimal = String(value).trim();
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(decimal)) {
		throw new DomainValidationError("INVALID_AMOUNT", "Amount must use at most 6 decimals");
	}
	const atomic = parseUnits(decimal, 6);
	if (atomic <= 0n) throw new DomainValidationError("INVALID_AMOUNT", "Amount must be greater than zero");
	return { decimal, atomic: atomic.toString() };
}

export function optionalAmount(value: unknown): {
	decimal: string;
	atomic: string;
	mode: "fixed" | "payer_defined";
} {
	if (value === undefined || value === null || String(value).trim() === "") {
		return { decimal: "0", atomic: "0", mode: "payer_defined" };
	}
	return { ...amount(value), mode: "fixed" };
}

export function shortText(value: unknown, max: number, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string") throw new DomainValidationError("INVALID_TEXT", "Expected text");
	const normalized = value.trim();
	if (normalized.length > max) throw new DomainValidationError("INVALID_TEXT", `Text exceeds ${max} characters`);
	return normalized;
}

export function metadata(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new DomainValidationError("INVALID_METADATA", "Metadata must be an object");
	}
	const encoded = JSON.stringify(value);
	if (encoded.length > 8_192) throw new DomainValidationError("INVALID_METADATA", "Metadata is too large");
	return value as Record<string, unknown>;
}

export function futureExpiry(value: unknown, defaultMinutes = 60): string {
	if (value === undefined || value === null) return new Date(Date.now() + defaultMinutes * 60_000).toISOString();
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new DomainValidationError("INVALID_EXPIRY", "Invalid expiry timestamp");
	}
	const time = Date.parse(value);
	if (time <= Date.now() || time > Date.now() + 7 * 24 * 60 * 60_000) {
		throw new DomainValidationError("INVALID_EXPIRY", "Expiry must be within the next 7 days");
	}
	return new Date(time).toISOString();
}
