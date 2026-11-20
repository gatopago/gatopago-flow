import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { walletNetwork, type WalletNetwork } from '@gatopago/shared/networks';

export interface Network extends WalletNetwork {
  readonly id: string;
  readonly client: PublicClient;
  /** Sends the sweeps of the deposits on this network (`SWEEPER_PRIVATE_KEY`, which pays their gas). */
  readonly sweeper: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
}

export interface Config {
  readonly webOrigin: string;
  /** GatoPago Business (merchant console), or `null` when off. */
  readonly businessOrigin: string | null;
  readonly networks: ReadonlyMap<string, Network>;
  /** Where merchants receive. */
  readonly home: Network;
  readonly platformFeeBps: bigint;
  /** Signs the router authorizations (the router's `signer`). */
  readonly signer: ReturnType<typeof privateKeyToAccount>;
  readonly webhookKey: CryptoKey;
  /** Testnet deployments issue `sk_test_` keys and can simulate payments. */
  readonly testnet: boolean;
  /** External requests one cron run may make (Workers Free: 50 per invocation). */
  readonly subrequestsPerRun: number;
}

class ConfigError extends Error {}

const required = (env: Env, name: keyof Env): string => {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`MISSING_${String(name)}`);
  }
  return value.trim();
};

const privateKey = (env: Env, name: keyof Env) => {
  const key = required(env, name);
  if (!isHex(key) || key.length !== 66) {
    throw new ConfigError(`INVALID_${String(name)}`);
  }
  return privateKeyToAccount(key as Hex);
};

/** Every setting, validated together; a missing or invalid one stops the request. */
export async function config(env: Env): Promise<Config> {
  const urls: Record<string, unknown> = JSON.parse(required(env, 'FLOW_RPC_URLS'));
  const sweeper = privateKey(env, 'SWEEPER_PRIVATE_KEY');
  const networks = new Map<string, Network>();
  for (const raw of required(env, 'WALLET_NETWORKS').split(',')) {
    const id = raw.trim();
    const network = walletNetwork(id);
    const url = urls[id];
    if (typeof url !== 'string') {
      throw new ConfigError(`MISSING_RPC_URL ${id}`);
    }
    networks.set(id, {
      ...network,
      id,
      client: createPublicClient({ chain: network.chain, transport: http(url) }),
      sweeper: createWalletClient({ chain: network.chain, transport: http(url), account: sweeper }),
    });
  }
  const home = networks.get(required(env, 'HOME_NETWORK'));
  if (!home) {
    throw new ConfigError('HOME_NETWORK_NOT_ENABLED');
  }
  const fee = BigInt(required(env, 'PLATFORM_FEE_BPS'));
  if (fee < 0n || fee > 100n) {
    throw new ConfigError('INVALID_PLATFORM_FEE_BPS');
  }
  const subrequestsPerRun = Number(required(env, 'SUBREQUESTS_PER_RUN'));
  if (!Number.isSafeInteger(subrequestsPerRun) || subrequestsPerRun < 5) {
    throw new ConfigError('INVALID_SUBREQUESTS_PER_RUN');
  }
  const webhookKey = Uint8Array.from(atob(required(env, 'WEBHOOK_SECRET_KEY')), (c) =>
    c.charCodeAt(0),
  );
  if (webhookKey.length !== 32) {
    throw new ConfigError('INVALID_WEBHOOK_SECRET_KEY');
  }
  return {
    webOrigin: new URL(required(env, 'WEB_ORIGIN')).origin,
    businessOrigin: env.BUSINESS_ORIGIN ? new URL(env.BUSINESS_ORIGIN).origin : null,
    networks,
    home,
    platformFeeBps: fee,
    signer: privateKey(env, 'PAYMENT_SIGNER_PRIVATE_KEY'),
    webhookKey: await crypto.subtle.importKey('raw', webhookKey, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]),
    testnet: [...networks.values()].every((network) => network.chain.testnet),
    subrequestsPerRun,
  };
}
