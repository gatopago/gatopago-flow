import { DurableObject } from "cloudflare:workers";
import type { PaymentJobMessage, PaymentJobName } from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";

type ScheduledJob = { job: PaymentJobName; resourceId: string; dedupeKey: string; partition: string; runAt: number; generation: number };

export class PaymentJobScheduler extends DurableObject<Bindings> {
	async schedule(input: Omit<ScheduledJob, "generation">): Promise<{ accepted: true; generation: number; runAt: number }> {
		if (!Number.isSafeInteger(input.runAt) || input.runAt < 0) throw new Error("Invalid runAt");
		const key = `job:${input.job}:${input.partition}:${input.resourceId}`;
		return this.ctx.storage.transaction(async (transaction) => {
			const previous = await transaction.get<ScheduledJob>(key);
			const next = { ...input, runAt: previous ? Math.min(previous.runAt, input.runAt) : input.runAt,
				generation: (previous?.generation ?? 0) + 1 };
			await transaction.put(key, next);
			const currentAlarm = await transaction.getAlarm();
			if (currentAlarm === null || next.runAt < currentAlarm) await transaction.setAlarm(Math.max(Date.now(), next.runAt));
			return { accepted: true, generation: next.generation, runAt: next.runAt } as const;
		});
	}

	async alarm(): Promise<void> {
		if (!this.env.PAYMENT_JOBS_QUEUE) throw new Error("Payment jobs Queue is unavailable");
		const jobs = await this.ctx.storage.list<ScheduledJob>({ prefix: "job:" });
		const now = Date.now();
		for (const [key, job] of jobs) {
			if (job.runAt > now) continue;
			const body: PaymentJobMessage = { messageVersion: 2, job: job.job, jobId: crypto.randomUUID(),
				dedupeKey: `${job.dedupeKey}:${job.generation}`, resourceId: job.resourceId, partition: job.partition,
				attempt: 0, createdAt: new Date().toISOString() };
			await this.env.PAYMENT_JOBS_QUEUE.send(body, { contentType: "json" });
			await this.ctx.storage.transaction(async (transaction) => {
				const current = await transaction.get<ScheduledJob>(key);
				if (current?.generation === job.generation) await transaction.delete(key);
			});
		}
		await this.ctx.storage.transaction(async (transaction) => {
			const remaining = await transaction.list<ScheduledJob>({ prefix: "job:" });
			const next = [...remaining.values()].reduce<number | null>(
				(earliest, job) => earliest === null ? job.runAt : Math.min(earliest, job.runAt), null,
			);
			if (next === null) await transaction.deleteAlarm();
			else await transaction.setAlarm(Math.max(Date.now(), next));
		});
	}
}
