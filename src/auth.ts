import { importJWK, jwtVerify } from "jose";
import { getAddress, sha256, stringToBytes, type Address } from "viem";
import type { Config } from "./config";
import { HttpError, newId, now } from "./http";

export interface Merchant {
  readonly id: string;
  readonly address: Address;
  readonly name: string | null;
}

/** What is stored of an API key: its SHA-256, never the key. */
export const keyHash = (key: string) => sha256(stringToBytes(key));

/**
 * The merchant behind a request: an API key (`Bearer sk_…`, server to server) or a GatoPago session
 * (`Bearer <Wallet Core token>`, from the app). A session's user becomes a merchant on first use,
 * receiving at their account address.
 */
export async function authenticate(
  request: Request,
  env: Env,
  config: Config,
  options: { sessionOnly?: boolean } = {},
): Promise<Merchant> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) {
    throw new HttpError(401, "UNAUTHENTICATED");
  }
  if (token.startsWith("sk_")) {
    if (options.sessionOnly) {
      throw new HttpError(403, "SESSION_REQUIRED");
    }
    const merchant = await env.FLOW_DB.prepare(
      `SELECT merchants.id, merchants.address, merchants.name FROM api_keys
       JOIN merchants ON merchants.id = api_keys.merchant_id
       WHERE api_keys.key_hash = ? AND api_keys.revoked_at IS NULL`,
    )
      .bind(keyHash(token))
      .first<Merchant>();
    if (!merchant) {
      throw new HttpError(401, "UNAUTHENTICATED");
    }
    return merchant;
  }

  const session = await verifySession(token, config);
  await env.FLOW_DB.prepare(
    `INSERT INTO merchants (id, owner_user_id, address, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_user_id) DO NOTHING`,
  )
    .bind(newId("mer"), session.userId, session.address, now())
    .run();
  return (await env.FLOW_DB.prepare(
    "SELECT id, address, name FROM merchants WHERE owner_user_id = ?",
  )
    .bind(session.userId)
    .first<Merchant>())!;
}

async function verifySession(token: string, config: Config) {
  try {
    const { payload } = await jwtVerify(token, await importJWK(config.sessionKey, "ES256"), {
      issuer: "gatopago-wallet-core",
      algorithms: ["ES256"],
    });
    return { userId: String(payload.sub), address: getAddress(String(payload.address)) };
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED");
  }
}
