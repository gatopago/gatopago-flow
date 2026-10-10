import { HttpError, readJson as readBody, withCors as cors } from '@gatopago/shared/http';

export { HttpError, json } from '@gatopago/shared/http';

/** A JSON object body of at most 16 KB. */
export const readJson = <T>(request: Request, limit = 16_384) => readBody<T>(request, limit);

/** Per-client request budget (Cloudflare Rate Limiting binding). */
export async function rateLimit(env: Env, key: string): Promise<void> {
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) {
    throw new HttpError(429, 'RATE_LIMITED');
  }
}

export const withCors = (response: Response, origin: string) =>
  cors(response, origin, {
    methods: 'GET, POST, DELETE, OPTIONS',
    headers: 'Authorization, Content-Type, Idempotency-Key',
  });

/** Resource ids in the API's style: `pi_…`, `key_…`. */
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

export const now = () => Math.floor(Date.now() / 1000);
