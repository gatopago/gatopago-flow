import { hashTypedData, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  cctpPaymentAuthorizationDomain,
  cctpPaymentAuthorizationTypes,
  paymentAuthorizationDomain,
  paymentAuthorizationTypes,
} from "@gatopago/shared/payment-authorizations";
import { getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import type { SerializedPaymentAuthorization } from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";
import type { PaymentAttempt, PaymentIntent, PaymentQuote, PaymentRoute } from "../domain/models";
import { stableMetadataHash, uuidHash } from "./crypto";
import { getLiveCctpFee } from "../rails/onchain/circleClient";
import { FeePolicyError, resolvePaymentFee } from "./feePolicy";
import {
  assertPaymentRouterReadyForAuthorization,
  PaymentRouterPreflightError,
} from "./routerHealth";

export class QuoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuoteError";
  }

  get status(): 400 | 409 | 503 {
    if (this.code.startsWith("INTENT_") || this.code === "ATTEMPT_ACTIVE") {
      return 409;
    }
    return [
      "SIGNER_UNAVAILABLE",
      "FEE_UNAVAILABLE",
      "INVALID_FEE_POLICY",
      "AMBIGUOUS_FEE_POLICY",
      "INVALID_ROUTE_CAPABILITY",
      "ROUTER_FEE_CAP_EXCEEDED",
      "ROUTER_PREFLIGHT_REQUIRED",
      "ROUTER_PREFLIGHT_FAILED",
    ].includes(this.code)
      ? 503
      : 400;
  }
}

function enabledChains(env: Bindings): Set<number> {
  return new Set(
    env.PAYMENT_ENABLED_CHAIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isSafeInteger),
  );
}

function signer(env: Bindings): ReturnType<typeof privateKeyToAccount> {
  const configured = env.PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY;
  if (!configured || !/^(?:0x)?[0-9a-fA-F]{64}$/u.test(configured)) {
    throw new QuoteError("SIGNER_UNAVAILABLE", "Payment authorization signer is not configured");
  }
  return privateKeyToAccount((configured.startsWith("0x") ? configured : `0x${configured}`) as Hex);
}

function authorizationWindow(
  env: Bindings,
  intent: PaymentIntent,
  quoteExpiresAt: string,
): { validAfter: number; validUntil: number } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.PAYMENT_AUTHORIZATION_TTL_SECONDS);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new QuoteError("INVALID_TTL_CONFIG", "Payment authorization TTL is invalid");
  }
  const limits = [now + ttl, Math.floor(Date.parse(quoteExpiresAt) / 1000)];
  if (intent.expiresAt) {
    limits.push(Math.floor(Date.parse(intent.expiresAt) / 1000));
  }
  const validUntil = Math.min(...limits);
  if (validUntil <= now + 15) {
    throw new QuoteError("INTENT_EXPIRED", "Payment intent is expired");
  }
  return { validAfter: now - 15, validUntil };
}

export async function buildQuote(
  env: Bindings,
  input: {
    intent: PaymentIntent;
    payer: Address;
    sourceChainId: number;
    requestedRoute?: "fast" | "standard" | "auto";
  },
): Promise<PaymentQuote> {
  if (!enabledChains(env).has(input.sourceChainId)) {
    throw new QuoteError("CHAIN_DISABLED", "Payment source chain is disabled");
  }
  const source = getPaymentNetworkCapabilities(input.sourceChainId);
  const settlement = getPaymentNetworkCapabilities(input.intent.settlementChainId);
  if (!source?.paymentSource || !settlement?.paymentSource) {
    throw new QuoteError("CHAIN_DISABLED", "Payment source chain is unavailable");
  }
  if (source.settlementChainId !== input.intent.settlementChainId) {
    throw new QuoteError("ROUTE_UNAVAILABLE", "Source cannot settle to this merchant chain");
  }
  if (input.intent.status !== "awaiting_payment") {
    throw new QuoteError("INTENT_NOT_PAYABLE", "Payment intent is not payable");
  }
  if (input.intent.expiresAt && Date.parse(input.intent.expiresAt) <= Date.now()) {
    throw new QuoteError("INTENT_EXPIRED", "Payment intent is expired");
  }

  let route: PaymentRoute;
  if (source.isHomeChain) {
    route = "local";
  } else if (input.requestedRoute === "fast") {
    if (!source.cctpFast) {
      throw new QuoteError("ROUTE_UNAVAILABLE", "Fast transfer is unavailable on this chain");
    }
    route = "cctp_fast";
  } else if (input.requestedRoute === "standard") {
    if (!source.cctpStandard) {
      throw new QuoteError("ROUTE_UNAVAILABLE", "Standard transfer is unavailable on this chain");
    }
    route = "cctp_standard";
  } else {
    route = source.cctpFast ? "cctp_fast" : "cctp_standard";
  }
  const settlementAmount = BigInt(input.intent.amountAtomic);
  const routeFeeCapBps =
    route === "local" ? source.localPaymentMaxPlatformFeeBps : source.cctpPaymentMaxPlatformFeeBps;
  if (routeFeeCapBps === null) {
    throw new QuoteError(
      "ROUTE_UNAVAILABLE",
      "Payment route has no economic capability declaration",
    );
  }
  let resolvedFee: ReturnType<typeof resolvePaymentFee>;
  try {
    resolvedFee = resolvePaymentFee(env, {
      intent: input.intent,
      sourceChainId: input.sourceChainId,
      route,
      routeFeeCapBps,
    });
  } catch (error) {
    if (error instanceof FeePolicyError) {
      throw new QuoteError(error.code, error.message);
    }
    throw error;
  }
  const platformFeeAtomic = BigInt(resolvedFee.platformFeeAtomic);
  let cctpFeeAtomic = 0n;
  let feeObservedAt = new Date().toISOString();
  let feeSource: PaymentQuote["feeSource"] = "local";
  if (route !== "local") {
    let live: Awaited<ReturnType<typeof getLiveCctpFee>>;
    try {
      live = await getLiveCctpFee(env, {
        sourceDomain: source.cctpDomain,
        destinationDomain: settlement.cctpDomain,
        finalityThreshold: route === "cctp_fast" ? 1000 : 2000,
        settlementAmountAtomic: settlementAmount,
      });
    } catch {
      throw new QuoteError(
        "FEE_UNAVAILABLE",
        "Live CCTP fee is unavailable; no fallback fee was used",
      );
    }
    cctpFeeAtomic = live.maxFeeAtomic;
    feeObservedAt = live.observedAt;
    feeSource = "circle_live";
  }
  const gross = settlementAmount + platformFeeAtomic + cctpFeeAtomic;
  const id = `qt_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  const quoteHash = keccak256(
    toBytes(
      JSON.stringify({
        id,
        intentId: input.intent.id,
        payer: input.payer,
        sourceChainId: input.sourceChainId,
        route,
        settlementAmount: settlementAmount.toString(),
        platformFee: platformFeeAtomic.toString(),
        cctpFee: cctpFeeAtomic.toString(),
        feePolicyId: resolvedFee.policyId,
        feePolicyVersion: resolvedFee.policyVersion,
        feeRuleId: resolvedFee.ruleId,
        feeBps: resolvedFee.platformFeeBps,
        feeRecipient: resolvedFee.platformFeeRecipient,
        routeFeeCapBps,
        expiresAt,
      }),
    ),
  );
  return {
    id,
    intentId: input.intent.id,
    payer: input.payer,
    sourceChainId: input.sourceChainId,
    route,
    settlementAmountAtomic: settlementAmount.toString(),
    platformFeeAtomic: platformFeeAtomic.toString(),
    cctpFeeAtomic: cctpFeeAtomic.toString(),
    grossPayerAmountAtomic: gross.toString(),
    feePolicyId: resolvedFee.policyId,
    feePolicyVersion: resolvedFee.policyVersion,
    feeRuleId: resolvedFee.ruleId,
    platformFeeBps: resolvedFee.platformFeeBps,
    platformFeeBearer: resolvedFee.platformFeeBearer,
    platformFeeRecipient: resolvedFee.platformFeeRecipient,
    routeFeeCapBps,
    feeSource,
    feeObservedAt,
    expiresAt,
    quoteHash,
    createdAt,
  };
}

export async function authorizeAttempt(
  env: Bindings,
  input: {
    intent: PaymentIntent;
    quote: PaymentQuote;
    payerUserId?: string | null;
  },
): Promise<PaymentAttempt> {
  if (Date.parse(input.quote.expiresAt) <= Date.now()) {
    throw new QuoteError("QUOTE_STALE", "Quote is stale");
  }
  const source = getPaymentNetworkCapabilities(input.quote.sourceChainId);
  if (!source?.paymentSource) {
    throw new QuoteError("CHAIN_DISABLED", "Payment source chain is disabled");
  }
  const id = `pa_${crypto.randomUUID()}`;
  const attemptHash = uuidHash(id);
  const intentHash = uuidHash(input.intent.id);
  const metadataHash = stableMetadataHash(input.intent.metadata);
  const window = authorizationWindow(env, input.intent, input.quote.expiresAt);
  const account = signer(env);
  try {
    await assertPaymentRouterReadyForAuthorization(env, {
      chainId: source.chainId,
      route: input.quote.route,
      platformFeeBps: input.quote.platformFeeBps,
      platformFeeRecipient: input.quote.platformFeeRecipient,
    });
  } catch (error) {
    if (error instanceof PaymentRouterPreflightError) {
      throw new QuoteError("ROUTER_PREFLIGHT_FAILED", error.message);
    }
    throw error;
  }
  let routerAddress: Address;
  let authorization: Record<string, unknown>;
  let signature: Hex;
  let authorizationHash: Hex;

  if (input.quote.route === "local") {
    if (!source.localPaymentRouter) {
      throw new QuoteError("ROUTE_UNAVAILABLE", "Local payment router is unavailable");
    }
    routerAddress = source.localPaymentRouter;
    const value: SerializedPaymentAuthorization = {
      intentId: intentHash,
      attemptId: attemptHash,
      payer: input.quote.payer,
      merchant: input.intent.settlementWallet,
      settlementAmount: input.quote.settlementAmountAtomic,
      platformFee: input.quote.platformFeeAtomic,
      validAfter: window.validAfter,
      validUntil: window.validUntil,
      metadataHash,
    };
    authorization = value;
    const typed = {
      domain: {
        ...paymentAuthorizationDomain,
        chainId: source.chainId,
        verifyingContract: routerAddress,
      },
      types: paymentAuthorizationTypes,
      primaryType: "PaymentAuthorization" as const,
      message: {
        ...value,
        settlementAmount: BigInt(value.settlementAmount),
        platformFee: BigInt(value.platformFee),
        validAfter: value.validAfter,
        validUntil: value.validUntil,
      },
    };
    authorizationHash = hashTypedData(typed);
    signature = await account.signTypedData(typed);
  } else {
    if (!source.cctpPaymentRouter) {
      throw new QuoteError("ROUTE_UNAVAILABLE", "CCTP payment router is unavailable");
    }
    const settlement = getPaymentNetworkCapabilities(input.intent.settlementChainId);
    if (!settlement?.paymentSource) {
      throw new QuoteError("CHAIN_DISABLED", "Settlement chain is unavailable");
    }
    routerAddress = source.cctpPaymentRouter;
    const value = {
      intentId: intentHash,
      attemptId: attemptHash,
      payer: input.quote.payer,
      merchant: input.intent.settlementWallet,
      settlementChainId: BigInt(input.intent.settlementChainId),
      destinationDomain: settlement.cctpDomain,
      settlementAmount: BigInt(input.quote.settlementAmountAtomic),
      grossPayerAmount: BigInt(input.quote.grossPayerAmountAtomic),
      platformFee: BigInt(input.quote.platformFeeAtomic),
      maxCctpFee: BigInt(input.quote.cctpFeeAtomic),
      minFinalityThreshold: input.quote.route === "cctp_fast" ? 1000 : 2000,
      validAfter: window.validAfter,
      validUntil: window.validUntil,
      metadataHash,
    };
    authorization = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "bigint" ? item.toString() : item,
      ]),
    );
    const typed = {
      domain: {
        ...cctpPaymentAuthorizationDomain,
        chainId: source.chainId,
        verifyingContract: routerAddress,
      },
      types: cctpPaymentAuthorizationTypes,
      primaryType: "CctpPaymentAuthorization" as const,
      message: value,
    };
    authorizationHash = hashTypedData(typed);
    signature = await account.signTypedData(typed);
  }
  const timestamp = new Date().toISOString();
  return {
    id,
    attemptHash,
    intentId: input.intent.id,
    quoteId: input.quote.id,
    payerUserId: input.payerUserId ?? null,
    payerAddress: input.quote.payer,
    sourceChainId: source.chainId,
    route: input.quote.route,
    status: "reserved",
    routerAddress,
    authorizationHash,
    authorization,
    signature,
    checkoutCapabilityHash: null,
    payerProofSignature: null,
    payerProofMessageHash: null,
    validAfter: window.validAfter,
    validUntil: window.validUntil,
    userOpHash: null,
    sourceTxHash: null,
    destinationTxHash: null,
    settlementAmountAtomic: input.quote.settlementAmountAtomic,
    platformFeeAtomic: input.quote.platformFeeAtomic,
    cctpFeeAtomic: input.quote.cctpFeeAtomic,
    grossPayerAmountAtomic: input.quote.grossPayerAmountAtomic,
    feePolicyId: input.quote.feePolicyId,
    feePolicyVersion: input.quote.feePolicyVersion,
    feeRuleId: input.quote.feeRuleId,
    platformFeeBps: input.quote.platformFeeBps,
    platformFeeBearer: input.quote.platformFeeBearer,
    platformFeeRecipient: input.quote.platformFeeRecipient,
    routeFeeCapBps: input.quote.routeFeeCapBps,
    settledAmountAtomic: "0",
    expiresAt: new Date(window.validUntil * 1000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
