import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimPaymentJob: vi.fn(), claimWebhookDelivery: vi.fn(), completePaymentJob: vi.fn(),
	failPaymentJob: vi.fn(), listWebhookDeliveryJobs: vi.fn(), recordWebhookNetworkFailure: vi.fn(),
	recordWebhookResponse: vi.fn(), decryptWebhookSecret: vi.fn(),
}));

vi.mock("../src/stores/jobStore", () => ({
	claimPaymentJob: mocks.claimPaymentJob,
	claimWebhookDelivery: mocks.claimWebhookDelivery,
	completePaymentJob: mocks.completePaymentJob,
	failPaymentJob: mocks.failPaymentJob,
	listWebhookDeliveryJobs: mocks.listWebhookDeliveryJobs,
	recordWebhookNetworkFailure: mocks.recordWebhookNetworkFailure,
	recordWebhookResponse: mocks.recordWebhookResponse,
}));
vi.mock("../src/repositories/merchant", () => ({ decryptWebhookSecret: mocks.decryptWebhookSecret }));
vi.mock("../src/repositories/attempts", () => ({ getAttempt: vi.fn() }));
vi.mock("../src/services/reconciliation", () => ({
	advanceCctpAttestation: vi.fn(), mintCctpSettlement: vi.fn(), reconcileAttempt: vi.fn(),
	scanPaymentRouters: vi.fn(),
}));

import { consumePaymentQueue } from "../src/services/jobs";

const jobBody = { messageVersion: 2 as const, job: "webhook_delivery" as const,
	jobId: "job-webhook", dedupeKey: "outbox:out_evt_1", resourceId: "evt_1",
	partition: "default", attempt: 0, createdAt: "2026-08-25T12:00:00.000Z" };
const delivery = { id: "whd_1", url: "https://merchant.example/webhook",
	secret_ciphertext: "enc:v2:current:nonce.ciphertext", secret_key_id: "current",
	event_id: "evt_1", event_type: "payment.paid", payload: JSON.stringify({ id: "pi_1", status: "paid" }),
	attempt_count: 0, status: "pending", lease_expires_at: null };

function queueMessage() {
	return { id: crypto.randomUUID(), timestamp: new Date(), body: jobBody, attempts: 1,
		ack: vi.fn(), retry: vi.fn() };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.claimPaymentJob.mockResolvedValue({ state: "claimed" });
	mocks.claimWebhookDelivery.mockResolvedValue(true);
	mocks.listWebhookDeliveryJobs.mockResolvedValue([delivery]);
	mocks.decryptWebhookSecret.mockResolvedValue("whsec_test-secret");
	mocks.recordWebhookResponse.mockResolvedValue(undefined);
	mocks.completePaymentJob.mockResolvedValue(undefined);
	mocks.failPaymentJob.mockResolvedValue(undefined);
	mocks.recordWebhookNetworkFailure.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("at-least-once webhook delivery", () => {
	it("signs the raw body and sends stable event and delivery identifiers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const message = queueMessage();
		await consumePaymentQueue({ queue: "gatopago-payment-jobs", messages: [message] } as unknown as MessageBatch<unknown>, {} as never);
		expect(fetchMock).toHaveBeenCalledOnce();
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("GatoPago-Event-Id")).toBe("evt_1");
		expect(headers.get("GatoPago-Delivery-Id")).toBe("whd_1");
		expect(headers.get("GatoPago-Signature")).toMatch(/^v1=[0-9a-f]{64}$/u);
		expect(JSON.parse(String(init.body))).toEqual({ id: "evt_1", type: "payment.paid",
			data: { id: "pi_1", status: "paid" } });
		expect(message.ack).toHaveBeenCalledOnce();
	});

	it("physically redelivers the same event if persistence crashes after HTTP success", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		mocks.recordWebhookResponse.mockRejectedValueOnce(new Error("D1 unavailable"))
			.mockResolvedValueOnce(undefined);
		mocks.claimWebhookDelivery.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const first = queueMessage();
		await consumePaymentQueue({ queue: "gatopago-payment-jobs", messages: [first] } as unknown as MessageBatch<unknown>, {} as never);
		expect(first.ack).not.toHaveBeenCalled();
		expect(first.retry).toHaveBeenCalled();
		const held = queueMessage();
		await consumePaymentQueue({ queue: "gatopago-payment-jobs", messages: [held] } as unknown as MessageBatch<unknown>, {} as never);
		expect(held.ack).not.toHaveBeenCalled();
		expect(held.retry).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
		const second = queueMessage();
		await consumePaymentQueue({ queue: "gatopago-payment-jobs", messages: [second] } as unknown as MessageBatch<unknown>, {} as never);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const bodies = fetchMock.mock.calls.map((call) => String((call[1] as RequestInit).body));
		expect(new Set(bodies)).toHaveLength(1);
		expect(second.ack).toHaveBeenCalledOnce();
	});
});
