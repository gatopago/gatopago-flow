import { getAddress, sha256, stringToBytes, type Address } from 'viem';
import { HttpError, newId, now } from './http';

export interface Merchant {
  readonly id: string;
  readonly address: Address;
  readonly name: string | null;
}

/** What is stored of an API key: its SHA-256, never the key. */
export const keyHash = (key: string) => sha256(stringToBytes(key));

/**
 * The merchant behind a request: an API key (`Bearer sk_…`, server to server) or a GatoPago session
 * (`Bearer <Wallet Core token>`, from the app or Business). A session's user becomes a merchant on
 * first use, receiving at their account address.
 */
export async function authenticate(
  request: Request,
  env: Env,
  options: { sessionOnly?: boolean } = {},
): Promise<Merchant> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  if (token.startsWith('sk_')) {
    if (options.sessionOnly) {
      throw new HttpError(403, 'SESSION_REQUIRED');
    }
    const merchant = await env.FLOW_DB.prepare(
      `SELECT merchants.id, merchants.address, merchants.name FROM api_keys
       JOIN merchants ON merchants.id = api_keys.merchant_id
       WHERE api_keys.key_hash = ? AND api_keys.revoked_at IS NULL`,
    )
      .bind(keyHash(token))
      .first<Merchant>();
    if (!merchant) {
      throw new HttpError(401, 'UNAUTHENTICATED');
    }
    return merchant;
  }

  const session = await verifySession(token, env);
  await env.FLOW_DB.prepare(
    `INSERT INTO merchants (id, owner_user_id, address, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_user_id) DO NOTHING`,
  )
    .bind(newId('mer'), session.userId, session.address, now())
    .run();
  return (await env.FLOW_DB.prepare(
    'SELECT id, address, name FROM merchants WHERE owner_user_id = ?',
  )
    .bind(session.userId)
    .first<Merchant>())!;
}

/**
 * Whose a GatoPago session is, asked to Wallet Core, which issues sessions and ends them (removing an
 * owner of the account ends every earlier one): a session it no longer accepts is not accepted here.
 */
async function verifySession(token: string, env: Env) {
  const response = await env.WALLET_CORE.fetch('https://wallet-core/app/v1/auth/session', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
  if (!response.ok) {
    throw new HttpError(503, 'SESSION_UNAVAILABLE');
  }
  const session = await response.json<{ user_id: string; address: string }>();
  return { userId: session.user_id, address: getAddress(session.address) };
}
