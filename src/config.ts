import { createPublicClient, http, isHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletNetwork, type WalletNetwork } from "@gatopago/shared/networks";

export interface Network extends WalletNetwork {
  readonly id: string;
  readonly client: PublicClient;
}

export interface Config {
  readonly webOrigin: string;
  readonly networks: ReadonlyMap<string, Network>;
  /** Where merchants receive. */
  readonly home: Network;
  readonly platformFeeBps: bigint;
  /** Signs the router authorizations (the router's `signer`). */
  readonly signer: ReturnType<typeof privateKeyToAccount>;
  /** Wallet Core's session key: Flow trusts its sessions without calling it. */
  readonly sessionKey: JsonWebKey;
  readonly webhookKey: CryptoKey;
  /** Testnet deployments issue `sk_test_` keys and can simulate payments. */
  readonly testnet: boolean;
}

class ConfigError extends Error {}

const required = (env: Env, name: keyof Env): string => {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`MISSING_${String(name)}`);
  }
  return value.trim();
};

/** Every setting, validated together; a missing or invalid one stops the request. */
export async function config(env: Env): Promise<Config> {
  const urls: Record<string, unknown> = JSON.parse(required(env, "FLOW_RPC_URLS"));
  const networks = new Map<string, Network>();
  for (const raw of required(env, "WALLET_NETWORKS").split(",")) {
    const id = raw.trim();
    const network = walletNetwork(id);
    const url = urls[id];
    if (typeof url !== "string") {
      throw new ConfigError(`MISSING_RPC_URL ${id}`);
    }
    networks.set(id, {
      ...network,
      id,
      client: createPublicClient({ chain: network.chain, transport: http(url) }),
    });
  }
  const home = networks.get(required(env, "HOME_NETWORK"));
  if (!home) {
    throw new ConfigError("HOME_NETWORK_NOT_ENABLED");
  }
  const fee = BigInt(required(env, "PLATFORM_FEE_BPS"));
  if (fee < 0n || fee > 100n) {
    throw new ConfigError("INVALID_PLATFORM_FEE_BPS");
  }
  const signerKey = required(env, "PAYMENT_SIGNER_PRIVATE_KEY");
  if (!isHex(signerKey) || signerKey.length !== 66) {
    throw new ConfigError("INVALID_PAYMENT_SIGNER_PRIVATE_KEY");
  }
  const webhookKey = Uint8Array.from(atob(required(env, "WEBHOOK_SECRET_KEY")), (c) =>
    c.charCodeAt(0),
  );
  if (webhookKey.length !== 32) {
    throw new ConfigError("INVALID_WEBHOOK_SECRET_KEY");
  }
  return {
    webOrigin: new URL(required(env, "WEB_ORIGIN")).origin,
    networks,
    home,
    platformFeeBps: fee,
    signer: privateKeyToAccount(signerKey as Hex),
    sessionKey: JSON.parse(required(env, "SESSION_PUBLIC_JWK")),
    webhookKey: await crypto.subtle.importKey("raw", webhookKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
    testnet: [...networks.values()].every((network) => network.chain.testnet),
  };
}
