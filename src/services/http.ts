import { readJsonBounded as readSharedJsonBounded } from "@gatopago/shared/http";

export { discardResponseBody } from "@gatopago/shared/http";

// Keep Flow's smaller provider budget while sharing streaming/cancellation semantics.
export function readJsonBounded<T>(response: Response, maxBytes = 64 * 1024, signal?: AbortSignal): Promise<T> {
	return readSharedJsonBounded<T>(response, maxBytes, signal);
}
