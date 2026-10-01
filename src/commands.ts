import { formatUnits } from "viem";
import { isSettlementAccountCommand, isReserveWalletPaymentAttemptCommand, isRegisterWalletPaymentExecutionCommand, type RegisterWalletPaymentExecutionCommand, type RegisteredWalletPaymentExecution, type ReserveWalletPaymentAttemptCommand, type ReservedWalletPaymentAttempt, type RpcResult, type RpcErrorCode, type SettlementAccountCommand, type SettlementAccountResult } from "@gatopago/shared/payment-contracts";
import { amount, walletAddress, DomainValidationError } from "./domain/validation";
import { getAttemptByIdempotency, insertQuoteAndAttempt, registerWalletExecution } from "./repositories/attempts";
import { getIntentByLink, getPaymentLink, releaseExpiredPayerDefinedAmount } from "./repositories/intents";
import { SettlementAccountConflict, upsertSettlementAccount as persistSettlementAccount } from "./repositories/accounts";
import { authorizeAttempt, buildQuote, QuoteError } from "./services/quoteEngine";
import { enqueuePaymentJob } from "./services/queue";
import { logError } from "./services/logger";
import type { Bindings } from "./env";

function rpcError<T>(error: RpcErrorCode, message: string): RpcResult<T> {
	return { ok: false, contractVersion: 3, error, message };
}

export class PaymentCommands {
	constructor(private readonly env: Bindings) {}
	async upsertSettlementAccount(command: SettlementAccountCommand): Promise<RpcResult<SettlementAccountResult>> {
		if (!isSettlementAccountCommand(command)) return rpcError("INVALID_CONTRACT", "Unsupported or malformed settlement account command");
		try {
			const value = await persistSettlementAccount(this.env, { commandId: command.commandId,
				ownerUserId: command.claim.userId, accountVersion: command.accountVersion,
				walletAddress: walletAddress(command.walletAddress), chainId: command.chainId });
			return { ok: true, contractVersion: 3, value };
		} catch (error) {
			if (error instanceof SettlementAccountConflict) return rpcError("CONFLICT", error.message);
			logError("payments_rpc_settlement_account_failed", error, { requestId: command.claim.requestId });
			return error instanceof DomainValidationError ? rpcError("INVALID_COMMAND", error.message)
				: rpcError("UNAVAILABLE", "Settlement account storage is unavailable");
		}
	}

	async reserveWalletPaymentAttempt(command: ReserveWalletPaymentAttemptCommand): Promise<RpcResult<ReservedWalletPaymentAttempt>> {
		if (!isReserveWalletPaymentAttemptCommand(command)) return rpcError("INVALID_CONTRACT", "Unsupported or malformed attempt command");
		try {
			const link = await getPaymentLink(this.env, command.linkId);
			const initialIntent = link ? await getIntentByLink(this.env, link.id) : null;
			if (!link || !initialIntent) return rpcError("NOT_FOUND", "Payment link not found");
			const payer = walletAddress(command.payerAddress);
			const replay = await getAttemptByIdempotency(this.env, { intentId: initialIntent.id, payerAddress: payer,
				sourceChainId: command.sourceChainId, idempotencyKey: command.commandId });
			if (!replay) await releaseExpiredPayerDefinedAmount(this.env, initialIntent.id);
			const intent = await getIntentByLink(this.env, link.id);
			if (!intent) return rpcError("NOT_FOUND", "Payment intent not found");
			let attempt = replay;
			if (!attempt) {
				let effectiveIntent = intent;
				if (intent.amountMode === "payer_defined") {
					const selected = amount(command.amount);
					effectiveIntent = { ...intent, amount: selected.decimal, amountAtomic: selected.atomic };
				}
				const quote = await buildQuote(this.env, { intent: effectiveIntent, payer,
					sourceChainId: command.sourceChainId, requestedRoute: "auto" });
				if (quote.route !== "local") throw new QuoteError("ROUTE_UNAVAILABLE", "GatoPago balance execution must use the local router");
				const authorized = await authorizeAttempt(this.env, { intent: effectiveIntent, quote, payerUserId: command.claim.userId });
				attempt = await insertQuoteAndAttempt(this.env, { quote, attempt: authorized, idempotencyKey: command.commandId });
			}
			return { ok: true, contractVersion: 3, value: {
				attemptId: attempt.id, intentId: intent.id, linkId: link.id, merchant: intent.settlementWallet,
				amount: formatUnits(BigInt(attempt.settlementAmountAtomic), 6), currency: "USDC", sourceChainId: attempt.sourceChainId,
				router: attempt.routerAddress, authorization: attempt.authorization as ReservedWalletPaymentAttempt["authorization"],
				signature: attempt.signature, authorizationHash: attempt.authorizationHash,
				expiresAt: attempt.expiresAt,
			} };
		} catch (error) {
			logError("payments_rpc_attempt_reserve_failed", error, { requestId: command.claim.requestId });
			return error instanceof QuoteError ? rpcError(error.code === "SIGNER_UNAVAILABLE" ? "UNAVAILABLE" : "CONFLICT", error.message) : rpcError("INVALID_COMMAND", error instanceof Error ? error.message : "Invalid command");
		}
	}

	async registerWalletPaymentExecution(command: RegisterWalletPaymentExecutionCommand): Promise<RpcResult<RegisteredWalletPaymentExecution>> {
		if (!isRegisterWalletPaymentExecutionCommand(command)) return rpcError<RegisteredWalletPaymentExecution>("INVALID_CONTRACT", "Unsupported or malformed execution command");
		const value = await registerWalletExecution(this.env, command);
		if (!value) return rpcError<RegisteredWalletPaymentExecution>("CONFLICT", "Attempt and execution do not match");
		await enqueuePaymentJob(this.env, { job: "attempt_reconcile", resourceId: value.attemptId,
			dedupeKey: `wallet-execution:${value.attemptId}:${value.userOpHash}`, partition: String(command.sourceChainId) });
		await enqueuePaymentJob(this.env, { job: "router_watch", resourceId: value.attemptId,
			dedupeKey: `wallet-router-watch:${value.attemptId}:${value.userOpHash}`, partition: String(command.sourceChainId) });
		return { ok: true, contractVersion: 3, value };
	}
}
