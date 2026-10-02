import type { Context, Next } from "hono";
import { parseResourceId } from "@gatopago/shared/v3/primitives";
import { ERR } from "@gatopago/shared/payment-errors";
import type { Bindings } from "../env";
import { discardResponseBody, readJsonBounded } from "@gatopago/shared/http";

type User = { user_id: string };
type Variables = {
  user: User | null;
  requestId: string;
  merchantId?: string;
  apiMode?: "test" | "live";
};
export type PaymentsContext = { Bindings: Bindings; Variables: Variables };

function rejected(c: Context<PaymentsContext>, status: 401 | 503): Response {
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      error_code: status === 401 ? ERR.UNAUTHENTICATED : "IDENTITY_UNAVAILABLE",
      requestId: c.get("requestId"),
    },
    status,
  );
}

/** Wallet Core owns admission and credential revocation. Never cache an accepted session. */
export async function authMiddleware(
  c: Context<PaymentsContext>,
  next: Next,
): Promise<Response | void> {
  c.set("user", null);
  const authorization = c.req.header("Authorization");
  if (authorization === undefined || /^Bearer sk_(test|live)_/.test(authorization)) {
    await next();
    return;
  }
  if (
    authorization.length > 8192 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(authorization) ||
    c.req.header("Cookie") !== undefined
  ) {
    return rejected(c, 401);
  }
  c.header("Cache-Control", "no-store");
  try {
    if (!c.env.WALLET_IDENTITY || c.env.GATOPAGO_ENVIRONMENT !== "production") {
      return rejected(c, 503);
    }
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]);
    const response = await c.env.WALLET_IDENTITY.fetch("https://wallet-identity.internal/session", {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        Authorization: authorization,
        "X-GatoPago-Environment": c.env.GATOPAGO_ENVIRONMENT,
      },
    });
    if (response.status !== 200) {
      await discardResponseBody(response);
      return rejected(c, response.status === 401 ? 401 : 503);
    }
    const result = await readJsonBounded<unknown>(response, 1024, signal);
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== "environment,expires_at,user_id" ||
      !("environment" in result) ||
      result.environment !== c.env.GATOPAGO_ENVIRONMENT ||
      !("expires_at" in result) ||
      typeof result.expires_at !== "number" ||
      !Number.isSafeInteger(result.expires_at) ||
      result.expires_at <= Math.floor(Date.now() / 1000) ||
      result.expires_at > Math.floor(Date.now() / 1000) + 3600 ||
      !("user_id" in result)
    ) {
      return rejected(c, 503);
    }
    c.set("user", { user_id: parseResourceId("user", result.user_id) });
  } catch {
    return rejected(c, 503);
  }
  await next();
}

export async function requireAuth(
  c: Context<PaymentsContext>,
  next: Next,
): Promise<Response | void> {
  if (!c.get("user")) {
    return rejected(c, 401);
  }
  await next();
}
