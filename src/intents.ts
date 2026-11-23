import { formatUnits, keccak256, parseUnits, toHex } from 'viem';
import {
  depositAddress,
  depositMaxFee,
  depositSalt,
  type DepositSettlement,
} from '@gatopago/shared/deposits';
import type { Merchant } from './auth';
import type { Config } from './config';
import { currency, decimalsOf } from './currencies';
import { HttpError, json, newId, now, readJson } from './http';
import { recordEvent } from './webhooks';

export interface IntentRow {
  id: string;
  onchain_id: string;
  merchant_id: string;
  /** Atomic units of `currency` the merchant receives. */
  amount: string;
  currency: string;
  description: string | null;
  metadata: string | null;
  status: 'requires_payment' | 'processing' | 'succeeded' | 'canceled' | 'expired';
  expires_at: number;
  created_at: number;
  network: string | null;
  transaction_hash: string | null;
  payer: string | null;
  paid_at: number | null;
  /** Where anyone can pay it with a plain transfer (`CascabelDeposit`). */
  deposit_address: string | null;
  /** The `DepositSettlement` the address commits to, as JSON (`maxFee` as a string). */
  deposit_settlement: string | null;
  /** What has reached the deposit, in atomic units of `currency` (less than `amount`: partial). */
  amount_received: string | null;
  /** When what arrived was swept to the merchant although the intent ended unpaid. */
  underpaid_at: number | null;
}

const DAY = 86_400;

export function presentIntent(row: IntentRow, config: Config) {
  return {
    id: row.id,
    object: 'payment_intent',
    amount: formatUnits(BigInt(row.amount), decimalsOf(row.currency)),
    currency: row.currency,
    status: row.status,
    description: row.description,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    checkout_url: `${config.webOrigin}/pay/${row.id}`,
    deposit_address: row.deposit_address,
    amount_received:
      row.amount_received === null
        ? null
        : formatUnits(BigInt(row.amount_received), decimalsOf(row.currency)),
    expires_at: row.expires_at,
    created_at: row.created_at,
    livemode: !config.testnet,
    payment: row.network
      ? {
          network: row.network,
          transaction_hash: row.transaction_hash,
          payer: row.payer,
          paid_at: row.paid_at,
        }
      : null,
  };
}

export async function intentRow(env: Env, id: string, merchantId?: string): Promise<IntentRow> {
  const row = await env.FLOW_DB.prepare('SELECT * FROM payment_intents WHERE id = ?')
    .bind(id)
    .first<IntentRow>();
  if (!row || (merchantId && row.merchant_id !== merchantId)) {
    throw new HttpError(404, 'NOT_FOUND');
  }
  return row;
}

/**
 * Moves `row` from the status it was read in, applying `changes`, and records `type` in the same
 * transaction. Null when another request moved it first: then neither happens.
 */
export async function transition(
  env: Env,
  config: Config,
  row: IntentRow,
  changes: Partial<IntentRow>,
  type: string,
): Promise<IntentRow | null> {
  const next = { ...row, ...changes };
  const columns = Object.keys(changes) as (keyof IntentRow)[];
  const [update] = await env.FLOW_DB.batch([
    env.FLOW_DB.prepare(
      `UPDATE payment_intents SET ${columns.map((column) => `${column} = ?`).join(', ')}
       WHERE id = ? AND status = ?`,
    ).bind(...columns.map((column) => next[column]), row.id, row.status),
    ...recordEvent(env, row.merchant_id, type, presentIntent(next, config), true),
  ]);
  return update.meta.changes === 1 ? next : null;
}

/**
 * `POST /v1/payment_intents` `{ amount: "18.00", currency?: "USDC" | "AUSD", description?, metadata?,
 * expires_in? }`. USDC by default. A repeated `Idempotency-Key` returns the intent the first request
 * created.
 */
export async function createIntent(
  request: Request,
  env: Env,
  config: Config,
  merchant: Merchant,
): Promise<Response> {
  const body = await readJson<{
    amount?: unknown;
    currency?: unknown;
    description?: unknown;
    metadata?: unknown;
    expires_in?: unknown;
  }>(request);
  const coin = currency(config, typeof body.currency === 'string' ? body.currency : 'USDC');
  if (!coin || (body.currency !== undefined && typeof body.currency !== 'string')) {
    throw new HttpError(400, 'INVALID_CURRENCY');
  }
  if (
    typeof body.amount !== 'string' ||
    !new RegExp(`^\\d{1,7}(\\.\\d{1,${coin.decimals}})?$`).test(body.amount)
  ) {
    throw new HttpError(400, 'INVALID_AMOUNT');
  }
  const amount = parseUnits(body.amount, coin.decimals);
  if (amount <= 0n) {
    throw new HttpError(400, 'INVALID_AMOUNT');
  }
  if (
    body.description !== undefined &&
    (typeof body.description !== 'string' || body.description.length > 200)
  ) {
    throw new HttpError(400, 'INVALID_DESCRIPTION');
  }
  const metadata = body.metadata ?? {};
  if (
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length > 20 ||
    Object.values(metadata).some((value) => typeof value !== 'string' || value.length > 500)
  ) {
    throw new HttpError(400, 'INVALID_METADATA');
  }
  const expiresIn = body.expires_in ?? DAY;
  if (
    typeof expiresIn !== 'number' ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 300 ||
    expiresIn > 7 * DAY
  ) {
    throw new HttpError(400, 'INVALID_EXPIRES_IN');
  }
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey !== null && !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY');
  }

  // Its deposit settles where the merchant receives: USDC on the home network (crossing there with
  // CCTP when paid on another one), any other coin on the network it is paid on. The crossing fee is
  // fixed in the address, so it takes the highest quote among the networks it can be paid from.
  const sources = [...config.networks.values()].filter((network) => network.id !== config.home.id);
  const fees = await Promise.all(
    sources.map((from) => depositMaxFee(from, config.home, amount, AbortSignal.timeout(10_000))),
  ).catch(() => {
    throw new HttpError(503, 'CCTP_FEE_UNAVAILABLE');
  });
  const settlement: DepositSettlement = {
    recipient: merchant.address,
    destinationDomain: config.home.cctp.domain,
    maxFee: fees.reduce((highest, fee) => (fee > highest ? fee : highest), 0n),
    localRecipient: merchant.address,
  };

  const createdAt = now();
  const id = newId('pi');
  const row: IntentRow = {
    id,
    onchain_id: '',
    merchant_id: merchant.id,
    amount: amount.toString(),
    currency: coin.symbol,
    description: (body.description as string | undefined) ?? null,
    metadata: JSON.stringify(metadata),
    status: 'requires_payment',
    expires_at: createdAt + expiresIn,
    created_at: createdAt,
    network: null,
    transaction_hash: null,
    payer: null,
    paid_at: null,
    deposit_address: depositAddress(depositSalt(id), settlement),
    deposit_settlement: JSON.stringify({ ...settlement, maxFee: settlement.maxFee.toString() }),
    amount_received: null,
    underpaid_at: null,
  };
  row.onchain_id = keccak256(toHex(row.id));
  const [insert] = await env.FLOW_DB.batch([
    env.FLOW_DB.prepare(
      `INSERT INTO payment_intents (id, onchain_id, merchant_id, amount, currency, description,
         metadata, status, expires_at, created_at, idempotency_key, deposit_address,
         deposit_settlement)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requires_payment', ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, idempotency_key) DO NOTHING`,
    ).bind(
      row.id,
      row.onchain_id,
      merchant.id,
      row.amount,
      row.currency,
      row.description,
      row.metadata,
      row.expires_at,
      createdAt,
      idempotencyKey,
      row.deposit_address,
      row.deposit_settlement,
    ),
    ...recordEvent(env, merchant.id, 'payment_intent.created', presentIntent(row, config), true),
  ]);
  if (insert.meta.changes === 1) {
    return json(presentIntent(row, config), 201);
  }
  // The key was used before: the same request gets the same intent, a different one is refused.
  const existing = (await env.FLOW_DB.prepare(
    'SELECT * FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ?',
  )
    .bind(merchant.id, idempotencyKey)
    .first<IntentRow>())!;
  if (
    existing.amount !== row.amount ||
    existing.currency !== row.currency ||
    existing.description !== row.description ||
    existing.metadata !== row.metadata ||
    existing.expires_at - existing.created_at !== expiresIn
  ) {
    throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
  }
  return json(presentIntent(existing, config));
}

/** `GET /v1/payment_intents` */
export async function listIntents(env: Env, config: Config, merchant: Merchant): Promise<Response> {
  const { results } = await env.FLOW_DB.prepare(
    'SELECT * FROM payment_intents WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(merchant.id)
    .all<IntentRow>();
  return json({ data: results.map((row) => presentIntent(row, config)) });
}

/** `GET /v1/payment_intents/:id` */
export async function readIntent(env: Env, config: Config, merchant: Merchant, id: string) {
  return json(presentIntent(await intentRow(env, id, merchant.id), config));
}

/** `POST /v1/payment_intents/:id/cancel`: only before it is paid. */
export async function cancelIntent(env: Env, config: Config, merchant: Merchant, id: string) {
  const current = await intentRow(env, id, merchant.id);
  const row =
    current.status === 'requires_payment' &&
    (await transition(env, config, current, { status: 'canceled' }, 'payment_intent.canceled'));
  if (!row) {
    throw new HttpError(409, 'INTENT_NOT_CANCELABLE');
  }
  return json(presentIntent(row, config));
}

/** `POST /v1/payment_intents/:id/simulate`: testnet only, marks it paid without a transaction. */
export async function simulatePayment(env: Env, config: Config, merchant: Merchant, id: string) {
  if (!config.testnet) {
    throw new HttpError(404, 'NOT_FOUND');
  }
  const intent = await intentRow(env, id, merchant.id);
  if (intent.status !== 'requires_payment') {
    throw new HttpError(409, 'INTENT_NOT_PAYABLE');
  }
  // Received where a real payment would be: the home network for USDC, the coin's own otherwise.
  const coin = currency(config, intent.currency);
  const row = await markSucceeded(env, config, id, {
    network: intent.currency === 'USDC' || !coin ? config.home.id : [...coin.tokens.keys()][0],
    transactionHash: null,
    payer: null,
  });
  return json(presentIntent(row!, config));
}

/**
 * Records who paid and emits `payment_intent.succeeded`; null when it already succeeded. Money that
 * arrives is recorded even after the intent expired or was canceled.
 */
export async function markSucceeded(
  env: Env,
  config: Config,
  id: string,
  payment: { network: string; transactionHash: string | null; payer: string | null },
): Promise<IntentRow | null> {
  for (;;) {
    const row = await intentRow(env, id);
    if (row.status === 'succeeded') {
      return null;
    }
    const next = await transition(
      env,
      config,
      row,
      {
        status: 'succeeded',
        network: payment.network,
        transaction_hash: payment.transactionHash,
        payer: payment.payer,
        paid_at: now(),
      },
      'payment_intent.succeeded',
    );
    // Moved meanwhile (processing, expired): read it again.
    if (next) {
      return next;
    }
  }
}

/** Intents nobody paid in time. */
export async function expireIntents(env: Env, config: Config): Promise<void> {
  const { results } = await env.FLOW_DB.prepare(
    "SELECT * FROM payment_intents WHERE status = 'requires_payment' AND expires_at <= ? LIMIT 100",
  )
    .bind(now())
    .all<IntentRow>();
  for (const row of results) {
    await transition(env, config, row, { status: 'expired' }, 'payment_intent.expired');
  }
}
