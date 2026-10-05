/** An expected failure, returned to the client as `{ error_code }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function readJson<T>(request: Request, limit = 16_384): Promise<T> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED");
  }
  const text = await request.text();
  if (text.length > limit) {
    throw new HttpError(413, "BODY_TOO_LARGE");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

/** Per-client request budget (Cloudflare Rate Limiting binding). */
export async function rateLimit(env: Env, key: string): Promise<void> {
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) {
    throw new HttpError(429, "RATE_LIMITED");
  }
}

export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

/** Resource ids in the API's style: `pi_…`, `key_…`. */
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export const now = () => Math.floor(Date.now() / 1000);
