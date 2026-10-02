import { getAddress, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getPaymentNetworkCapabilities,
  type PaymentNetworkCapabilities,
} from "@gatopago/shared/payment-networks";
import type { Bindings } from "../env";
import type { PaymentRoute } from "../domain/models";
import { maximumConfiguredFeeBps } from "./feePolicy";
import { paymentPublicClient, validatePaymentRpcRedundancy } from "./clients";

const commonRouterAbi = parseAbi([
  "function MAX_PLATFORM_FEE_BPS() view returns (uint256)",
  "function USDC() view returns (address)",
  "function treasury() view returns (address)",
  "function authorizationSigner() view returns (address)",
  "function paused() view returns (bool)",
]);

const cctpRouterAbi = parseAbi([
  "function TOKEN_MESSENGER() view returns (address)",
  "function SETTLEMENT_CHAIN_ID() view returns (uint256)",
  "function FAST_TRANSFER_ENABLED() view returns (bool)",
]);

type PaymentRouterKind = "local" | "cctp";

export type PaymentRouterTarget = {
  chainId: number;
  kind: PaymentRouterKind;
  address: Address;
  declaredMaxPlatformFeeBps: number;
  usdc: Address;
  tokenMessenger: Address | null;
  settlementChainId: number;
  standardTransferEnabled: boolean | null;
  fastTransferEnabled: boolean | null;
};

export type PaymentRouterObservation = {
  codePresent: boolean;
  maxPlatformFeeBps: bigint | null;
  usdc: Address | null;
  treasury: Address | null;
  authorizationSigner: Address | null;
  paused: boolean | null;
  tokenMessenger: Address | null;
  settlementChainId: bigint | null;
  fastTransferEnabled: boolean | null;
};

type PaymentRouterHealthRoute = {
  chainId: number;
  kind: PaymentRouterKind;
  address: Address;
  status: "ok" | "degraded" | "error";
  issues: string[];
  observedMaxPlatformFeeBps: string | null;
  configuredMaxFeeBps: number;
};

type PaymentRouterHealth = {
  status: "disabled" | "ok" | "degraded" | "error";
  routes: PaymentRouterHealthRoute[];
  issues: string[];
};

export class PaymentRouterPreflightError extends Error {
  constructor(readonly issues: string[]) {
    super(`Payment router preflight failed: ${issues.join(", ")}`);
    this.name = "PaymentRouterPreflightError";
  }
}

type RouterReader = (
  env: Bindings,
  target: PaymentRouterTarget,
) => Promise<PaymentRouterObservation>;

function issuePrefix(target: PaymentRouterTarget): string {
  return `payment_router_${target.chainId}_${target.kind}`;
}

function sameAddress(left: Address | null, right: Address): boolean {
  if (!left) {
    return false;
  }
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function authorizationSigner(env: Bindings): Address | null {
  const key = env.PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY;
  if (!key || !/^(?:0x)?[0-9a-fA-F]{64}$/u.test(key)) {
    return null;
  }
  try {
    return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
  } catch {
    return null;
  }
}

function targetFor(network: PaymentNetworkCapabilities): PaymentRouterTarget | null {
  if (network.isHomeChain) {
    if (!network.localPaymentRouter || network.localPaymentMaxPlatformFeeBps === null) {
      return null;
    }
    return {
      chainId: network.chainId,
      kind: "local",
      address: getAddress(network.localPaymentRouter),
      declaredMaxPlatformFeeBps: network.localPaymentMaxPlatformFeeBps,
      usdc: getAddress(network.usdc),
      tokenMessenger: null,
      settlementChainId: network.settlementChainId,
      standardTransferEnabled: null,
      fastTransferEnabled: null,
    };
  }
  if (!network.cctpPaymentRouter || network.cctpPaymentMaxPlatformFeeBps === null) {
    return null;
  }
  return {
    chainId: network.chainId,
    kind: "cctp",
    address: getAddress(network.cctpPaymentRouter),
    declaredMaxPlatformFeeBps: network.cctpPaymentMaxPlatformFeeBps,
    usdc: getAddress(network.usdc),
    tokenMessenger: getAddress(network.tokenMessenger),
    settlementChainId: network.settlementChainId,
    standardTransferEnabled: network.cctpStandard,
    fastTransferEnabled: network.cctpFast,
  };
}

function enabledTargets(env: Bindings): { targets: PaymentRouterTarget[]; issues: string[] } {
  const raw =
    env.PAYMENT_ENABLED_CHAIN_IDS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const ids = raw.map(Number);
  const issues: string[] = [];
  if (
    raw.length === 0 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    issues.push("payment_enabled_chains_invalid");
    return { targets: [], issues };
  }
  const targets: PaymentRouterTarget[] = [];
  for (const chainId of ids) {
    const network = getPaymentNetworkCapabilities(chainId);
    if (!network?.paymentSource) {
      issues.push(`payment_router_${chainId}_disabled`);
      continue;
    }
    const target = targetFor(network);
    if (!target) {
      issues.push(`payment_router_${chainId}_capability_missing`);
    } else {
      targets.push(target);
    }
  }
  return { targets, issues };
}

function routesFor(target: PaymentRouterTarget): PaymentRoute[] {
  if (target.kind === "local") {
    return ["local"];
  }
  const routes: PaymentRoute[] = [];
  if (target.fastTransferEnabled) {
    routes.push("cctp_fast");
  }
  if (target.standardTransferEnabled) {
    routes.push("cctp_standard");
  }
  return routes;
}

function configuredMaximumFeeBps(
  env: Bindings,
  target: PaymentRouterTarget,
): {
  value: number;
  issue: string | null;
} {
  try {
    return {
      value: maximumConfiguredFeeBps(env, {
        sourceChainId: target.chainId,
        routes: routesFor(target),
      }),
      issue: null,
    };
  } catch {
    return { value: 0, issue: "payment_fee_policy_invalid" };
  }
}

function evaluatePaymentRouterObservation(input: {
  target: PaymentRouterTarget;
  observation: PaymentRouterObservation;
  expectedAuthorizationSigner: Address | null;
  expectedTreasury: Address | null;
  configuredMaxFeeBps: number;
}): string[] {
  const { target, observation } = input;
  const prefix = issuePrefix(target);
  const issues: string[] = [];
  if (!observation.codePresent) {
    issues.push(`${prefix}_code_missing`);
  }
  if (observation.maxPlatformFeeBps !== BigInt(target.declaredMaxPlatformFeeBps)) {
    issues.push(`${prefix}_fee_cap_mismatch`);
  }
  if (input.configuredMaxFeeBps > target.declaredMaxPlatformFeeBps) {
    issues.push(`${prefix}_configured_fee_exceeds_cap`);
  }
  if (
    !input.expectedAuthorizationSigner ||
    !sameAddress(observation.authorizationSigner, input.expectedAuthorizationSigner)
  ) {
    issues.push(`${prefix}_authorization_signer_mismatch`);
  }
  if (
    input.configuredMaxFeeBps > 0 &&
    (!input.expectedTreasury || !sameAddress(observation.treasury, input.expectedTreasury))
  ) {
    issues.push(`${prefix}_treasury_mismatch`);
  }
  if (!sameAddress(observation.usdc, target.usdc)) {
    issues.push(`${prefix}_usdc_mismatch`);
  }
  if (observation.paused !== false) {
    issues.push(`${prefix}_paused`);
  }
  if (target.kind === "cctp") {
    if (!target.tokenMessenger || !sameAddress(observation.tokenMessenger, target.tokenMessenger)) {
      issues.push(`${prefix}_token_messenger_mismatch`);
    }
    if (observation.settlementChainId !== BigInt(target.settlementChainId)) {
      issues.push(`${prefix}_settlement_chain_mismatch`);
    }
    if (observation.fastTransferEnabled !== target.fastTransferEnabled) {
      issues.push(`${prefix}_fast_transfer_mismatch`);
    }
  }
  return issues;
}

async function readPaymentRouter(
  env: Bindings,
  target: PaymentRouterTarget,
): Promise<PaymentRouterObservation> {
  const client = paymentPublicClient(env, target.chainId);
  const code = await client.getCode({ address: target.address });
  if (!code || code === "0x") {
    return {
      codePresent: false,
      maxPlatformFeeBps: null,
      usdc: null,
      treasury: null,
      authorizationSigner: null,
      paused: null,
      tokenMessenger: null,
      settlementChainId: null,
      fastTransferEnabled: null,
    };
  }
  const common = [
    { address: target.address, abi: commonRouterAbi, functionName: "MAX_PLATFORM_FEE_BPS" },
    { address: target.address, abi: commonRouterAbi, functionName: "USDC" },
    { address: target.address, abi: commonRouterAbi, functionName: "treasury" },
    { address: target.address, abi: commonRouterAbi, functionName: "authorizationSigner" },
    { address: target.address, abi: commonRouterAbi, functionName: "paused" },
  ] as const;
  const observed =
    target.kind === "cctp"
      ? await client.multicall({
          contracts: [
            ...common,
            { address: target.address, abi: cctpRouterAbi, functionName: "TOKEN_MESSENGER" },
            { address: target.address, abi: cctpRouterAbi, functionName: "SETTLEMENT_CHAIN_ID" },
            { address: target.address, abi: cctpRouterAbi, functionName: "FAST_TRANSFER_ENABLED" },
          ] as const,
          allowFailure: false,
        })
      : await client.multicall({ contracts: common, allowFailure: false });
  const [maxPlatformFeeBps, usdc, treasury, signer, paused] = observed;
  const tokenMessenger = observed.length === 8 ? observed[5] : null;
  const settlementChainId = observed.length === 8 ? observed[6] : null;
  const fastTransferEnabled = observed.length === 8 ? observed[7] : null;
  return {
    codePresent: true,
    maxPlatformFeeBps,
    usdc,
    treasury,
    authorizationSigner: signer,
    paused,
    tokenMessenger,
    settlementChainId,
    fastTransferEnabled,
  };
}

// Public on-chain configuration only. Bounded by the static payment-network
// manifest; never stores user data, secrets, Promises or request-scoped I/O.
// Concurrent misses may perform duplicate reads, which is safer in Workers
// than sharing an unresolved operation across request contexts.
const observationCache = new Map<string, { expiresAt: number; value: PaymentRouterObservation }>();
const lastKnownObservations = new Map<
  string,
  { observedAt: number; value: PaymentRouterObservation }
>();
const OBSERVATION_TTL_MS = 15_000;
const STALE_HEALTH_OBSERVATION_TTL_MS = 5 * 60_000;

function observationKey(target: PaymentRouterTarget): string {
  return `${target.chainId}:${target.address.toLowerCase()}`;
}

async function cachedObservation(
  env: Bindings,
  target: PaymentRouterTarget,
  reader: RouterReader,
): Promise<PaymentRouterObservation> {
  const key = observationKey(target);
  if (reader !== readPaymentRouter) {
    const observation = await reader(env, target);
    lastKnownObservations.set(key, { observedAt: Date.now(), value: observation });
    return observation;
  }
  const cached = observationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const observation = await reader(env, target);
  const observedAt = Date.now();
  lastKnownObservations.set(key, { observedAt, value: observation });
  observationCache.set(key, { expiresAt: observedAt + OBSERVATION_TTL_MS, value: observation });
  return observation;
}

function recentObservation(target: PaymentRouterTarget): PaymentRouterObservation | null {
  const lastKnown = lastKnownObservations.get(observationKey(target));
  if (!lastKnown || Date.now() - lastKnown.observedAt > STALE_HEALTH_OBSERVATION_TTL_MS) {
    return null;
  }
  return lastKnown.value;
}

function expectedTreasury(env: Bindings, configuredMaxFeeBps: number): Address | null {
  if (configuredMaxFeeBps === 0 || !env.PAYMENT_PLATFORM_FEE_RECIPIENT) {
    return null;
  }
  try {
    return getAddress(env.PAYMENT_PLATFORM_FEE_RECIPIENT);
  } catch {
    return null;
  }
}

export async function collectPaymentRouterHealth(
  env: Bindings,
  reader: RouterReader = readPaymentRouter,
): Promise<PaymentRouterHealth> {
  if (env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== "true") {
    return { status: "disabled", routes: [], issues: [] };
  }
  const enabled = enabledTargets(env);
  const expectedSigner = authorizationSigner(env);
  const routes = await Promise.all(
    enabled.targets.map(async (target): Promise<PaymentRouterHealthRoute> => {
      const configured = configuredMaximumFeeBps(env, target);
      const configuredMaxFeeBps = configured.value;
      let issues: string[];
      let stale = false;
      let observation: PaymentRouterObservation | null;
      try {
        observation = await cachedObservation(env, target, reader);
        issues = evaluatePaymentRouterObservation({
          target,
          observation,
          expectedAuthorizationSigner: expectedSigner,
          expectedTreasury: expectedTreasury(env, configuredMaxFeeBps),
          configuredMaxFeeBps,
        });
      } catch {
        observation = recentObservation(target);
        if (observation) {
          stale = true;
          issues = evaluatePaymentRouterObservation({
            target,
            observation,
            expectedAuthorizationSigner: expectedSigner,
            expectedTreasury: expectedTreasury(env, configuredMaxFeeBps),
            configuredMaxFeeBps,
          });
          issues.push(`${issuePrefix(target)}_rpc_stale`);
        } else {
          issues = [`${issuePrefix(target)}_rpc_unavailable`];
        }
      }
      if (configured.issue) {
        issues.push(configured.issue);
      }
      const hardIssues = issues.filter((issue) => !issue.endsWith("_rpc_stale"));
      return {
        chainId: target.chainId,
        kind: target.kind,
        address: target.address,
        status: hardIssues.length > 0 ? "error" : stale ? "degraded" : "ok",
        issues,
        observedMaxPlatformFeeBps: observation?.maxPlatformFeeBps?.toString() ?? null,
        configuredMaxFeeBps,
      };
    }),
  );
  const issues = [...new Set([...enabled.issues, ...routes.flatMap((route) => route.issues)])];
  const status =
    enabled.issues.length > 0 || routes.some((route) => route.status === "error")
      ? "error"
      : routes.some((route) => route.status === "degraded")
        ? "degraded"
        : "ok";
  return { status, routes, issues };
}

export async function assertPaymentRouterReadyForAuthorization(
  env: Bindings,
  input: {
    chainId: number;
    route: PaymentRoute;
    platformFeeBps: number;
    platformFeeRecipient: Address | null;
  },
  reader: RouterReader = readPaymentRouter,
): Promise<void> {
  if (env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== "true") {
    if (input.platformFeeBps > 0) {
      throw new PaymentRouterPreflightError(["payment_router_preflight_required"]);
    }
    return;
  }
  const network = getPaymentNetworkCapabilities(input.chainId);
  const target = network ? targetFor(network) : null;
  if (!target || (input.route === "local") !== (target.kind === "local")) {
    throw new PaymentRouterPreflightError([`payment_router_${input.chainId}_capability_missing`]);
  }
  let observation: PaymentRouterObservation;
  try {
    observation = await cachedObservation(env, target, reader);
  } catch {
    throw new PaymentRouterPreflightError([`${issuePrefix(target)}_rpc_unavailable`]);
  }
  const issues = evaluatePaymentRouterObservation({
    target,
    observation,
    expectedAuthorizationSigner: authorizationSigner(env),
    expectedTreasury: input.platformFeeRecipient,
    configuredMaxFeeBps: input.platformFeeBps,
  });
  if (issues.length > 0) {
    throw new PaymentRouterPreflightError(issues);
  }
}

export function validatePaymentRouterPreflightConfig(env: Bindings): string[] {
  const issues: string[] = [];
  if (
    env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== undefined &&
    !["true", "false"].includes(env.PAYMENT_ROUTER_PREFLIGHT_ENABLED)
  ) {
    issues.push("PAYMENT_ROUTER_PREFLIGHT_INVALID");
  }
  const enabled = enabledTargets(env);
  issues.push(...enabled.issues.map((value) => value.toUpperCase()));
  const hasMainnet = enabled.targets.some(
    (target) => !getPaymentNetworkCapabilities(target.chainId)?.isTestnet,
  );
  const configured = enabled.targets.map((target) => configuredMaximumFeeBps(env, target));
  if (configured.some((result) => result.issue)) {
    issues.push("PAYMENT_FEE_POLICY_INVALID");
  }
  const hasConfiguredFees = configured.some((result) => result.value > 0);
  if ((hasMainnet || hasConfiguredFees) && env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== "true") {
    issues.push("PAYMENT_ROUTER_PREFLIGHT_REQUIRED");
  }
  if (env.PAYMENT_ROUTER_PREFLIGHT_ENABLED === "true") {
    issues.push(
      ...validatePaymentRpcRedundancy(
        env,
        enabled.targets.map((target) => target.chainId),
      ),
    );
  }
  return [...new Set(issues)];
}
