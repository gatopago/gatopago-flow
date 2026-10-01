import type { Bindings } from "../env";

export function nowIso(): string {
	return new Date().toISOString();
}

export async function first<T>(env: Bindings, sql: string, values: unknown[] = []): Promise<T | null> {
	return env.PAYMENTS_DB.prepare(sql).bind(...values).first<T>();
}

export async function all<T>(env: Bindings, sql: string, values: unknown[] = []): Promise<T[]> {
	const result = await env.PAYMENTS_DB.prepare(sql).bind(...values).all<T>();
	return result.results;
}

export async function run(env: Bindings, sql: string, values: unknown[] = []): Promise<D1Result> {
	return env.PAYMENTS_DB.prepare(sql).bind(...values).run();
}

export function changed(result: D1Result): boolean {
	return Number(result.meta.changes ?? 0) > 0;
}
