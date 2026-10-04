import { keccak256, toBytes, type Address } from "viem";
import type { SettlementAccountResult } from "@gatopago/shared/payment-contracts";
import type { Bindings } from "../env";
import type { Merchant } from "../domain/models";
import { first, nowIso } from "../stores/db";
import { type MerchantRow, MERCHANT_COLUMNS, mapMerchant } from "./rows";

function merchantIdForUser(userId: string): string {
  return `mrc_${keccak256(toBytes(userId)).slice(2, 34)}`;
}

export async function getMerchantByOwner(
  env: Bindings,
  ownerUserId: string,
): Promise<Merchant | null> {
  const row = await first<MerchantRow>(
    env,
    `SELECT ${MERCHANT_COLUMNS} FROM merchants WHERE owner_user_id = ? LIMIT 1`,
    [ownerUserId],
  );
  return row ? mapMerchant(row) : null;
}

export async function getMerchantById(env: Bindings, merchantId: string): Promise<Merchant | null> {
  const row = await first<MerchantRow>(
    env,
    `SELECT ${MERCHANT_COLUMNS} FROM merchants WHERE id = ? LIMIT 1`,
    [merchantId],
  );
  return row ? mapMerchant(row) : null;
}

export class SettlementAccountConflict extends Error {
  constructor() {
    super("Command ID was already used for a different settlement account command");
  }
}

type SettlementCommandRow = {
  merchant_id: string;
  owner_user_id: string;
  account_version: number;
  settlement_wallet: string;
  settlement_chain_id: number;
  applied: number;
};

export async function upsertSettlementAccount(
  env: Bindings,
  input: {
    commandId: string;
    ownerUserId: string;
    accountVersion: number;
    walletAddress: Address;
    chainId: number;
  },
): Promise<SettlementAccountResult> {
  const timestamp = nowIso(),
    wallet = input.walletAddress.toLowerCase();

  const results = await env.PAYMENTS_DB.batch<SettlementCommandRow>([
    env.PAYMENTS_DB.prepare(
      `INSERT INTO settlement_account_commands
   (command_id, merchant_id, owner_user_id, account_version, settlement_wallet, settlement_chain_id, applied, created_at)
   VALUES (?, COALESCE((SELECT id FROM merchants WHERE owner_user_id = ?), ?), ?, ?, ?, ?,
    CASE WHEN EXISTS (SELECT 1 FROM merchants WHERE owner_user_id = ? AND account_version >= ?) THEN 0 ELSE 1 END, ?)
   ON CONFLICT(command_id) DO NOTHING`,
    ).bind(
      input.commandId,
      input.ownerUserId,
      merchantIdForUser(input.ownerUserId),
      input.ownerUserId,
      input.accountVersion,
      wallet,
      input.chainId,
      input.ownerUserId,
      input.accountVersion,
      timestamp,
    ),
    env.PAYMENTS_DB.prepare(
      `INSERT INTO merchants
   (id, owner_user_id, settlement_wallet, settlement_chain_id, account_version, created_at, updated_at)
   SELECT merchant_id, owner_user_id, settlement_wallet, settlement_chain_id, account_version, created_at, created_at
   FROM settlement_account_commands WHERE command_id = ? AND owner_user_id = ? AND account_version = ?
    AND settlement_wallet = ? AND settlement_chain_id = ? AND applied = 1
   ON CONFLICT(owner_user_id) DO UPDATE SET settlement_wallet = excluded.settlement_wallet,
    settlement_chain_id = excluded.settlement_chain_id, account_version = excluded.account_version,
    updated_at = excluded.updated_at WHERE merchants.account_version < excluded.account_version`,
    ).bind(input.commandId, input.ownerUserId, input.accountVersion, wallet, input.chainId),
    env.PAYMENTS_DB.prepare(
      `SELECT merchant_id, owner_user_id, account_version, settlement_wallet,
   settlement_chain_id, applied FROM settlement_account_commands WHERE command_id = ?`,
    ).bind(input.commandId),
  ]);
  const saved = results[2].results[0];
  if (!saved) {
    throw new Error("Settlement account command was not persisted");
  }
  if (
    saved.owner_user_id !== input.ownerUserId ||
    saved.account_version !== input.accountVersion ||
    saved.settlement_wallet !== wallet ||
    saved.settlement_chain_id !== input.chainId
  ) {
    throw new SettlementAccountConflict();
  }
  return {
    merchantId: saved.merchant_id,
    accountVersion: saved.account_version,
    applied: saved.applied === 1,
  };
}
