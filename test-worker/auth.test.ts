import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { authMiddleware, requireAuth, type PaymentsContext } from '../src/middlewares/auth';
import app from '../src/http';
import type { Bindings } from '../src/env';
import { apiRouteOwner } from '@gatopago/environment';
import { upsertSettlementAccount } from '../src/repositories/accounts';

const userId = 'usr_11111111-1111-4111-8111-111111111111';
const authorization = 'Bearer synthetic.signed.token';
function accepted(extra: Record<string, unknown> = {}) {
  return Response.json({ user_id: userId, environment: 'production', expires_at: Math.floor(Date.now() / 1000) + 3600, ...extra });
}
const testApp = new Hono<PaymentsContext>();
testApp.use('*', authMiddleware);
testApp.get('/private', requireAuth, c => c.json(c.get('user')));
testApp.get('/optional', c => c.json({ user: c.get('user') }));
function bindings(response: () => Promise<Response> | Response = accepted) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response());
  return { ...env, WALLET_IDENTITY: { fetch } } satisfies Bindings;
}
const request = (bindings: Bindings, headers: Record<string, string> = { Authorization: authorization }, path = '/private') =>
  testApp.request(`https://flow.test${path}`, { headers }, bindings);

describe('Flow delegates consumer identity to Wallet Core', () => {
  it('uses the private service with only bearer and environment, without reusing accepted sessions', async () => {
    const bound = bindings();
    const response = await request(bound, { Authorization: authorization, Origin: 'https://gatopago.com', 'X-Forwarded-User': 'forged' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ user_id: userId });
    const [url, init] = bound.WALLET_IDENTITY.fetch.mock.calls[0];
    expect(url).toBe('https://wallet-identity.internal/session');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Authorization: authorization, 'X-GatoPago-Environment': 'production' } });
    expect(Object.keys(init!.headers!)).toHaveLength(2);
    bound.WALLET_IDENTITY.fetch.mockResolvedValueOnce(Response.json({ error_code: 'UNAUTHENTICATED' }, { status: 401 }));
    expect((await request(bound)).status).toBe(401);
    expect(bound.WALLET_IDENTITY.fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves anonymous checkout and API-key authentication without contacting Wallet Core', async () => {
    const bound = bindings(() => { throw new Error('Unexpected service call'); });
    expect((await request(bound, {})).status).toBe(401);
    expect((await request(bound, {}, '/optional')).status).toBe(200);
    for (const key of ['sk_test_sample', 'sk_live_sample']) {
      expect((await request(bound, { Authorization: `Bearer ${key}` }, '/optional')).status).toBe(200);
      expect((await request(bound, { Authorization: `Bearer ${key}` })).status).toBe(401);
    }
    expect(bound.WALLET_IDENTITY.fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed or cookie-bearing sessions before contacting Wallet Core', async () => {
    const bound = bindings();
    const cases: Record<string, string>[] = [{ Authorization: 'Bearer invalid' }, { Authorization: 'Basic abc' },
      { Authorization: `Bearer ${'x'.repeat(8192)}` }, { Authorization: authorization, Cookie: 'session=value' }];
    for (const headers of cases) {
      expect((await request(bound, headers)).status).toBe(401);
    }
    expect(bound.WALLET_IDENTITY.fetch).not.toHaveBeenCalled();
  });
  it('does not silently turn a revoked or unavailable session into an anonymous payment', async () => {
    for (const status of [401, 403, 500, 503]) {
      const response = await request(bindings(() => new Response(null, { status })), undefined, '/optional');
      expect(response.status).toBe(status === 401 ? 401 : 503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await request({ ...env, WALLET_IDENTITY: undefined })).status).toBe(503);
    expect((await request(bindings(() => { throw new Error('Unavailable'); }))).status).toBe(503);
  });
  it('rejects wrong environment, bad identities, expired results and unexpected response fields', async () => {
    for (const extra of [{ environment: 'unsupported' }, { user_id: 'google-uid' }, { user_id: null },
      { expires_at: Math.floor(Date.now() / 1000) }, { expires_at: 9999999999 }, { email: 'private@example.test' }]) {
      expect((await request(bindings(() => accepted(extra)))).status).toBe(503);
    }
    expect((await request(bindings(() => new Response('x'.repeat(1025))))).status).toBe(503);
  });
  it('mounts the same guard on real merchant routes', async () => {
    const bound = bindings();
    const response = await app.request('https://flow.test/v1/payment_links', { headers: { Authorization: authorization } }, bound);
    expect(response.status).toBe(200);
    expect(bound.WALLET_IDENTITY.fetch).toHaveBeenCalledOnce();
    const rejected = await app.request('https://flow.test/v1/payment_links', { headers: { Authorization: authorization } }, bindings(() => new Response(null, { status: 401 })));
    expect(rejected.status).toBe(401);
  });
  it('keeps session collections separate from integrator API-key routes', async () => {
    for (const path of ['/v1/payment_links', '/v1/merchant/capabilities']) {
      expect((await app.request(`https://flow.test${path}`, { headers: { Authorization: authorization } }, bindings())).status).toBe(200);
      const credentials: Record<string, string>[] = [{}, { Authorization: 'Bearer sk_test_sample' }];
      for (const headers of credentials) {
        const bound = bindings();
        expect((await app.request(`https://flow.test${path}`, { headers }, bound)).status).toBe(401);
        expect(bound.WALLET_IDENTITY.fetch).not.toHaveBeenCalled();
      }
    }
    for (const path of ['/v1/payment_intents', '/v1/events']) {
      expect((await app.request(`https://flow.test${path}`, { headers: { Authorization: authorization } }, bindings())).status).toBe(401);
    }
  });
  it('serves business endpoints only in the declared V3 namespaces', async () => {
    for (const route of app.routes.filter(route => route.method !== 'ALL')) {
      expect(apiRouteOwner(route.path), route.path).toBe('flow-core');
    }
    for (const path of ['/', '/links', '/links/example', '/merchant', '/merchant/capabilities', '/checkout/example', '/health', '/health/live', '/health/ops']) {
      expect((await app.request(`https://flow.test${path}`, {}, bindings())).status).toBe(404);
    }
  });

  it('uses one merchant response shape and rejects retired expiry fields', async () => {
    await upsertSettlementAccount(env, { commandId: crypto.randomUUID(), ownerUserId: userId, accountVersion: 1,
      walletAddress: '0x00000000000000000000000000000000000000a1', chainId: 421614 });
    const bound = bindings();
    const headers = { Authorization: authorization, 'Content-Type': 'application/json' };
    const merchant = await app.request('https://flow.test/v1/merchant', { headers }, bound);
    expect(merchant.status).toBe(200);
    expect(Object.keys(await merchant.json()).sort()).toEqual([
      'account_version', 'created_at', 'id', 'name', 'settlement_chain_id', 'settlement_wallet', 'status', 'updated_at',
    ]);
    const createdKey = await app.request('https://flow.test/v1/merchant/keys', {
      method: 'POST', headers, body: JSON.stringify({ mode: 'test', name: 'Contract test' }),
    }, bound);
    expect(createdKey.status).toBe(201);
    const key = await createdKey.json<{ key: string; secret?: string }>();
    expect(key.key).toMatch(/^sk_test_/u);
    expect(key).not.toHaveProperty('secret');
    expect((await app.request('https://flow.test/v1/merchant/webhooks', {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://webhook.example/contracts', mode: 'test' }),
    }, bound)).status).toBe(201);
    const current = { amount: '10', expires_at: new Date(Date.now() + 60_000).toISOString() };
    for (const path of ['/v1/payment_links', '/v1/merchant/sandbox/charge', '/v1/payment_intents']) {
      const routeHeaders = path === '/v1/payment_intents' ? { ...headers, Authorization: `Bearer ${key.key}` } : headers;
      const obsolete = await app.request(`https://flow.test${path}`, {
        method: 'POST', headers: routeHeaders, body: JSON.stringify({ ...current, expiresAt: current.expires_at }),
      }, bound);
      expect(obsolete.status, path).toBe(400);
      expect(await obsolete.json()).toMatchObject({ error_code: 'INVALID_CALLDATA' });
      const response = await app.request(`https://flow.test${path}`, {
        method: 'POST', headers: routeHeaders, body: JSON.stringify(current),
      }, bound);
      expect(response.status, path).toBe(201);
      const created = await response.json<{ id: string; intentId?: string }>();
      if (path === '/v1/payment_links') {
        expect(created).toHaveProperty('intentId');
        expect(created).not.toHaveProperty('intent');
      } else {
        const detail = await app.request(`https://flow.test/v1/merchant/payment_intents/${created.id}`, { headers }, bound);
        expect(detail.status).toBe(200);
        expect(await detail.json()).not.toHaveProperty('onchain');
      }
    }
    const events = await app.request('https://flow.test/v1/merchant/events', { headers }, bound);
    const eventBody = await events.json<{ data: Record<string, unknown>[] }>();
    expect(eventBody.data).toHaveLength(3);
    for (const event of eventBody.data) {
      expect(event).toHaveProperty('payload');
      expect(event).not.toHaveProperty('data');
    }
    const deliveries = await app.request('https://flow.test/v1/merchant/webhook_deliveries', { headers }, bound);
    const deliveryBody = await deliveries.json<{ data: Record<string, unknown>[] }>();
    expect(deliveryBody.data).toHaveLength(3);
    for (const delivery of deliveryBody.data) {
      expect(delivery).toMatchObject({ attempt: 0, responseCode: null });
      expect(delivery).not.toHaveProperty('attemptCount');
      expect(delivery).not.toHaveProperty('lastStatusCode');
    }
  });
});
