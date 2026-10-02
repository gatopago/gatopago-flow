import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { CCTP_CHAINS, getPaymentNetworkCapabilities } from "@gatopago/shared/payment-networks";
import { cctpPaymentRouterAbi, paymentRouterAbi } from "@gatopago/shared/payment-abis";
import type { Bindings } from "../env";
import {
  getAttempt,
  getAttemptByHash,
  listActiveRouterAddressesByChain,
  markAttemptProcessing,
} from "../repositories/attempts";
import {
  getCrosschainOperation,
  clearRevertedCrosschainMint,
  recordCrosschainMintBroadcast,
  recordCrosschainMintPrepared,
  recordCrosschainMintResult,
  updateCrosschainOperation,
  upsertCrosschainOperation,
} from "../repositories/crosschain";
import { getPaymentIntent } from "../repositories/intents";
import { recordAttemptFeeEvidence, settleAttempt } from "../repositories/settlement";
import { enqueuePaymentJob, flushPaymentOutbox, schedulePaymentJob } from "./queue";
import { logInfo, logWarn } from "./logger";
import { paymentPublicClient, paymentWalletClient, requiredConfirmations } from "./clients";
import { getCctpMessages } from "../rails/onchain/circleClient";
import { PaymentSignerLeaseBusyError, withPaymentSignerLease } from "./signerLease";
import {
  commitRouterCheckpoint,
  getRouterCheckpoint,
  listCanonicalRouterBlocksBefore,
  rollbackRouterJournal,
  upsertPaymentChainEvent,
  type RouterCheckpoint,
} from "../stores/chainJournalStore";

const messageSentAbi = [
  {
    type: "event",
    name: "MessageSent",
    anonymous: false,
    inputs: [{ name: "message", type: "bytes", indexed: false }],
  },
] as const;
const messageReceivedEvent = {
  type: "event",
  name: "MessageReceived",
  anonymous: false,
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "sourceDomain", type: "uint32", indexed: false },
    { name: "nonce", type: "bytes32", indexed: true },
    { name: "sender", type: "bytes32", indexed: false },
    { name: "finalityThresholdExecuted", type: "uint32", indexed: true },
    { name: "messageBody", type: "bytes", indexed: false },
  ],
} as const;
const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  messageReceivedEvent,
] as const;

const MAX_CCTP_MINT_ATTEMPTS = 20;

function jsonEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

/** CCTP v2 nonce occupies bytes 12..43 of MessageV2. */
export function cctpMessageNonce(message: Hex): Hex {
  if (!isHex(message, { strict: true }) || message.length < 90) {
    throw new Error("CCTP message is too short");
  }
  return `0x${message.slice(26, 90)}` as Hex;
}

function messageReceivedArgs(log: Log, nonce: Hex, sourceDomain: number): boolean {
  try {
    const decoded = decodeEventLog({
      abi: [messageReceivedEvent],
      data: log.data,
      topics: log.topics,
      eventName: "MessageReceived",
    });
    return (
      String(decoded.args.nonce).toLowerCase() === nonce.toLowerCase() &&
      Number(decoded.args.sourceDomain) === sourceDomain
    );
  } catch {
    return false;
  }
}

async function verifyRouterCheckpoint(
  env: Bindings,
  chainId: number,
  client: ReturnType<typeof paymentPublicClient>,
  checkpoint: RouterCheckpoint | null,
): Promise<RouterCheckpoint | null> {
  if (!checkpoint) {
    return null;
  }
  try {
    const remote = await client.getBlock({ blockNumber: BigInt(checkpoint.block_number) });
    if (remote.hash.toLowerCase() === checkpoint.block_hash.toLowerCase()) {
      return checkpoint;
    }
  } catch {
    /* A missing checkpoint block is also a reorg signal. */
  }

  const candidates = await listCanonicalRouterBlocksBefore(env, chainId, checkpoint.block_number);
  let ancestor: RouterCheckpoint | null = null;
  for (const candidate of candidates) {
    try {
      const remote = await client.getBlock({ blockNumber: BigInt(candidate.block_number) });
      if (remote.hash.toLowerCase() === candidate.block_hash.toLowerCase()) {
        ancestor = candidate;
        break;
      }
    } catch {
      /* Continue walking the bounded local journal. */
    }
  }
  if (!ancestor) {
    const blockNumber = Math.max(0, checkpoint.block_number - 2_000);
    const remote = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    ancestor = { block_number: blockNumber, block_hash: remote.hash };
  }
  const orphanedCount = await rollbackRouterJournal(env, { chainId, checkpoint, ancestor });
  logWarn("payment_router_reorg_recovered", {
    chainId,
    previousBlock: checkpoint.block_number,
    commonAncestor: ancestor.block_number,
    orphanedEvents: orphanedCount,
  });
  return ancestor;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function eventArgs(
  log: Log,
  abi: typeof paymentRouterAbi | typeof cctpPaymentRouterAbi,
  eventName: "PaymentSettled" | "CctpPaymentBurned",
): Record<string, unknown> | null {
  try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, eventName });
    const args: unknown = decoded.args;
    return args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class PaymentSourceEvidenceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentSourceEvidenceMismatchError";
  }
}

type SourceReceipt = Pick<TransactionReceipt, "status" | "from" | "to" | "logs">;

/**
 * Validate only source-chain facts. Finality and settlement remain the job of
 * reconciliation. Keeping this pure lets the public registration endpoint
 * reject invented hashes without trusting anything returned by the browser.
 */
export function validatePaymentSourceReceipt(input: {
  attempt: NonNullable<Awaited<ReturnType<typeof getAttempt>>>;
  intent: NonNullable<Awaited<ReturnType<typeof getPaymentIntent>>>;
  receipt: SourceReceipt;
}): { args: Record<string, unknown>; message?: Hex } {
  const { attempt, intent, receipt } = input;
  if (receipt.status !== "success") {
    throw new PaymentSourceEvidenceMismatchError("Payment source transaction reverted");
  }
  if (
    !sameAddress(receipt.from, attempt.payerAddress) ||
    !sameAddress(receipt.to, attempt.routerAddress)
  ) {
    throw new PaymentSourceEvidenceMismatchError(
      "Payment source transaction sender or router does not match the signed attempt",
    );
  }

  const eventName = attempt.route === "local" ? "PaymentSettled" : "CctpPaymentBurned";
  const abi = attempt.route === "local" ? paymentRouterAbi : cctpPaymentRouterAbi;
  const routerLog = receipt.logs.find(
    (log) => sameAddress(log.address, attempt.routerAddress) && !!eventArgs(log, abi, eventName),
  );
  if (!routerLog) {
    throw new PaymentSourceEvidenceMismatchError(`${eventName} evidence is missing`);
  }
  const args = eventArgs(routerLog, abi, eventName)!;
  const commonMismatch =
    String(args.attemptId).toLowerCase() !== attempt.attemptHash.toLowerCase() ||
    String(args.intentId).toLowerCase() !== String(attempt.authorization.intentId).toLowerCase() ||
    !sameAddress(args.payer, attempt.payerAddress) ||
    !sameAddress(args.merchant, intent.settlementWallet) ||
    BigInt(String(args.settlementAmount)) !== BigInt(attempt.settlementAmountAtomic) ||
    BigInt(String(args.platformFee)) !== BigInt(attempt.platformFeeAtomic);
  if (commonMismatch) {
    throw new PaymentSourceEvidenceMismatchError(
      `${eventName} evidence does not match the signed attempt`,
    );
  }

  if (attempt.route === "local") {
    return { args };
  }
  if (
    BigInt(String(args.grossPayerAmount)) !== BigInt(attempt.grossPayerAmountAtomic) ||
    BigInt(String(args.maxCctpFee)) !== BigInt(attempt.cctpFeeAtomic)
  ) {
    throw new PaymentSourceEvidenceMismatchError(
      "CCTP burn economics do not match the signed attempt",
    );
  }
  const messageLog = receipt.logs.find((log) => {
    try {
      decodeEventLog({
        abi: messageSentAbi,
        data: log.data,
        topics: log.topics,
        eventName: "MessageSent",
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!messageLog) {
    throw new PaymentSourceEvidenceMismatchError("CCTP MessageSent evidence is missing");
  }
  const decoded = decodeEventLog({
    abi: messageSentAbi,
    data: messageLog.data,
    topics: messageLog.topics,
    eventName: "MessageSent",
  });
  return { args, message: decoded.args.message };
}

export async function verifyReportedSourceTransaction(
  env: Bindings,
  attemptId: string,
  txHash: Hex,
): Promise<boolean> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) {
    throw new PaymentSourceEvidenceMismatchError("Payment attempt is missing");
  }
  const intent = await getPaymentIntent(env, attempt.intentId);
  if (!intent) {
    throw new PaymentSourceEvidenceMismatchError("Payment intent is missing");
  }
  let receipt: TransactionReceipt;
  try {
    receipt = await paymentPublicClient(env, attempt.sourceChainId).getTransactionReceipt({
      hash: txHash,
    });
  } catch (error) {
    if (
      error instanceof TransactionReceiptNotFoundError ||
      (error instanceof Error && error.name === "TransactionReceiptNotFoundError")
    ) {
      return false;
    }
    throw error;
  }
  validatePaymentSourceReceipt({ attempt, intent, receipt });
  return true;
}

async function confirmedReceipt(env: Bindings, chainId: number, txHash: Hex) {
  const client = paymentPublicClient(env, chainId);
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Payment source transaction reverted");
  }
  const current = await client.getBlockNumber();
  if (current - receipt.blockNumber + 1n < BigInt(requiredConfirmations(env, chainId))) {
    return null;
  }
  return receipt;
}

async function reconcileLocal(env: Bindings, attemptId: string, txHash: Hex): Promise<boolean> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) {
    return true;
  }
  if (attempt.status === "paid" || attempt.status === "overpaid") {
    return true;
  }
  const intent = await getPaymentIntent(env, attempt.intentId);
  if (!intent) {
    throw new Error("Payment intent missing for attempt");
  }
  const receipt = await confirmedReceipt(env, attempt.sourceChainId, txHash);
  if (!receipt) {
    return false;
  }
  const { args } = validatePaymentSourceReceipt({ attempt, intent, receipt });
  await settleAttempt(env, {
    attemptId: attempt.id,
    sourceTxHash: txHash,
    settledAmountAtomic: String(args.settlementAmount),
    payerAddress: attempt.payerAddress,
    platformFeeAtomic: String(args.platformFee),
    networkFeeAtomic: "0",
  });
  await flushPaymentOutbox(env, 10);
  return true;
}

async function reconcileBurn(env: Bindings, attemptId: string, txHash: Hex): Promise<boolean> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) {
    return true;
  }
  if (attempt.status === "paid" || attempt.status === "overpaid") {
    return true;
  }
  const intent = await getPaymentIntent(env, attempt.intentId);
  if (!intent) {
    throw new Error("Payment intent missing for attempt");
  }
  const receipt = await confirmedReceipt(env, attempt.sourceChainId, txHash);
  if (!receipt) {
    return false;
  }
  const { args, message } = validatePaymentSourceReceipt({ attempt, intent, receipt });
  if (!message) {
    throw new Error("CCTP MessageSent evidence is missing");
  }
  const opId = await upsertCrosschainOperation(env, {
    attemptId: attempt.id,
    sourceChainId: attempt.sourceChainId,
    destinationChainId: intent.settlementChainId,
    route: attempt.route as "cctp_fast" | "cctp_standard",
    sourceTxHash: txHash,
    messageHash: keccak256(message),
    message,
    burnAmountAtomic: String(args.amountBurned),
    platformFeeAtomic: String(args.platformFee),
  });
  await recordAttemptFeeEvidence(env, {
    attemptId: attempt.id,
    platformFeeAtomic: String(args.platformFee),
    chargedTxHash: txHash,
  });
  await markAttemptProcessing(env, attempt.id, txHash);
  await schedulePaymentJob(env, {
    job: "cctp_attestation",
    resourceId: opId,
    dedupeKey: `cctp-attestation:${opId}`,
    partition: String(attempt.sourceChainId),
    delaySeconds: 5,
  });
  return true;
}

export async function reconcileAttempt(env: Bindings, attemptId: string): Promise<boolean> {
  const attempt = await getAttempt(env, attemptId);
  if (
    !attempt ||
    attempt.status === "paid" ||
    attempt.status === "overpaid" ||
    attempt.status === "failed"
  ) {
    return true;
  }
  if (!attempt.sourceTxHash || !isHex(attempt.sourceTxHash, { strict: true })) {
    return false;
  }
  return attempt.route === "local"
    ? reconcileLocal(env, attempt.id, attempt.sourceTxHash as Hex)
    : reconcileBurn(env, attempt.id, attempt.sourceTxHash as Hex);
}

export async function advanceCctpAttestation(env: Bindings, opId: string): Promise<boolean> {
  const operation = await getCrosschainOperation(env, opId);
  if (operation.status === "settled") {
    return true;
  }
  if (!operation.sourceTxHash) {
    return false;
  }
  const attempt = await getAttempt(env, operation.attemptId);
  const intent = attempt ? await getPaymentIntent(env, attempt.intentId) : null;
  const source = getPaymentNetworkCapabilities(operation.sourceChainId);
  const destination = getPaymentNetworkCapabilities(operation.destinationChainId);
  if (!attempt || !intent || !source || !destination) {
    throw new Error("CCTP operation configuration is incomplete");
  }
  const messages = await getCctpMessages(env, {
    sourceDomain: source.cctpDomain,
    transactionHash: operation.sourceTxHash,
  });
  if (messages === null) {
    return false;
  }
  const candidate = messages.find((item) => {
    const body = item.decodedMessage?.decodedMessageBody;
    return (
      item.cctpVersion === 2 &&
      item.status === "complete" &&
      isHex(item.message) &&
      isHex(item.attestation) &&
      item.decodedMessage?.sourceDomain === String(source.cctpDomain) &&
      item.decodedMessage?.destinationDomain === String(destination.cctpDomain) &&
      sameAddress(body?.burnToken, source.usdc) &&
      sameAddress(body?.mintRecipient, intent.settlementWallet) &&
      sameAddress(body?.messageSender, attempt.routerAddress) &&
      BigInt(body?.amount ?? "0") >= BigInt(attempt.settlementAmountAtomic)
    );
  });
  if (!candidate) {
    return false;
  }
  if (
    operation.messageHash &&
    keccak256(candidate.message).toLowerCase() !== operation.messageHash.toLowerCase()
  ) {
    throw new Error("Circle message does not match the source MessageSent event");
  }
  if (!operation.burnAmountAtomic || !operation.platformFeeAtomic) {
    throw new Error("CCTP burn economic evidence is incomplete");
  }
  const mintedAmount = BigInt(candidate.decodedMessage!.decodedMessageBody!.amount!);
  const networkFee = BigInt(operation.burnAmountAtomic) - mintedAmount;
  if (networkFee < 0n || networkFee > BigInt(attempt.cctpFeeAtomic)) {
    throw new Error("Circle message fee does not match the signed quote");
  }
  await recordAttemptFeeEvidence(env, {
    attemptId: attempt.id,
    platformFeeAtomic: operation.platformFeeAtomic,
    networkFeeAtomic: networkFee.toString(),
    chargedTxHash: operation.sourceTxHash,
  });
  const messageNonce = cctpMessageNonce(candidate.message);
  await updateCrosschainOperation(env, operation.opId, {
    status: "minting",
    message: candidate.message,
    attestation: candidate.attestation,
    networkFeeAtomic: networkFee.toString(),
    messageNonce,
    mintedAmountAtomic: mintedAmount.toString(),
  });
  await enqueuePaymentJob(env, {
    job: "cctp_mint",
    resourceId: operation.opId,
    dedupeKey: `cctp-mint:${operation.opId}:${keccak256(candidate.message)}`,
    partition: String(operation.destinationChainId),
  });
  return true;
}

async function nonceWasUsed(
  client: ReturnType<typeof paymentPublicClient>,
  messageTransmitter: Address,
  nonce: Hex,
): Promise<boolean> {
  const used = await client.readContract({
    address: messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "usedNonces",
    args: [nonce],
  });
  return BigInt(used) !== 0n;
}

async function confirmedMintTransaction(
  env: Bindings,
  input: {
    client: ReturnType<typeof paymentPublicClient>;
    chainId: number;
    messageTransmitter: Address;
    nonce: Hex;
    sourceDomain: number;
    txHash: Hex;
  },
): Promise<boolean> {
  let receipt: Awaited<ReturnType<typeof input.client.getTransactionReceipt>>;
  try {
    receipt = await input.client.getTransactionReceipt({ hash: input.txHash });
  } catch {
    return false;
  }
  if (receipt.status !== "success") {
    return false;
  }
  const current = await input.client.getBlockNumber();
  if (current - receipt.blockNumber + 1n < BigInt(requiredConfirmations(env, input.chainId))) {
    return false;
  }
  return receipt.logs.some(
    (log) =>
      sameAddress(log.address, input.messageTransmitter) &&
      messageReceivedArgs(log, input.nonce, input.sourceDomain),
  );
}

async function recoverMintTransactionHash(
  env: Bindings,
  input: {
    client: ReturnType<typeof paymentPublicClient>;
    chainId: number;
    messageTransmitter: Address;
    nonce: Hex;
    sourceDomain: number;
    storedHash: string | null;
  },
): Promise<Hex | null> {
  if (
    input.storedHash &&
    isHex(input.storedHash, { strict: true }) &&
    (await confirmedMintTransaction(env, { ...input, txHash: input.storedHash as Hex }))
  ) {
    return input.storedHash as Hex;
  }
  // This indexed lookup covers the narrow crash window where the permissionless
  // mint landed but D1 never retained the broadcaster's transaction hash.
  const tip = await input.client.getBlockNumber();
  const logs = await input.client.getLogs({
    address: input.messageTransmitter,
    event: messageReceivedEvent,
    args: { nonce: input.nonce },
    fromBlock: 0n,
    toBlock: tip,
  });
  for (const log of logs.toReversed()) {
    if (!log.transactionHash || Number(log.args.sourceDomain) !== input.sourceDomain) {
      continue;
    }
    if (await confirmedMintTransaction(env, { ...input, txHash: log.transactionHash })) {
      return log.transactionHash;
    }
  }
  return null;
}

async function finalizeCctpSettlement(
  env: Bindings,
  input: {
    operation: Awaited<ReturnType<typeof getCrosschainOperation>>;
    attempt: NonNullable<Awaited<ReturnType<typeof getAttempt>>>;
    destinationTxHash: Hex;
  },
): Promise<void> {
  const { operation, attempt, destinationTxHash } = input;
  if (
    !operation.sourceTxHash ||
    !operation.platformFeeAtomic ||
    operation.networkFeeAtomic === null ||
    !operation.mintedAmountAtomic
  ) {
    throw new Error("CCTP settlement evidence is incomplete");
  }
  // Economic settlement wins before the transport row becomes terminal. A
  // crash between these writes is replay-safe: settleAttempt is idempotent and
  // the next pass can still advance the CCTP row.
  await settleAttempt(env, {
    attemptId: attempt.id,
    sourceTxHash: operation.sourceTxHash,
    destinationTxHash,
    settledAmountAtomic: operation.mintedAmountAtomic,
    payerAddress: attempt.payerAddress,
    platformFeeAtomic: operation.platformFeeAtomic,
    networkFeeAtomic: operation.networkFeeAtomic,
  });
  await updateCrosschainOperation(env, operation.opId, {
    status: "settled",
    destinationTxHash,
    mintedAmountAtomic: operation.mintedAmountAtomic,
  });
  await flushPaymentOutbox(env, 10);
}

async function broadcastPreparedMint(
  env: Bindings,
  input: {
    opId: string;
    txHash: Hex;
    rawTransaction: Hex;
    client: ReturnType<typeof paymentPublicClient>;
  },
): Promise<void> {
  try {
    const sentHash = await input.client.sendRawTransaction({
      serializedTransaction: input.rawTransaction,
    });
    if (sentHash.toLowerCase() !== input.txHash.toLowerCase()) {
      throw new Error("CCTP RPC returned a different transaction hash");
    }
    await recordCrosschainMintBroadcast(env, input.opId, input.txHash);
  } catch (error) {
    try {
      await input.client.getTransaction({ hash: input.txHash });
      await recordCrosschainMintBroadcast(env, input.opId, input.txHash);
      await recordCrosschainMintResult(env, input.opId, input.txHash, "pending");
      return;
    } catch {
      throw error;
    }
  }
}

export async function mintCctpSettlement(env: Bindings, opId: string): Promise<boolean> {
  let operation = await getCrosschainOperation(env, opId);
  if (operation.status === "settled") {
    return true;
  }
  if (
    !operation.message ||
    !operation.attestation ||
    !isHex(operation.message, { strict: true }) ||
    !isHex(operation.attestation, { strict: true })
  ) {
    return false;
  }
  const attempt = await getAttempt(env, operation.attemptId);
  const intent = attempt ? await getPaymentIntent(env, attempt.intentId) : null;
  const source = getPaymentNetworkCapabilities(operation.sourceChainId);
  const cctp = CCTP_CHAINS[operation.destinationChainId];
  if (!attempt || !intent || !source || !cctp) {
    throw new Error("CCTP destination configuration is incomplete");
  }
  if (
    !operation.platformFeeAtomic ||
    operation.networkFeeAtomic === null ||
    !operation.mintedAmountAtomic
  ) {
    throw new Error("CCTP fee or minted-amount evidence is incomplete");
  }
  const nonce = cctpMessageNonce(operation.message as Hex);
  if (operation.messageNonce && operation.messageNonce.toLowerCase() !== nonce.toLowerCase()) {
    throw new Error("Stored CCTP nonce does not match the attested message");
  }
  const publicClient = paymentPublicClient(env, operation.destinationChainId);
  if (await nonceWasUsed(publicClient, cctp.messageTransmitter, nonce)) {
    const recovered = await recoverMintTransactionHash(env, {
      client: publicClient,
      chainId: operation.destinationChainId,
      messageTransmitter: cctp.messageTransmitter,
      nonce,
      sourceDomain: source.cctpDomain,
      storedHash: operation.destinationTxHash,
    });
    if (!recovered) {
      return false;
    }
    await recordCrosschainMintResult(env, operation.opId, recovered, "success");
    await finalizeCctpSettlement(env, { operation, attempt, destinationTxHash: recovered });
    return true;
  }

  if (
    operation.destinationTxHash &&
    operation.mintRawTransaction &&
    isHex(operation.destinationTxHash, { strict: true }) &&
    isHex(operation.mintRawTransaction, { strict: true })
  ) {
    const hash = operation.destinationTxHash as Hex;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        await clearRevertedCrosschainMint(env, operation.opId, hash);
        return false;
      }
      await recordCrosschainMintResult(env, operation.opId, hash, "pending");
      return false;
    } catch {
      await broadcastPreparedMint(env, {
        opId: operation.opId,
        txHash: hash,
        rawTransaction: operation.mintRawTransaction as Hex,
        client: publicClient,
      });
      return false;
    }
  }
  if (operation.attemptCount >= MAX_CCTP_MINT_ATTEMPTS) {
    await updateCrosschainOperation(env, operation.opId, {
      status: "needs_support",
      lastErrorCode: "CCTP_MINT_ATTEMPTS_EXHAUSTED",
    });
    return true;
  }

  const walletClient = paymentWalletClient(env, operation.destinationChainId);
  const account = walletClient.account;
  if (!account) {
    throw new Error("CCTP relayer account is unavailable");
  }
  try {
    await withPaymentSignerLease(
      env,
      { chainId: operation.destinationChainId, signerAddress: account.address },
      async () => {
        operation = await getCrosschainOperation(env, operation.opId);
        if (operation.destinationTxHash) {
          return;
        }
        if (await nonceWasUsed(publicClient, cctp.messageTransmitter, nonce)) {
          return;
        }
        await publicClient.simulateContract({
          account,
          address: cctp.messageTransmitter,
          abi: messageTransmitterAbi,
          functionName: "receiveMessage",
          args: [operation.message as Hex, operation.attestation as Hex],
        });
        const data = encodeFunctionData({
          abi: messageTransmitterAbi,
          functionName: "receiveMessage",
          args: [operation.message as Hex, operation.attestation as Hex],
        });
        const request = await walletClient.prepareTransactionRequest({
          account,
          to: cctp.messageTransmitter,
          data,
        });
        if (request.nonce === undefined) {
          throw new Error("Prepared CCTP mint is missing a signer nonce");
        }
        const rawTransaction = await walletClient.signTransaction(request);
        const txHash = keccak256(rawTransaction);
        const inserted = await recordCrosschainMintPrepared(env, {
          opId: operation.opId,
          txHash,
          rawTransaction,
          signerAddress: account.address,
          nonce: request.nonce,
        });
        if (!inserted) {
          return;
        }
        await broadcastPreparedMint(env, {
          opId: operation.opId,
          txHash,
          rawTransaction,
          client: publicClient,
        });
      },
    );
  } catch (error) {
    if (error instanceof PaymentSignerLeaseBusyError) {
      return false;
    }
    if (await nonceWasUsed(publicClient, cctp.messageTransmitter, nonce)) {
      return false;
    }
    throw error;
  }
  return false;
}

export async function scanPaymentRouters(env: Bindings, chainId: number): Promise<boolean> {
  const client = paymentPublicClient(env, chainId);
  const current = await client.getBlockNumber();
  const confirmedTip = current - BigInt(requiredConfirmations(env, chainId) - 1);
  const storedCheckpoint = await getRouterCheckpoint(env, chainId);
  const checkpoint = await verifyRouterCheckpoint(env, chainId, client, storedCheckpoint ?? null);
  const activeRouterAddresses = await listActiveRouterAddressesByChain(env, chainId);
  if (activeRouterAddresses.length === 0) {
    return true;
  }
  const fromBlock = checkpoint
    ? BigInt(checkpoint.block_number + 1)
    : confirmedTip > 2_000n
      ? confirmedTip - 2_000n
      : 0n;
  if (fromBlock > confirmedTip) {
    return false;
  }
  const toBlock = fromBlock + 1_999n < confirmedTip ? fromBlock + 1_999n : confirmedTip;
  const addresses = activeRouterAddresses.map((address) => getAddress(address)) as Address[];
  const logs = await client.getLogs({ address: addresses, fromBlock, toBlock });
  for (const log of logs) {
    const local = eventArgs(log, paymentRouterAbi, "PaymentSettled");
    const burn = local ? null : eventArgs(log, cctpPaymentRouterAbi, "CctpPaymentBurned");
    const hash = String(local?.attemptId ?? burn?.attemptId ?? "");
    if (log.transactionHash && log.logIndex !== null) {
      await upsertPaymentChainEvent(env, {
        chainId,
        txHash: log.transactionHash.toLowerCase(),
        logIndex: log.logIndex,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        eventName: local ? "PaymentSettled" : "CctpPaymentBurned",
        intentHash: String(local?.intentId ?? burn?.intentId ?? "") || null,
        attemptHash: hash || null,
        payloadJson: jsonEvidence(local ?? burn ?? {}),
      });
    }
    const attempt = hash ? await getAttemptByHash(env, hash) : null;
    if (!attempt || !log.transactionHash) {
      continue;
    }
    await markAttemptProcessing(env, attempt.id, log.transactionHash);
    await reconcileAttempt(env, attempt.id);
  }
  const block = await client.getBlock({ blockNumber: toBlock });
  await commitRouterCheckpoint(env, {
    chainId,
    blockNumber: Number(toBlock),
    blockHash: block.hash,
    parentHash: block.parentHash,
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
  });
  logInfo("payment_router_scan_completed", {
    chainId,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    logs: logs.length,
  });
  // A completed scan should release its Queue lease even while signed but
  // unbroadcast reservations exist. The scheduler enqueues one bounded scan per
  // active chain on the next tick, while attempt_reconcile owns receipt retries.
  return toBlock >= confirmedTip;
}
