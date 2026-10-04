import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ERR } from "@gatopago/shared/payment-errors";
import { authMiddleware, type PaymentsContext } from "./middlewares/auth";
import linksRoutes from "./routes/links.routes";
import checkoutRoutes from "./routes/checkout.routes";
import v1Routes from "./routes/v1.routes";
import merchantRoutes from "./routes/merchant.routes";
import { DomainValidationError } from "./domain/validation";
import { QuoteError } from "./services/quoteEngine";
import { logError, logInfo, requestId } from "./services/logger";
import { validatePaymentFeePolicyConfig } from "./services/feePolicy";
import {
  collectPaymentRouterHealth,
  validatePaymentRouterPreflightConfig,
} from "./services/routerHealth";
import { paymentModeCapabilities } from "./services/capabilities";
import { validateWebhookEncryptionConfig } from "./repositories/merchant";
import { paymentDatabaseAvailable, paymentOpsCounts } from "./stores/opsStore";

const app = new Hono<PaymentsContext>();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function equalDigest(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }
  return mismatch === 0;
}

async function validOpsHealthToken(
  provided: string | undefined,
  expected: string | undefined,
): Promise<boolean> {
  if (!provided || !expected || expected.length < 32) {
    return false;
  }
  const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
  return equalDigest(providedHash, expectedHash);
}

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: "cross-origin",
    permissionsPolicy: {
      camera: false,
      geolocation: false,
      microphone: false,
      payment: false,
      usb: false,
    },
    referrerPolicy: "no-referrer",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions: "DENY",
  }),
);

app.use("*", async (c, next) => {
  const startedAt = Date.now();
  const id = requestId(c.req.raw);
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
  logInfo("payments_http_completed", {
    requestId: id,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed =
        c.env.ALLOWED_ORIGINS?.split(",")
          .map((value: string) => value.trim())
          .filter(Boolean) ?? [];
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
      "X-GatoPago-Checkout-Capability",
    ],
    exposeHeaders: ["X-Request-Id"],
  }),
);

app.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: "Request body too large",
          error_code: ERR.PAYLOAD_TOO_LARGE,
          requestId: c.get("requestId"),
        },
        413,
      ),
  }),
);

app.use("*", authMiddleware);

app.get("/v1/health/live", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ status: "ok", service: "gatopago-flow" });
});

app.get("/v1/health", async (c) => {
  const databaseAvailable = await paymentDatabaseAvailable(c.env);
  const database = databaseAvailable ? "ok" : "error";
  const signer = /^(?:0x)?[0-9a-fA-F]{64}$/u.test(
    c.env.PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY ?? "",
  );
  const queue = !!c.env.PAYMENT_JOBS_QUEUE;
  const scheduler = !!c.env.PAYMENT_JOB_SCHEDULER;
  const feePolicyIssues = validatePaymentFeePolicyConfig(c.env);
  const preflightConfigIssues = validatePaymentRouterPreflightConfig(c.env);
  const webhookEncryptionIssues = validateWebhookEncryptionConfig(c.env);
  const router = await collectPaymentRouterHealth(c.env);
  const capabilities = paymentModeCapabilities(c.env);
  const ready =
    database === "ok" &&
    signer &&
    queue &&
    scheduler &&
    feePolicyIssues.length === 0 &&
    preflightConfigIssues.length === 0 &&
    webhookEncryptionIssues.length === 0 &&
    router.status !== "error";
  const degraded = ready && router.status === "degraded";
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      status: ready && !degraded ? "ready" : "degraded",
      service: "gatopago-flow",
      checks: {
        database,
        authorizationSigner: signer ? "configured" : "missing",
        queue: queue ? "configured" : "missing",
        scheduler: scheduler ? "configured" : "missing",
        feePolicy: feePolicyIssues.length === 0 ? "valid" : "invalid",
        webhookEncryption: webhookEncryptionIssues.length === 0 ? "valid" : "invalid",
        routerPreflight: router.status,
        routerConfig: preflightConfigIssues.length === 0 ? "valid" : "invalid",
      },
      capabilities,
    },
    ready ? 200 : 503,
  );
});

app.get("/v1/health/ops", async (c) => {
  if (!(await validOpsHealthToken(c.req.header("X-Ops-Token"), c.env.OPS_HEALTH_TOKEN))) {
    return c.json({ error: "Not found" }, 404);
  }
  const counts = await paymentOpsCounts(c.env);
  const router = await collectPaymentRouterHealth(c.env);
  const feePolicyIssues = validatePaymentFeePolicyConfig(c.env);
  const routerConfigIssues = validatePaymentRouterPreflightConfig(c.env);
  const webhookEncryptionIssues = validateWebhookEncryptionConfig(c.env);
  const capabilities = paymentModeCapabilities(c.env);
  const unavailable =
    router.status === "error" ||
    feePolicyIssues.length > 0 ||
    routerConfigIssues.length > 0 ||
    webhookEncryptionIssues.length > 0;
  const degraded = unavailable || router.status === "degraded";
  return c.json(
    {
      status: degraded ? "degraded" : "ok",
      service: "gatopago-flow",
      counts,
      router,
      configuration: { feePolicyIssues, routerConfigIssues, webhookEncryptionIssues, capabilities },
    },
    unavailable ? 503 : 200,
  );
});

app.route("/checkout/v1", checkoutRoutes);

app.route("/v1/payment_links", linksRoutes);
app.route("/v1/merchant", merchantRoutes);
app.route("/v1", v1Routes);

app.onError((error, c) => {
  if (error instanceof DomainValidationError) {
    return c.json(
      { error: error.message, error_code: error.code, requestId: c.get("requestId") },
      400,
    );
  }
  if (error instanceof QuoteError) {
    return c.json(
      { error: error.message, error_code: error.code, requestId: c.get("requestId") },
      error.status,
    );
  }
  logError("payments_unhandled_error", error, {
    requestId: c.get("requestId"),
    path: new URL(c.req.url).pathname,
  });
  return c.json(
    { error: "Internal server error", error_code: ERR.SERVER_ERROR, requestId: c.get("requestId") },
    500,
  );
});

export default app;
