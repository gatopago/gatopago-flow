import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import {
  depositAbi,
  depositContracts,
  depositFactoryAbi,
  depositSalt,
  type DepositSettlement,
} from '@gatopago/shared/deposits';
import type { Budget } from './budget';
import type { Config, Network } from './config';
import { currency, decimalsOf } from './currencies';
import { presentIntent, markSucceeded, transition, type IntentRow } from './intents';
import { now } from './http';
import { recordEvent } from './webhooks';

/** How long after an intent expires its deposit is still watched. */
const WATCH_AFTER_EXPIRY = 7 * 86_400;

/**
 * Intents paid to their deposit addresses, and the sweeps that deliver them to the merchant. Every
 * deposit of the 500 newest intents (until 7 days after they expire) is read with one multicall per
 * network:
 * - **Its amount arrived:** the intent is `processing` and the deposit is swept. It succeeds with the
 *   sweep's hash once that is confirmed or, when the sweep crosses networks with CCTP, once Circle
 *   mints to the merchant (`completeCrossings`).
 * - **Less than its amount:** `amount_received` and `payment_intent.partially_paid`; it waits for the
 *   rest. If the intent ends unpaid (expired or canceled), what arrived is swept to the merchant
 *   anyway, with `payment_intent.underpaid`.
 * - **More, after it was paid:** swept too, with `payment_intent.duplicate_payment`.
 *
 * Anyone may sweep a deposit, and only toward its settlement: a sweep someone else sent still pays
 * the merchant. Each network reads with an even part of the requests, and one whose RPC fails waits
 * for the next run without holding back the others.
 */
export async function collectDeposits(env: Env, config: Config, budget: Budget): Promise<void> {
  const { results } = await env.FLOW_DB.prepare(
    `SELECT * FROM payment_intents WHERE deposit_address IS NOT NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(now() - WATCH_AFTER_EXPIRY)
    .all<IntentRow>();
  const networks = [...config.networks.values()];
  for (const [i, network] of networks.entries()) {
    await collectOn(env, config, network, results, budget.share(networks.length - i)).catch(
      (error: unknown) => {
        console.error(error);
      },
    );
  }
}

/** A deposit to sweep: the payment it delivers, what arrived after payment, or a partial payment. */
interface Sweep {
  intent: IntentRow;
  token: Address;
  balance: bigint;
  kind: 'payment' | 'duplicate' | 'underpaid';
}

async function collectOn(
  env: Env,
  config: Config,
  network: Network,
  intents: IntentRow[],
  budget: Budget,
) {
  const watched = intents.flatMap((intent) => {
    const token = currency(config, intent.currency)?.tokens.get(network.id);
    return token ? [{ intent, token, deposit: getAddress(intent.deposit_address!) }] : [];
  });
  if (watched.length === 0 || !budget.take()) {
    return;
  }
  const balances = await network.client.multicall({
    allowFailure: false,
    // One request for every deposit (each call is about 100 bytes).
    batchSize: 0,
    contracts: watched.map(
      ({ token, deposit }) =>
        ({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [deposit] }) as const,
    ),
  });

  const sweeps: Sweep[] = [];
  for (const [i, { intent, token }] of watched.entries()) {
    const balance = balances[i];
    // A deposit payment on its way to the merchant (router payments always have a payer).
    if (intent.status === 'processing' && intent.payer === null) {
      if (
        intent.network === network.id &&
        (await followSweep(env, config, network, intent, balance, budget)) === 'sweep'
      ) {
        sweeps.push({ intent, token, balance, kind: 'payment' });
      }
      continue;
    }
    if (balance === 0n) {
      continue;
    }
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      sweeps.push({ intent, token, balance, kind: 'duplicate' });
    } else if (balance >= BigInt(intent.amount)) {
      const paying = await transition(
        env,
        config,
        intent,
        {
          status: 'processing',
          network: network.id,
          amount_received: balance.toString(),
          transaction_hash: null,
          payer: null,
        },
        'payment_intent.processing',
      );
      if (paying) {
        sweeps.push({ intent: paying, token, balance, kind: 'payment' });
      }
    } else if (intent.status === 'requires_payment') {
      if (intent.amount_received !== balance.toString()) {
        await partiallyPaid(env, config, intent, network, balance);
      }
    } else {
      // Ended unpaid with part of its amount: it reaches the merchant anyway.
      sweeps.push({ intent, token, balance, kind: 'underpaid' });
    }
  }
  if (sweeps.length === 0 || !budget.take()) {
    return;
  }
  // One after another from the next free nonce. A sweep that cannot be prepared (its gas estimate
  // reverts) is skipped and keeps the nonce for the next one; one that fails to be sent ends this
  // network's turn, and the next run reads the nonce again.
  let nonce = await network.client.getTransactionCount({
    address: network.sweeper.account.address,
    blockTag: 'pending',
  });
  for (const sweep of sweeps) {
    // Up to four to prepare it (viem tries `eth_fillTransaction`, which public RPCs refuse, then
    // reads the block, the tip and the gas) and one to send it.
    if (!budget.take(5)) {
      return;
    }
    const request = await network.sweeper
      .prepareTransactionRequest({
        to: depositContracts.factory,
        data: encodeFunctionData({
          abi: depositFactoryAbi,
          functionName: 'sweep',
          args: [depositSalt(sweep.intent.id), settlementOf(sweep.intent), sweep.token],
        }),
        nonce,
      })
      .catch((error: unknown) => {
        console.error(`Sweep of ${sweep.intent.id} on ${network.id}`, error);
        return null;
      });
    if (!request) {
      continue;
    }
    const hash = await network.sweeper.sendTransaction(request);
    nonce++;
    await recordSweep(env, network, sweep, hash);
  }
}

/**
 * Where the sweep of a deposit payment stands. Confirmed on this network: the intent succeeds with
 * its hash. Confirmed and crossing: `completeCrossings` settles it once Circle mints. Still pending:
 * it waits. Reverted, lost or never sent: it is sent again while the deposit holds funds; if the
 * deposit is already empty, someone else swept it, and a deposit only pays its settlement.
 */
async function followSweep(
  env: Env,
  config: Config,
  network: Network,
  intent: IntentRow,
  balance: bigint,
  budget: Budget,
): Promise<'sweep' | 'wait'> {
  const hash = intent.transaction_hash as Hex | null;
  if (hash) {
    if (!budget.take()) {
      return 'wait';
    }
    const receipt = await network.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) {
        return null;
      }
      throw error;
    });
    if (receipt?.status === 'success') {
      const deposit = getAddress(intent.deposit_address!);
      const [swept] = parseEventLogs({
        abi: depositAbi,
        eventName: 'Swept',
        logs: receipt.logs.filter((log) => isAddressEqual(log.address, deposit)),
      });
      if (!swept?.args.crossed) {
        await markSucceeded(env, config, intent.id, {
          network: network.id,
          transactionHash: hash,
          payer: null,
        });
      }
      return 'wait';
    }
    if (!receipt) {
      if (!budget.take()) {
        return 'wait';
      }
      const pending = await network.client.getTransaction({ hash }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof TransactionNotFoundError) {
            return false;
          }
          throw error;
        },
      );
      if (pending) {
        return 'wait';
      }
    }
  }
  if (balance > 0n) {
    return 'sweep';
  }
  await markSucceeded(env, config, intent.id, {
    network: network.id,
    transactionHash: null,
    payer: null,
  });
  return 'wait';
}

/** Less than the amount arrived, or more of it: recorded with `payment_intent.partially_paid`. */
async function partiallyPaid(
  env: Env,
  config: Config,
  intent: IntentRow,
  network: Network,
  balance: bigint,
) {
  const next = { ...intent, amount_received: balance.toString() };
  await env.FLOW_DB.batch([
    env.FLOW_DB.prepare(
      `UPDATE payment_intents SET amount_received = ?
       WHERE id = ? AND status = 'requires_payment' AND amount_received IS ?`,
    ).bind(next.amount_received, intent.id, intent.amount_received),
    ...recordEvent(
      env,
      intent.merchant_id,
      'payment_intent.partially_paid',
      { ...presentIntent(next, config), network: network.id },
      true,
    ),
  ]);
}

/** Keeps the sweep's hash on a paying intent, or tells the merchant what else it delivered. */
async function recordSweep(env: Env, network: Network, sweep: Sweep, hash: Hex) {
  const { intent } = sweep;
  if (sweep.kind === 'payment') {
    await env.FLOW_DB.prepare(
      `UPDATE payment_intents SET transaction_hash = ? WHERE id = ? AND status = 'processing'`,
    )
      .bind(hash, intent.id)
      .run();
    return;
  }
  const delivery = {
    payment_intent: intent.id,
    network: network.id,
    transaction_hash: hash,
    amount: formatUnits(sweep.balance, decimalsOf(intent.currency)),
  };
  if (sweep.kind === 'duplicate') {
    await env.FLOW_DB.batch(
      recordEvent(env, intent.merchant_id, 'payment_intent.duplicate_payment', delivery),
    );
    return;
  }
  // Underpaid: told once, however many sweeps it takes.
  await env.FLOW_DB.batch([
    env.FLOW_DB.prepare(
      `UPDATE payment_intents SET amount_received = ?, underpaid_at = ?
       WHERE id = ? AND underpaid_at IS NULL`,
    ).bind(sweep.balance.toString(), now(), intent.id),
    ...recordEvent(env, intent.merchant_id, 'payment_intent.underpaid', delivery, true),
  ]);
}

const settlementOf = (intent: IntentRow): DepositSettlement => {
  const { maxFee, ...settlement } = JSON.parse(intent.deposit_settlement!) as Omit<
    DepositSettlement,
    'maxFee'
  > & { maxFee: string };
  return { ...settlement, maxFee: BigInt(maxFee) };
};
