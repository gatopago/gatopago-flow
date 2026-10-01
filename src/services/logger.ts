type Fields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", event: string, fields: Fields): void {
	const payload = JSON.stringify({
		level,
		event,
		timestamp: new Date().toISOString(),
		...fields,
	});
	if (level === "error") console.error(payload);
	else if (level === "warn") console.warn(payload);
	else console.info(payload);
}

export function logInfo(event: string, fields: Fields = {}): void {
	write("info", event, fields);
}

export function logWarn(event: string, fields: Fields = {}): void {
	write("warn", event, fields);
}

export function logError(event: string, error: unknown, fields: Fields = {}): void {
	write("error", event, {
		...fields,
		error: error instanceof Error ? error.message : String(error),
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
}

export function requestId(request: Request): string {
	return request.headers.get("CF-Ray") ?? request.headers.get("X-Request-Id") ?? crypto.randomUUID();
}
