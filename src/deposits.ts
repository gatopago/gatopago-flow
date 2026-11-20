import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import {
  depositContracts,
  depositFactoryAbi,
  depositSalt,
  type DepositSettlement,
} from '@gatopago/shared/deposits';
import type { Budget } from './budget';
import type { Config, Network } from './config';
import { currency } from './currencies';
import { markSucceeded, type IntentRow } from './intents';
import { now } from './http';

/** How long after an intent expires its deposit is still watched. */
const WATCH_AFTER_EXPIRY = 7 * 86_400;

/**
 * Pays intents from their deposit addresses, and sweeps the deposits. An intent succeeds as soon as
 * its deposit holds its amount on some network: from there the funds can only go to the merchant.
 * Then any deposit holding funds of a paid intent is swept (the payment, or one made twice), whoever
 * sent them and however. The 500 newest intents are watched. Each network reads with an even part
 * of the requests, and one whose RPC fails waits for the next run without holding back the others.
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
  const due: { intent: IntentRow; token: Address }[] = [];
  for (const [i, { intent, token }] of watched.entries()) {
    const balance = balances[i];
    const paid = intent.status === 'succeeded' || intent.status === 'processing';
    if (!paid && balance >= BigInt(intent.amount)) {
      await markSucceeded(env, config, intent.id, {
        network: network.id,
        transactionHash: null,
        payer: null,
      });
      due.push({ intent, token });
    } else if (paid && balance > 0n) {
      due.push({ intent, token });
    }
    // Less than its amount for an intent still unpaid: it waits for the rest.
  }
  if (due.length === 0 || !budget.take()) {
    return;
  }
  // One after another from the next free nonce. A sweep that cannot be prepared (its gas estimate
  // reverts) is skipped and keeps the nonce for the next one; one that fails to be sent ends this
  // network's turn, and the next run reads the nonce again.
  let nonce = await network.client.getTransactionCount({
    address: network.sweeper.account.address,
    blockTag: 'pending',
  });
  for (const { intent, token } of due) {
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
          args: [depositSalt(intent.id), settlementOf(intent), token],
        }),
        nonce,
      })
      .catch((error: unknown) => {
        console.error(`Sweep of ${intent.id} on ${network.id}`, error);
        return null;
      });
    if (!request) {
      continue;
    }
    await network.sweeper.sendTransaction(request);
    nonce++;
  }
}

const settlementOf = (intent: IntentRow): DepositSettlement => {
  const { maxFee, ...settlement } = JSON.parse(intent.deposit_settlement!) as Omit<
    DepositSettlement,
    'maxFee'
  > & { maxFee: string };
  return { ...settlement, maxFee: BigInt(maxFee) };
};
