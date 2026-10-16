import { formatUnits, isAddress, isHash, type Address, type Hex } from 'viem';
import { crosschainFee } from '@gatopago/shared/crosschain';
import { paymentTotal, paymentTypedData, type Payment } from '@gatopago/shared/payments';
import type { Config } from './config';
import { HttpError, json, now, rateLimit, readJson } from './http';
import { intentRow, presentIntent } from './intents';
import { applyPayments } from './reconcile';

/** An authorization is valid for 5 minutes (and never past the intent's expiry). */
const AUTHORIZATION_SECONDS = 300;
/** A block's time may run a little behind ours: a network stays authorized this much longer. */
const CLOCK_SECONDS = 60;

/** `GET /checkout/v1/:id`: what the payer sees. Public: the id is the capability. */
export async function readCheckout(env: Env, config: Config, id: string): Promise<Response> {
  const row = await intentRow(env, id);
  const merchant = await env.FLOW_DB.prepare('SELECT name, address FROM merchants WHERE id = ?')
    .bind(row.merchant_id)
    .first<{ name: string | null; address: Address }>();
  return json({
    ...presentIntent(row, config),
    // The merchant's own references are not the payer's business.
    metadata: undefined,
    merchant,
    home_network: config.home.id,
    networks: [...config.networks.keys()],
    // What the payer adds to the amount: GatoPago's fee (crossing networks adds Circle's).
    fee: formatUnits((BigInt(row.amount) * config.platformFeeBps) / 10_000n, 6),
  });
}

/**
 * `POST /checkout/v1/:id/authorize` `{ payer, network }`: Flow's signed authorization for the
 * router on `network`. The merchant always receives on the home network; paying from another one
 * crosses with CCTP, whose fee ceiling the payer covers. One network at a time: each network's
 * router only knows its own payments, so while an authorization can still be used, the same network
 * is authorized again and another one is refused (`AUTHORIZED_ON_OTHER_NETWORK`).
 */
export async function authorize(request: Request, env: Env, config: Config, id: string) {
  await rateLimit(
    env.RATE_LIMITER,
    `authorize:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  );
  const body = await readJson<{ payer?: unknown; network?: unknown }>(request);
  const network = config.networks.get(String(body.network));
  if (!network || typeof body.payer !== 'string' || !isAddress(body.payer)) {
    throw new HttpError(400, 'INVALID_REQUEST');
  }
  const row = await intentRow(env, id);
  if (row.status !== 'requires_payment' || row.expires_at <= now()) {
    throw new HttpError(409, 'INTENT_NOT_PAYABLE');
  }
  const merchant = await env.FLOW_DB.prepare('SELECT address FROM merchants WHERE id = ?')
    .bind(row.merchant_id)
    .first<Address>('address');
  const amount = BigInt(row.amount);
  const crossing = network.id !== config.home.id;
  const payment: Payment = {
    intentId: row.onchain_id as Hex,
    payer: body.payer,
    merchant: merchant!,
    amount,
    fee: (amount * config.platformFeeBps) / 10_000n,
    destinationDomain: config.home.cctp.domain,
    maxCctpFee: crossing ? await crosschainFee(network, config.home, amount) : 0n,
    minFinalityThreshold: network.cctp.fast ? 1000 : 2000,
    validUntil: Math.min(now() + AUTHORIZATION_SECONDS, row.expires_at),
  };
  // In one statement, so two requests at once cannot authorize two networks.
  const authorized = await env.FLOW_DB.prepare(
    `UPDATE payment_intents SET authorized_network = ?1, authorized_until = ?2
     WHERE id = ?3 AND (authorized_network IS NULL OR authorized_network = ?1 OR authorized_until < ?4)`,
  )
    .bind(network.id, payment.validUntil + CLOCK_SECONDS, row.id, now())
    .run();
  if (authorized.meta.changes === 0) {
    throw new HttpError(409, 'AUTHORIZED_ON_OTHER_NETWORK');
  }
  const signature = await config.signer.signTypedData(paymentTypedData(network, payment));
  return json({
    network: network.id,
    router: network.paymentRouter,
    usdc: network.usdc,
    total: formatUnits(paymentTotal(network, payment), 6),
    payment: {
      ...payment,
      amount: payment.amount.toString(),
      fee: payment.fee.toString(),
      maxCctpFee: payment.maxCctpFee.toString(),
    },
    signature,
  });
}

/**
 * `POST /checkout/v1/:id/confirm` `{ network, transaction_hash }`: applies the payment as soon as the
 * payer has the transaction, instead of waiting for the next scan.
 */
export async function confirm(request: Request, env: Env, config: Config, id: string) {
  await rateLimit(
    env.RATE_LIMITER,
    `confirm:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  );
  const body = await readJson<{ network?: unknown; transaction_hash?: unknown }>(request);
  const network = config.networks.get(String(body.network));
  if (!network || typeof body.transaction_hash !== 'string' || !isHash(body.transaction_hash)) {
    throw new HttpError(400, 'INVALID_REQUEST');
  }
  const receipt = await network.client
    .getTransactionReceipt({ hash: body.transaction_hash })
    .catch(() => null);
  if (receipt?.status === 'success') {
    await applyPayments(
      env,
      config,
      network,
      receipt.logs.filter(
        (log) => log.address.toLowerCase() === network.paymentRouter.toLowerCase(),
      ),
    );
  }
  return json(presentIntent(await intentRow(env, id), config));
}
