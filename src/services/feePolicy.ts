import { getAddress, isAddress, type Address } from "viem";
import type { PaymentFeeSnapshot } from "@gatopago/shared/fees";
import type { Bindings } from "../env";
import type { PaymentIntent, PaymentRoute } from "../domain/models";

const MAX_POLICY_BYTES = 32 * 1024;
const MAX_RULES = 100;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]{0,77})$/u;
const POLICY_KEYS = new Set(["policyId", "version", "rules"]);
const RULE_KEYS = new Set(["id", "priority", "feeBps", "merchantIds", "modes",
	"sourceChainIds", "routes", "minAmountAtomic", "maxAmountAtomic"]);

type FeeRule = {
	id: string;
	priority: number;
	feeBps: number;
	merchantIds?: string[];
	modes?: Array<"test" | "live">;
	sourceChainIds?: number[];
	routes?: PaymentRoute[];
	minAmountAtomic?: string;
	maxAmountAtomic?: string;
};

type PaymentFeePolicyDocument = {
	policyId: string;
	version: number;
	rules: FeeRule[];
};

export type ResolvedPaymentFee = PaymentFeeSnapshot & {
	platformFeeAtomic: string;
};

export class FeePolicyError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "FeePolicyError";
	}
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.has(key));
	if (unknown) throw new FeePolicyError("INVALID_FEE_POLICY", `${label} contains unknown field ${unknown}`);
}

const FREE_POLICY: PaymentFeePolicyDocument = {
	policyId: "free-default",
	version: 1,
	rules: [],
};

function stringArray(value: unknown, label: string, max = 100): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > max ||
		value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 160)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `${label} is invalid`);
	}
	return [...new Set(value)];
}

function chainArray(value: unknown): number[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > 20 ||
		value.some((item) => !Number.isSafeInteger(item) || Number(item) <= 0)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "sourceChainIds is invalid");
	}
	return [...new Set(value as number[])];
}

function atomic(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !ATOMIC_AMOUNT.test(value)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `${label} is invalid`);
	}
	return value;
}

function parseRule(value: unknown): FeeRule {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Fee policy rule is invalid");
	}
	const raw = value as Record<string, unknown>;
	rejectUnknownKeys(raw, RULE_KEYS, "Fee policy rule");
	if (typeof raw.id !== "string" || !POLICY_ID.test(raw.id)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Fee rule id is invalid");
	}
	if (!Number.isSafeInteger(raw.priority) || Number(raw.priority) < -10_000 || Number(raw.priority) > 10_000) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `Fee rule ${raw.id} priority is invalid`);
	}
	if (!Number.isSafeInteger(raw.feeBps) || Number(raw.feeBps) < 0 || Number(raw.feeBps) > 100) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `Fee rule ${raw.id} feeBps is invalid`);
	}
	const merchantIds = stringArray(raw.merchantIds, "merchantIds");
	const modes = stringArray(raw.modes, "modes", 2);
	if (modes?.some((mode) => mode !== "test" && mode !== "live")) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `Fee rule ${raw.id} modes are invalid`);
	}
	const routes = stringArray(raw.routes, "routes", 3);
	if (routes?.some((route) => route !== "local" && route !== "cctp_fast" && route !== "cctp_standard")) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `Fee rule ${raw.id} routes are invalid`);
	}
	const minAmountAtomic = atomic(raw.minAmountAtomic, "minAmountAtomic");
	const maxAmountAtomic = atomic(raw.maxAmountAtomic, "maxAmountAtomic");
	if (minAmountAtomic && maxAmountAtomic && BigInt(minAmountAtomic) > BigInt(maxAmountAtomic)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", `Fee rule ${raw.id} amount range is invalid`);
	}
	return {
		id: raw.id,
		priority: Number(raw.priority),
		feeBps: Number(raw.feeBps),
		merchantIds,
		modes: modes as FeeRule["modes"],
		sourceChainIds: chainArray(raw.sourceChainIds),
		routes: routes as FeeRule["routes"],
		minAmountAtomic,
		maxAmountAtomic,
	};
}

function paymentFeePolicy(env: Bindings): PaymentFeePolicyDocument {
	const configured = env.PAYMENT_FEE_POLICY_JSON?.trim();
	if (!configured) return FREE_POLICY;
	if (new TextEncoder().encode(configured).byteLength > MAX_POLICY_BYTES) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy is too large");
	}
	let value: unknown;
	try {
		value = JSON.parse(configured);
	} catch {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy is malformed JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy is invalid");
	}
	const raw = value as Record<string, unknown>;
	rejectUnknownKeys(raw, POLICY_KEYS, "Payment fee policy");
	if (typeof raw.policyId !== "string" || !POLICY_ID.test(raw.policyId)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy id is invalid");
	}
	if (!Number.isSafeInteger(raw.version) || Number(raw.version) < 1 || Number(raw.version) > 2_147_483_647) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy version is invalid");
	}
	if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee policy rules are invalid");
	}
	const rules = raw.rules.map(parseRule);
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "Payment fee rule ids must be unique");
	}
	return { policyId: raw.policyId, version: Number(raw.version), rules };
}

function matches(rule: FeeRule, input: {
	intent: PaymentIntent;
	sourceChainId: number;
	route: PaymentRoute;
}): boolean {
	const amount = BigInt(input.intent.amountAtomic);
	return (!rule.merchantIds || rule.merchantIds.includes(input.intent.merchantId)) &&
		(!rule.modes || rule.modes.includes(input.intent.mode)) &&
		(!rule.sourceChainIds || rule.sourceChainIds.includes(input.sourceChainId)) &&
		(!rule.routes || rule.routes.includes(input.route)) &&
		(rule.minAmountAtomic === undefined || amount >= BigInt(rule.minAmountAtomic)) &&
		(rule.maxAmountAtomic === undefined || amount <= BigInt(rule.maxAmountAtomic));
}

function feeRecipient(env: Bindings, feeBps: number): Address | null {
	if (feeBps === 0) return null;
	if (!env.PAYMENT_PLATFORM_FEE_RECIPIENT || !isAddress(env.PAYMENT_PLATFORM_FEE_RECIPIENT)) {
		throw new FeePolicyError("INVALID_FEE_POLICY", "A valid platform fee recipient is required by the matched fee rule");
	}
	return getAddress(env.PAYMENT_PLATFORM_FEE_RECIPIENT);
}

export function resolvePaymentFee(env: Bindings, input: {
	intent: PaymentIntent;
	sourceChainId: number;
	route: PaymentRoute;
	routeFeeCapBps: number;
}): ResolvedPaymentFee {
	const policy = paymentFeePolicy(env);
	const candidates = policy.rules.filter((rule) => matches(rule, input))
		.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
	const rule = candidates[0];
	if (rule && candidates[1]?.priority === rule.priority && candidates[1].feeBps !== rule.feeBps) {
		throw new FeePolicyError("AMBIGUOUS_FEE_POLICY", "Multiple top-priority fee rules disagree");
	}
	const feeBps = rule?.feeBps ?? 0;
	if (!Number.isSafeInteger(input.routeFeeCapBps) || input.routeFeeCapBps < 0 || input.routeFeeCapBps > 100) {
		throw new FeePolicyError("INVALID_ROUTE_CAPABILITY", "Payment route fee capability is invalid");
	}
	if (feeBps > input.routeFeeCapBps) {
		throw new FeePolicyError("ROUTER_FEE_CAP_EXCEEDED", "Matched fee policy exceeds the deployed router capability");
	}
	if (feeBps > 0 && env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== "true") {
		throw new FeePolicyError("ROUTER_PREFLIGHT_REQUIRED",
			"On-chain router preflight must be enabled before any platform fee can be charged");
	}
	const amount = BigInt(input.intent.amountAtomic);
	return {
		policyId: policy.policyId,
		policyVersion: policy.version,
		ruleId: rule?.id ?? "free-default",
		platformFeeBps: feeBps,
		platformFeeBearer: feeBps === 0 ? "none" : "payer",
		platformFeeRecipient: feeRecipient(env, feeBps),
		routeFeeCapBps: input.routeFeeCapBps,
		platformFeeAtomic: (amount * BigInt(feeBps) / 10_000n).toString(),
	};
}

/** Maximum fee any configured rule could apply to this execution surface. */
export function maximumConfiguredFeeBps(env: Bindings, input: {
	sourceChainId: number;
	routes: PaymentRoute[];
}): number {
	const policy = paymentFeePolicy(env);
	return policy.rules.reduce((maximum, rule) => {
		if (rule.sourceChainIds && !rule.sourceChainIds.includes(input.sourceChainId)) return maximum;
		if (rule.routes && !rule.routes.some((route) => input.routes.includes(route))) return maximum;
		return Math.max(maximum, rule.feeBps);
	}, 0);
}

export function validatePaymentFeePolicyConfig(env: Bindings): string[] {
	try {
		const policy = paymentFeePolicy(env);
		if (policy.rules.some((rule) => rule.feeBps > 0)) {
			feeRecipient(env, 1);
			if (env.PAYMENT_ROUTER_PREFLIGHT_ENABLED !== "true") return ["ROUTER_PREFLIGHT_REQUIRED"];
		}
		return [];
	} catch (error) {
		return [error instanceof FeePolicyError ? error.code : "INVALID_FEE_POLICY"];
	}
}
