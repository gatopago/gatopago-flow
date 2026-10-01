import { describe, expect, it, vi } from "vitest";
import { readJsonBounded } from "../src/services/http";
import { ResponseBodyTooLargeError } from "@gatopago/shared/http";

describe("Flow upstream body budget", () => {
	it("cancels an oversized stream before reading its remainder without Content-Length", async () => {
		let chunks = 0;
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks += 1;
				controller.enqueue(new Uint8Array(32 * 1024));
				if (chunks === 4) controller.close();
			},
			cancel,
		}, { highWaterMark: 0 });
		await expect(readJsonBounded(new Response(body))).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
		expect(chunks).toBe(3);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("discards a declared oversized response before reading it", async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
		await expect(readJsonBounded(new Response(body, { headers: { "Content-Length": "65537" } })))
			.rejects.toBeInstanceOf(ResponseBodyTooLargeError);
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("counts UTF-8 bytes, accepts exact limits and preserves JSON parsing", async () => {
		const json = '{"name":"á"}';
		const bytes = new TextEncoder().encode(json).byteLength;
		await expect(readJsonBounded(new Response(json), bytes)).resolves.toEqual({ name: "á" });
		await expect(readJsonBounded(new Response(json), bytes - 1)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
		await expect(readJsonBounded(new Response("invalid"))).rejects.toBeInstanceOf(SyntaxError);
	});

	it("cancels a stalled provider when its request deadline expires", async () => {
		const cancel = vi.fn();
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const result = readJsonBounded(new Response(body), 64, controller.signal);
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});
});
