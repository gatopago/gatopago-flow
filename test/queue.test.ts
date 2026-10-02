import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { consumeFlowQueue } from "../src/services/jobs";
import {
	enqueuePaymentJob,
	schedulePaymentJob,
} from "../src/services/queue";

function testEnv(options: { scheduler?: boolean } = {}) {
	const send = vi.fn<(message: unknown, options?: unknown) => Promise<void>>().mockResolvedValue(undefined);
	const schedule = vi.fn<(input: unknown) => Promise<{ accepted: true; generation: number; runAt: number }>>()
		.mockResolvedValue({ accepted: true, generation: 1, runAt: Date.now() });
	const env = {
		PAYMENT_JOBS_QUEUE: { send },
		...(options.scheduler ? { PAYMENT_JOB_SCHEDULER: { getByName: vi.fn(() => ({ schedule })) } } : {}),
	} as unknown as Bindings;
	return { env, send, schedule };
}

describe("Payments job scheduling", () => {
	it("retries a Queue name that does not match the configured transport", async () => {
		const ackAll = vi.fn();
		const retryAll = vi.fn();
		const batch = {
			queue: "unexpected-payment-queue",
			messages: [],
			ackAll,
			retryAll,
		} as unknown as MessageBatch<unknown>;
		await consumeFlowQueue(batch, { PAYMENT_JOBS_QUEUE_NAME: "configured-queue" } as Bindings);
		expect(ackAll).not.toHaveBeenCalled();
		expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 15 });
	});

	it("publishes immediate work directly with a versioned partitioned message", async () => {
		const { env, send } = testEnv({ scheduler: true });
		await enqueuePaymentJob(env, { job: "router_watch", resourceId: "421614", partition: "421614" });
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toMatchObject({ messageVersion: 2, job: "router_watch",
			resourceId: "421614", partition: "421614", attempt: 0 });
		expect(send.mock.calls[0]?.[1]).toEqual({ contentType: "json" });
	});

	it("coalesces delayed work through the partition Durable Object", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
		try {
			const { env, send, schedule } = testEnv({ scheduler: true });
			await schedulePaymentJob(env, { job: "cctp_attestation", resourceId: "op_1",
				dedupeKey: "cctp-attestation:op_1", partition: "421614", delaySeconds: 5 });
			expect(send).not.toHaveBeenCalled();
			expect(schedule).toHaveBeenCalledWith({ job: "cctp_attestation", resourceId: "op_1",
				dedupeKey: "cctp-attestation:op_1", partition: "421614", runAt: Date.parse("2026-08-25T12:00:05.000Z") });
		} finally { vi.useRealTimers(); }
	});

	it("rejects missing scheduler bindings without switching to Queue delay", async () => {
		const { env, send } = testEnv();
		await expect(schedulePaymentJob(env, { job: "cctp_attestation", resourceId: "op_2",
			partition: "84532", delaySeconds: 5 })).rejects.toThrow("Payment job scheduler is unavailable");
		expect(send).not.toHaveBeenCalled();
	});

	it("schedules zero-delay work through the same Durable Object", async () => {
		const { env, send, schedule } = testEnv({ scheduler: true });
		await schedulePaymentJob(env, { job: "cctp_attestation", resourceId: "op_3", delaySeconds: 0 });
		expect(schedule).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects negative and fractional delays", async () => {
		const { env } = testEnv();
		await expect(schedulePaymentJob(env, { job: "router_watch", resourceId: "1", delaySeconds: -1 })).rejects.toThrow("non-negative integer");
		await expect(schedulePaymentJob(env, { job: "router_watch", resourceId: "1", delaySeconds: 1.5 })).rejects.toThrow("non-negative integer");
	});
});
