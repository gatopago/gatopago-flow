import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { authMiddleware, requireAuth, type PaymentsContext } from '../src/middlewares/auth';
import app from '../src/http';
import type { Bindings } from '../src/env';
import { apiRouteOwner } from '@gatopago/environment';

const userId = 'usr_11111111-1111-4111-8111-111111111111';
const authorization = 'Bearer synthetic.signed.token';
function accepted(extra: Record<string, unknown> = {}) {
  return Response.json({ user_id: userId, environment: 'staging', expires_at: Math.floor(Date.now() / 1000) + 3600, ...extra });
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
    const response = await request(bound, { Authorization: authorization, Origin: 'https://staging.gatopago.com', 'X-Forwarded-User': 'forged' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ user_id: userId });
    const [url, init] = bound.WALLET_IDENTITY.fetch.mock.calls[0];
    expect(url).toBe('https://wallet-identity.internal/session');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Authorization: authorization, 'X-GatoPago-Environment': 'staging' } });
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
    for (const extra of [{ environment: 'production' }, { user_id: 'google-uid' }, { user_id: null },
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
    for (const route of app.routes.filter(route => route.method !== 'ALL' && route.path !== '/')) {
      expect(apiRouteOwner(route.path), route.path).toBe('flow-core');
    }
    for (const path of ['/links', '/links/example', '/merchant', '/merchant/capabilities', '/checkout/example', '/health', '/health/live', '/health/ops']) {
      expect((await app.request(`https://flow.test${path}`, {}, bindings())).status).toBe(404);
    }
  });
});
