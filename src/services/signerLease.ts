import type { Bindings } from "../env";
import { acquirePaymentSignerLease, releasePaymentSignerLease } from "../stores/signerLeaseStore";
import { logWarn } from "./logger";

const PAYMENT_SIGNER_LEASE_TTL_MS = 120_000;

export class PaymentSignerLeaseBusyError extends Error {
	constructor() {
		super("The payment relayer signer is busy. Retry shortly.");
		this.name = "PaymentSignerLeaseBusyError";
	}
}

function paymentSignerLeaseKey(chainId: number, signerAddress: string): string {
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid signer chain ID");
	if (!/^0x[0-9a-fA-F]{40}$/u.test(signerAddress)) throw new Error("Invalid signer address");
	return `cctp-mint:${chainId}:${signerAddress.toLowerCase()}`;
}

export async function withPaymentSignerLease<T>(
	env: Bindings,
	input: { chainId: number; signerAddress: string },
	action: () => Promise<T>,
): Promise<T> {
	const key = paymentSignerLeaseKey(input.chainId, input.signerAddress);
	const owner = await acquirePaymentSignerLease(env, key, PAYMENT_SIGNER_LEASE_TTL_MS);
	if (!owner) throw new PaymentSignerLeaseBusyError();
	try {
		return await action();
	} finally {
		await releasePaymentSignerLease(env, key, owner).catch((error) => {
			logWarn("payment_signer_lease_release_failed", {
				chainId: input.chainId,
				signerAddress: input.signerAddress.toLowerCase(),
				reason: error instanceof Error ? error.name : "unknown",
			});
		});
	}
}
