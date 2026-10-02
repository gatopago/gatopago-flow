import type { Context } from "hono";
import { ERR } from "@gatopago/shared/payment-errors";
import type { PaymentsContext } from "./auth";
import { sha256Hex } from "../services/crypto";
import { incrementRateLimit } from "../stores/rateLimitStore";

export function requestIdentity(c: Context<PaymentsContext>): string {
  return c.req.header("CF-Connecting-IP") ?? c.req.header("X-Real-IP") ?? "unknown";
}

export async function enforceRateLimit(
  c: Context<PaymentsContext>,
  input: {
    scope: string;
    key: string;
    limit: number;
    windowSeconds?: number;
  },
): Promise<Response | null> {
  const windowSeconds = input.windowSeconds ?? 60;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const keyHash = await sha256Hex(input.key);
  const count = await incrementRateLimit(c.env, { scope: input.scope, keyHash, windowStart });
  if ((count ?? input.limit + 1) <= input.limit) {
    return null;
  }
  const retryAfter = Math.max(1, windowStart + windowSeconds - nowSeconds);
  return c.json(
    {
      error: "Too many requests",
      error_code: ERR.RATE_LIMITED,
      requestId: c.get("requestId"),
      retry_after: retryAfter,
    },
    429,
    { "Retry-After": String(retryAfter) },
  );
}
