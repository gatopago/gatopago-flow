import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCrosschainOperation: vi.fn(), getAttempt: vi.fn(), getPaymentIntent: vi.fn(),
	settleAttempt: vi.fn(), updateCrosschainOperation: vi.fn(), recordCrosschainMintResult: vi.fn(),
	recordCrosschainMintBroadcast: vi.fn(), clearRevertedCrosschainMint: vi.fn(),
	recordCrosschainMintPrepared: vi.fn(), paymentPublicClient: vi.fn(), paymentWalletClient: vi.fn(),
	flushPaymentOutbox: vi.fn(),
}));

vi.mock("../src/repositories/crosschain", () => ({
 getCrosschainOperation: mocks.getCrosschainOperation, updateCrosschainOperation: mocks.updateCrosschainOperation,
 recordCrosschainMintResult: mocks.recordCrosschainMintResult, recordCrosschainMintBroadcast: mocks.recordCrosschainMintBroadcast,
 clearRevertedCrosschainMint: mocks.clearRevertedCrosschainMint, recordCrosschainMintPrepared: mocks.recordCrosschainMintPrepared,
 upsertCrosschainOperation: vi.fn(),
}));
vi.mock("../src/repositories/attempts", () => ({ getAttempt: mocks.getAttempt, getAttemptByHash: vi.fn(),
 listActiveRouterAddressesByChain: vi.fn(), markAttemptProcessing: vi.fn() }));
vi.mock("../src/repositories/intents", () => ({ getPaymentIntent: mocks.getPaymentIntent }));
vi.mock("../src/repositories/settlement", () => ({ settleAttempt: mocks.settleAttempt, recordAttemptFeeEvidence: vi.fn() }));
vi.mock("../src/services/clients", () => ({
	paymentPublicClient: mocks.paymentPublicClient,
	paymentWalletClient: mocks.paymentWalletClient,
	requiredConfirmations: () => 1,
}));
vi.mock("../src/services/queue", () => ({
	enqueuePaymentJob: vi.fn(), schedulePaymentJob: vi.fn(), flushPaymentOutbox: mocks.flushPaymentOutbox,
}));
vi.mock("../src/rails/onchain", () => ({ getCctpMessages: vi.fn() }));
vi.mock("../src/stores/chainJournalStore", () => ({
	commitRouterCheckpoint: vi.fn(), getRouterCheckpoint: vi.fn(), listCanonicalRouterBlocksBefore: vi.fn(),
	rollbackRouterJournal: vi.fn(), upsertPaymentChainEvent: vi.fn(),
}));
vi.mock("../src/services/signerLease", () => ({
	PaymentSignerLeaseBusyError: class PaymentSignerLeaseBusyError extends Error {},
	withPaymentSignerLease: vi.fn(async (_env: unknown, _input: unknown, action: () => Promise<unknown>) => action()),
}));

import { CCTP_CHAINS, getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import { cctpMessageNonce, mintCctpSettlement } from "../src/services/reconciliation";

const destinationChainId = 421614;
const sourceChainId = 84532;
const destination = CCTP_CHAINS[destinationChainId]!;
const source = getPaymentNetworkCapabilities(sourceChainId)!;
const txHash = `0x${"12".repeat(32)}` as Hex;
const nonce = `0x${"ab".repeat(32)}` as Hex;
const message = `0x${"00".repeat(12)}${nonce.slice(2)}${"00".repeat(104)}` as Hex;

const messageReceivedEvent = { type: "event", name: "MessageReceived", anonymous: false,
	inputs: [
		{ name: "caller", type: "address", indexed: true },
		{ name: "sourceDomain", type: "uint32", indexed: false },
		{ name: "nonce", type: "bytes32", indexed: true },
		{ name: "sender", type: "bytes32", indexed: false },
		{ name: "finalityThresholdExecuted", type: "uint32", indexed: true },
		{ name: "messageBody", type: "bytes", indexed: false },
	] } as const;

function operation(destinationTxHash: string | null) {
	return { opId: "cctp_att_1", attemptId: "att_1", sourceChainId, destinationChainId,
		route: "cctp_fast", status: "minting", sourceTxHash: `0x${"34".repeat(32)}`,
		messageHash: null, message, attestation: "0x1234", burnAmountAtomic: "10010000",
		platformFeeAtomic: "0", networkFeeAtomic: "10000", destinationTxHash,
		messageNonce: nonce, mintedAmountAtomic: "10000000",
		mintRawTransaction: destinationTxHash ? "0xdeadbeef" : null,
		mintSignerAddress: destinationTxHash ? "0x00000000000000000000000000000000000000aa" : null,
		mintNonce: destinationTxHash ? 7 : null, mintBroadcastAt: null, attemptCount: 1,
		createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" };
}

const attempt = { id: "att_1", intentId: "pi_1", payerAddress: "0x00000000000000000000000000000000000000b2" };
const intent = { id: "pi_1" };

function receivedLog(hash = txHash) {
	const caller = "0x00000000000000000000000000000000000000aa" as const;
	const sender = `0x${"cd".repeat(32)}` as Hex;
	return { address: destination.messageTransmitter, transactionHash: hash, blockNumber: 100n,
		blockHash: `0x${"56".repeat(32)}` as Hex, logIndex: 0,
		topics: encodeEventTopics({ abi: [messageReceivedEvent], eventName: "MessageReceived",
			args: { caller, nonce, finalityThresholdExecuted: 1000 } }),
		data: encodeAbiParameters([{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
			[source.cctpDomain, sender, "0x"]), removed: false,
		args: { caller, sourceDomain: source.cctpDomain, nonce, sender,
			finalityThresholdExecuted: 1000, messageBody: "0x" } };
}

function publicClient(options: { used: boolean; storedReceipt?: boolean; logs?: ReturnType<typeof receivedLog>[] }) {
	return { readContract: vi.fn().mockResolvedValue(options.used ? 1n : 0n),
		getTransactionReceipt: vi.fn().mockImplementation(async ({ hash }: { hash: Hex }) => {
			if (!options.storedReceipt || hash !== txHash) throw new Error("not found");
			return { status: "success", blockNumber: 100n, logs: [receivedLog(hash)] };
		}),
		getBlockNumber: vi.fn().mockResolvedValue(100n),
		getLogs: vi.fn().mockResolvedValue(options.logs ?? []),
		getTransaction: vi.fn().mockRejectedValue(new Error("not found")),
		simulateContract: vi.fn().mockResolvedValue({ request: {} }),
		sendRawTransaction: vi.fn().mockResolvedValue(txHash) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAttempt.mockResolvedValue(attempt);
	mocks.getPaymentIntent.mockResolvedValue(intent);
	mocks.settleAttempt.mockResolvedValue({ applied: true, intent, eventId: "evt_1" });
	mocks.updateCrosschainOperation.mockResolvedValue(undefined);
	mocks.recordCrosschainMintResult.mockResolvedValue(undefined);
	mocks.recordCrosschainMintBroadcast.mockResolvedValue(undefined);
	mocks.recordCrosschainMintPrepared.mockResolvedValue(true);
	mocks.flushPaymentOutbox.mockResolvedValue(1);
});

describe("CCTP mint crash recovery", () => {
	it("extracts the v2 bytes32 nonce from the signed message", () => {
		expect(cctpMessageNonce(message)).toBe(nonce);
	});

	it("finishes from a confirmed stored broadcast without sending a second mint", async () => {
		mocks.getCrosschainOperation.mockResolvedValue(operation(txHash));
		const client = publicClient({ used: true, storedReceipt: true });
		mocks.paymentPublicClient.mockReturnValue(client);
		expect(await mintCctpSettlement({} as never, "cctp_att_1")).toBe(true);
		expect(mocks.paymentWalletClient).not.toHaveBeenCalled();
		expect(client.sendRawTransaction).not.toHaveBeenCalled();
		expect(mocks.settleAttempt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			settledAmountAtomic: "10000000", destinationTxHash: txHash,
		}));
		expect(mocks.updateCrosschainOperation).toHaveBeenCalledWith(expect.anything(), "cctp_att_1",
			expect.objectContaining({ status: "settled", destinationTxHash: txHash }));
	});

	it("recovers MessageReceived when the chain advanced before D1 stored the hash", async () => {
		mocks.getCrosschainOperation.mockResolvedValue(operation(null));
		const client = publicClient({ used: true, storedReceipt: true, logs: [receivedLog()] });
		mocks.paymentPublicClient.mockReturnValue(client);
		expect(await mintCctpSettlement({} as never, "cctp_att_1")).toBe(true);
		expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
			address: destination.messageTransmitter, args: { nonce }, fromBlock: 0n,
		}));
		expect(mocks.paymentWalletClient).not.toHaveBeenCalled();
	});

	it("rebroadcasts the exact persisted bytes after a crash before receipt", async () => {
		mocks.getCrosschainOperation.mockResolvedValue(operation(txHash));
		const client = publicClient({ used: false });
		mocks.paymentPublicClient.mockReturnValue(client);
		expect(await mintCctpSettlement({} as never, "cctp_att_1")).toBe(false);
		expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: "0xdeadbeef" });
		expect(mocks.recordCrosschainMintBroadcast).toHaveBeenCalledWith(expect.anything(), "cctp_att_1", txHash);
		expect(mocks.paymentWalletClient).not.toHaveBeenCalled();
		expect(mocks.settleAttempt).not.toHaveBeenCalled();
	});

	it("persists a signed transaction and nonce before the first RPC broadcast", async () => {
		mocks.getCrosschainOperation.mockResolvedValue(operation(null));
		const rawTransaction = "0x02deadbeef" as Hex;
		const preparedHash = keccak256(rawTransaction);
		const client = publicClient({ used: false });
		client.sendRawTransaction.mockResolvedValue(preparedHash);
		mocks.paymentPublicClient.mockReturnValue(client);
		mocks.paymentWalletClient.mockReturnValue({
			account: { address: "0x00000000000000000000000000000000000000aa" },
			prepareTransactionRequest: vi.fn().mockResolvedValue({ nonce: 7, to: destination.messageTransmitter,
				data: "0x1234", chain: undefined, account: { address: "0x00000000000000000000000000000000000000aa" } }),
			signTransaction: vi.fn().mockResolvedValue(rawTransaction),
		});
		expect(await mintCctpSettlement({} as never, "cctp_att_1")).toBe(false);
		expect(mocks.recordCrosschainMintPrepared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			txHash: preparedHash, rawTransaction, nonce: 7,
		}));
		expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: rawTransaction });
		expect(mocks.recordCrosschainMintPrepared.mock.invocationCallOrder[0])
			.toBeLessThan(client.sendRawTransaction.mock.invocationCallOrder[0]!);
	});
});
