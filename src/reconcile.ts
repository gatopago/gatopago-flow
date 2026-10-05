import { getAddress, parseEventLogs, type Hex, type Log } from "viem";
import { crosschainStatus } from "@gatopago/shared/crosschain";
import { paymentRouterAbi } from "@gatopago/shared/payments";
import type { Config, Network } from "./config";
import { markSucceeded, presentIntent, type IntentRow } from "./intents";
import { recordEvent } from "./webhooks";

/** Blocks read per `eth_getLogs` (public RPCs cap the range, Monad's at 100). */
const RANGE = 100n;

/**
 * Applies the router's `PaymentSent` events in `logs`. A payment on the home network settles the
 * intent; one that crosses networks leaves it `processing` until Circle mints to the merchant.
 */
export async function applyPayments(env: Env, config: Config, network: Network, logs: Log[]) {
  const events = parseEventLogs({ abi: paymentRouterAbi, eventName: "PaymentSent", logs });
  for (const { args, transactionHash } of events) {
    const intent = await env.FLOW_DB.prepare(
      `SELECT payment_intents.*, merchants.address AS merchant_address FROM payment_intents
       JOIN merchants ON merchants.id = payment_intents.merchant_id WHERE onchain_id = ?`,
    )
      .bind(args.intentId)
      .first<IntentRow & { merchant_address: string }>();
    // Flow only authorizes its own intents, merchant and amount: anything else is not ours.
    if (
      !intent ||
      getAddress(intent.merchant_address) !== args.merchant ||
      BigInt(intent.amount) !== args.amount ||
      args.destinationDomain !== config.home.cctp.domain
    ) {
      continue;
    }
    const payment = { network: network.id, transactionHash, payer: args.payer };
    if (intent.status === "succeeded" || intent.status === "processing") {
      if (intent.transaction_hash !== transactionHash) {
        await env.FLOW_DB.batch(
          recordEvent(env, intent.merchant_id, "payment_intent.duplicate_payment", {
            payment_intent: intent.id,
            ...payment,
          }),
        );
      }
    } else if (network.id === config.home.id) {
      await markSucceeded(env, config, intent.id, payment);
    } else {
      const row = await env.FLOW_DB.prepare(
        `UPDATE payment_intents SET status = 'processing', network = ?, transaction_hash = ?, payer = ?
         WHERE id = ? AND status NOT IN ('processing', 'succeeded') RETURNING *`,
      )
        .bind(network.id, transactionHash, args.payer, intent.id)
        .first<IntentRow>();
      if (row) {
        await env.FLOW_DB.batch(
          recordEvent(
            env,
            row.merchant_id,
            "payment_intent.processing",
            presentIntent(row, config),
          ),
        );
      }
    }
  }
}

/** Reads each network's router events since the last block read, up to the latest one. */
export async function scanNetworks(env: Env, config: Config): Promise<void> {
  for (const network of config.networks.values()) {
    const latest = await network.client.getBlockNumber();
    const cursor = await env.FLOW_DB.prepare("SELECT block FROM chain_cursors WHERE network = ?")
      .bind(network.id)
      .first<number>("block");
    let from = cursor === null ? latest : BigInt(cursor) + 1n;
    for (let rounds = 0; from <= latest && rounds < 20; rounds++) {
      const to = from + RANGE - 1n < latest ? from + RANGE - 1n : latest;
      const logs = await network.client.getLogs({
        address: network.paymentRouter,
        event: paymentRouterAbi.find((item) => item.type === "event")!,
        fromBlock: from,
        toBlock: to,
      });
      await applyPayments(env, config, network, logs);
      await env.FLOW_DB.prepare(
        `INSERT INTO chain_cursors (network, block) VALUES (?, ?)
         ON CONFLICT (network) DO UPDATE SET block = excluded.block`,
      )
        .bind(network.id, Number(to))
        .run();
      from = to + 1n;
    }
  }
}

/**
 * Settles crossing payments once Circle's Forwarding Service minted to the merchant on the home
 * network (`forwardState: COMPLETE`, its mint transaction confirmed there).
 */
export async function completeCrossings(env: Env, config: Config): Promise<void> {
  const { results } = await env.FLOW_DB.prepare(
    "SELECT * FROM payment_intents WHERE status = 'processing' LIMIT 50",
  ).all<IntentRow>();
  for (const intent of results) {
    const network = config.networks.get(intent.network!);
    if (!network) {
      continue;
    }
    const status = await crosschainStatus(
      network,
      intent.transaction_hash as Hex,
      AbortSignal.timeout(10_000),
    ).catch(() => null);
    if (status?.stage !== "delivered" || !status.forwardTxHash) {
      continue;
    }
    const mint = await config.home.client
      .getTransactionReceipt({ hash: status.forwardTxHash })
      .catch(() => null);
    if (mint?.status === "success") {
      await markSucceeded(env, config, intent.id, {
        network: intent.network!,
        transactionHash: intent.transaction_hash,
        payer: intent.payer,
      });
    }
  }
}
