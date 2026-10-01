export type Merchant = {
	id: string;
	ownerUserId: string;
	displayName: string;
	settlementWallet: `0x${string}`;
	settlementChainId: number;
	accountVersion: number;
	status: "active" | "disabled";
	createdAt: string;
	updatedAt: string;
};

type PaymentIntentStatus =
	| "awaiting_payment"
	| "processing"
	| "paid"
	| "overpaid"
	| "canceled"
	| "expired"
	| "failed";

export type PaymentIntent = {
	id: string;
	merchantId: string;
	linkId: string | null;
	amount: string;
	amountAtomic: string;
	amountMode: "fixed" | "payer_defined";
	currency: "USDC";
	reference: string;
	metadata: Record<string, unknown>;
	mode: "test" | "live";
	status: PaymentIntentStatus;
	settlementWallet: `0x${string}`;
	settlementChainId: number;
	settlementAccountVersion: number;
	paidAmountAtomic: string;
	paidTxHash: string | null;
	paidAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type PaymentLink = {
	id: string;
	intentId: string;
	merchantId: string;
	ownerUserId: string;
	wallet: `0x${string}`;
	amount: string;
	currency: "USDC";
	reference: string;
	status: "pending" | "paid" | "canceled" | "expired";
	txHash: string | null;
	paidAt: string | null;
	paidBy: string | null;
	createdAt: string;
	updatedAt: string;
};

export type PaymentRoute = "local" | "cctp_fast" | "cctp_standard";
export type PaymentAttemptStatus =
	| "reserved"
	| "submitted"
	| "processing"
	| "paid"
	| "overpaid"
	| "failed"
	| "expired"
	| "canceled";

export type PaymentQuote = {
	id: string;
	intentId: string;
	payer: `0x${string}`;
	sourceChainId: number;
	route: PaymentRoute;
	settlementAmountAtomic: string;
	platformFeeAtomic: string;
	cctpFeeAtomic: string;
	grossPayerAmountAtomic: string;
	feePolicyId: string;
	feePolicyVersion: number;
	feeRuleId: string;
	platformFeeBps: number;
	platformFeeBearer: "none" | "payer";
	platformFeeRecipient: `0x${string}` | null;
	routeFeeCapBps: number;
	feeSource: "local" | "circle_live";
	feeObservedAt: string;
	expiresAt: string;
	quoteHash: `0x${string}`;
	createdAt: string;
};

export type PaymentAttempt = {
	id: string;
	attemptHash: `0x${string}`;
	intentId: string;
	quoteId: string;
	payerUserId: string | null;
	payerAddress: `0x${string}`;
	sourceChainId: number;
	route: PaymentRoute;
	status: PaymentAttemptStatus;
	routerAddress: `0x${string}`;
	authorizationHash: `0x${string}`;
	authorization: Record<string, unknown>;
	signature: `0x${string}`;
	checkoutCapabilityHash: `0x${string}` | null;
	payerProofSignature: `0x${string}` | null;
	payerProofMessageHash: `0x${string}` | null;
	validAfter: number;
	validUntil: number;
	userOpHash: string | null;
	sourceTxHash: string | null;
	destinationTxHash: string | null;
	settlementAmountAtomic: string;
	platformFeeAtomic: string;
	cctpFeeAtomic: string;
	grossPayerAmountAtomic: string;
	feePolicyId: string;
	feePolicyVersion: number;
	feeRuleId: string;
	platformFeeBps: number;
	platformFeeBearer: "none" | "payer";
	platformFeeRecipient: `0x${string}` | null;
	routeFeeCapBps: number;
	settledAmountAtomic: string;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
};
