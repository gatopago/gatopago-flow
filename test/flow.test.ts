import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { SignJWT, importJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletNetworks } from "@gatopago/shared/networks";
import { paymentRouterAbi, type Payment } from "@gatopago/shared/payments";
import { readJson } from "../src/http";
import worker from "../src/index";
import { FORKS, PAYER_KEY, forkUrl } from "./forks";

const payer = privateKeyToAccount(PAYER_KEY);
const fork = (id: string) => {
  const network = walletNetworks[id as keyof typeof walletNetworks];
  const transport = http(forkUrl(FORKS.find((item) => item.id === id)!.port));
  return {
    network,
    public: createPublicClient({ chain: network.chain, transport }),
    wallet: createWalletClient({ chain: network.chain, transport, account: payer }),
  };
};
const [arbitrum, fuji] = [fork("eip155:421614"), fork("eip155:43113")];
/** Paying through the routers needs them deployed on the forked networks (DeployPayments). */
const routersDeployed = (
  await Promise.all(
    [arbitrum, fuji].map((on) => on.public.getCode({ address: on.network.paymentRouter })),
  )
).every(Boolean);

function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  return exports.default.fetch(
    new Request(`https://api.gatopago.com${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

let users = 0;
/** A merchant: a GatoPago session (as Wallet Core issues it) and an API key. */
async function merchant() {
  const address = privateKeyToAccount(
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  ).address;
  const session = await new SignJWT({ address })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("gatopago-wallet-core")
    .setSubject(`usr_test_${++users}`)
    .setExpirationTime("1h")
    .sign(await importJWK(JSON.parse(env.TEST_SESSION_JWK), "ES256"));
  const { key } = await (
    await api("/v1/api_keys", { method: "POST", token: session })
  ).json<{ key: string }>();
  return { address, session, key };
}

async function intent(key: string, amount = "5.00") {
  return (await api("/v1/payment_intents", { token: key, body: { amount } })).json<{
    id: string;
    status: string;
    checkout_url: string;
  }>();
}

const usdcOf = (on: typeof arbitrum, owner: Address) =>
  on.public.readContract({
    address: on.network.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });

/** The payer's external wallet: authorization from Flow, approve, pay. */
async function pay(on: typeof arbitrum, id: string) {
  const response = await api(`/checkout/v1/${id}/authorize`, {
    body: { payer: payer.address, network: `eip155:${on.network.chain.id}` },
  });
  expect(response.status).toBe(200);
  const authorization = await response.json<{
    router: Address;
    total: string;
    payment: Record<string, unknown>;
    signature: Hex;
  }>();
  const payment = {
    ...authorization.payment,
    amount: BigInt(authorization.payment.amount as string),
    fee: BigInt(authorization.payment.fee as string),
    maxCctpFee: BigInt(authorization.payment.maxCctpFee as string),
  } as Payment;
  const approve = await on.wallet.writeContract({
    address: on.network.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [authorization.router, parseUnits(authorization.total, 6)],
  });
  await on.public.waitForTransactionReceipt({ hash: approve });
  const hash = await on.wallet.writeContract({
    address: authorization.router,
    abi: paymentRouterAbi,
    functionName: "pay",
    args: [payment, authorization.signature],
  });
  await on.public.waitForTransactionReceipt({ hash });
  return { authorization, hash };
}

const runScheduled = () => worker.scheduled(createScheduledController(), env);

let webhooks: { body: string; signature: string }[] = [];
let iris: { forwardState: string; forwardTxHash?: Hex } | null = null;
beforeEach(() => {
  webhooks = [];
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://merchant.example/hooks") {
      webhooks.push({
        body: await request.text(),
        signature: request.headers.get("GatoPago-Signature")!,
      });
      return new Response(null, { status: 204 });
    }
    if (request.url.startsWith("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/")) {
      return Response.json([
        { finalityThreshold: 1000, minimumFee: 1, forwardFee: { high: 200_000 } },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { high: 200_000 } },
      ]);
    }
    if (request.url.startsWith("https://iris-api-sandbox.circle.com/v2/messages/")) {
      return Response.json({ messages: iris ? [iris] : [] });
    }
    return fetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("request bodies", () => {
  it("stop being read as soon as they are too large, and must be JSON objects", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 16_384;
        controller.enqueue(new Uint8Array(16_384).fill(32));
      },
    });
    const post = (body: BodyInit) =>
      new Request("https://flow.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
    await expect(readJson(post(endless))).rejects.toThrow("BODY_TOO_LARGE");
    expect(pulled).toBeLessThan(64 * 1024);
    await expect(readJson(post("null"))).rejects.toThrow("INVALID_JSON");
    expect(await readJson(post('{"amount":"1.00"}'))).toEqual({ amount: "1.00" });
  });
});

describe("access", () => {
  it("answers health and rejects requests without a valid key or session", async () => {
    expect(await (await api("/v1/health")).json()).toEqual({ status: "ok" });
    expect((await api("/v1/payment_intents")).status).toBe(401);
    expect((await api("/v1/payment_intents", { token: `sk_test_${"0".repeat(48)}` })).status).toBe(
      401,
    );
    expect((await api("/v1/payment_intents", { token: "not.a.session" })).status).toBe(401);
  });

  it("answers the app and GatoPago Business across origins, nobody else", async () => {
    const preflight = async (origin: string) =>
      (
        await api("/v1/payment_intents", { method: "OPTIONS", headers: { Origin: origin } })
      ).headers.get("Access-Control-Allow-Origin");
    expect(await preflight("https://gatopago.com")).toBe("https://gatopago.com");
    expect(await preflight("https://business.gatopago.com")).toBe("https://business.gatopago.com");
    expect(await preflight("https://evil.example")).toBeNull();
  });

  it("lets the owner's session manage keys, which cannot create more keys", async () => {
    const { address, session, key } = await merchant();
    expect(await (await api("/v1/merchant", { token: session })).json()).toMatchObject({
      address,
      name: null,
    });
    await api("/v1/merchant", { token: session, body: { name: "Café Norte" } });
    expect(await (await api("/v1/merchant", { token: session })).json()).toMatchObject({
      name: "Café Norte",
    });

    expect(await (await api("/v1/api_keys", { method: "POST", token: key })).json()).toEqual({
      error_code: "SESSION_REQUIRED",
    });
    const [listed] = (
      await (
        await api("/v1/api_keys", { token: session })
      ).json<{ data: { id: string; last4: string }[] }>()
    ).data;
    expect(listed.last4).toBe(key.slice(-4));
    await api(`/v1/api_keys/${listed.id}`, { method: "DELETE", token: session });
    expect((await api("/v1/payment_intents", { token: key })).status).toBe(401);
  });
});

describe("payment intents", () => {
  it("creates them idempotently, and cancels or simulates them", async () => {
    const { key } = await merchant();
    const create = () =>
      api("/v1/payment_intents", {
        token: key,
        body: { amount: "18.50", description: "Breakfast", metadata: { order: "42" } },
        headers: { "Idempotency-Key": "order-42" },
      });
    const first = await create();
    const created = await first.json<{ id: string; amount: string; checkout_url: string }>();
    expect(first.status).toBe(201);
    expect(created).toMatchObject({ amount: "18.5", currency: "USDC", status: "requires_payment" });
    expect(created.checkout_url).toBe(`https://gatopago.com/pay/${created.id}`);
    expect((await (await create()).json<{ id: string }>()).id).toBe(created.id);
    // The same key with another request is a mistake, not the same intent.
    const reused = await api("/v1/payment_intents", {
      token: key,
      body: { amount: "99.00" },
      headers: { "Idempotency-Key": "order-42" },
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error_code: "IDEMPOTENCY_KEY_REUSED" });
    expect(
      (await api("/v1/payment_intents", { token: key, body: { amount: "1.1234567" } })).status,
    ).toBe(400);

    expect(
      await (
        await api(`/v1/payment_intents/${created.id}/cancel`, { method: "POST", token: key })
      ).json(),
    ).toMatchObject({
      status: "canceled",
    });
    const other = await intent(key);
    expect(
      await (
        await api(`/v1/payment_intents/${other.id}/simulate`, { method: "POST", token: key })
      ).json(),
    ).toMatchObject({
      status: "succeeded",
    });
    const { data } = await (
      await api("/v1/events", { token: key })
    ).json<{ data: { type: string }[] }>();
    // One event per change: repeating the creation recorded nothing more.
    expect(data.map((event) => event.type).sort()).toEqual([
      "payment_intent.canceled",
      "payment_intent.created",
      "payment_intent.created",
      "payment_intent.succeeded",
    ]);
  });

  it("expires the ones nobody paid", async () => {
    const { key } = await merchant();
    const { id } = await intent(key);
    await env.FLOW_DB.prepare("UPDATE payment_intents SET expires_at = 1 WHERE id = ?")
      .bind(id)
      .run();
    await runScheduled();
    expect(await (await api(`/v1/payment_intents/${id}`, { token: key })).json()).toMatchObject({
      status: "expired",
    });
    expect(
      (
        await api(`/checkout/v1/${id}/authorize`, {
          body: { payer: payer.address, network: "eip155:421614" },
        })
      ).status,
    ).toBe(409);
  });
});

describe("webhooks", () => {
  it("delivers signed events, reports each delivery and delivers again on request", async () => {
    const { key } = await merchant();
    await api("/v1/webhook_endpoints", {
      token: key,
      body: { url: "https://merchant.example/hooks" },
    });
    const { id } = await intent(key);
    await api(`/v1/payment_intents/${id}/simulate`, { token: key, body: {} });
    await runScheduled();
    const events = await (
      await api("/v1/events", { token: key })
    ).json<{
      data: { id: string; type: string; deliveries: { delivered_at: number | null }[] }[];
    }>();
    const event = events.data.find((item) => item.type === "payment_intent.succeeded")!;
    expect(event.deliveries).toHaveLength(1);
    expect(event.deliveries[0].delivered_at).not.toBeNull();

    webhooks = [];
    expect((await api(`/v1/events/${event.id}/resend`, { token: key, body: {} })).status).toBe(200);
    await runScheduled();
    expect(webhooks.map((webhook) => JSON.parse(webhook.body).id)).toEqual([event.id]);
    expect((await api("/v1/events/evt_unknown/resend", { token: key, body: {} })).status).toBe(404);
  });
});

describe.skipIf(!routersDeployed)("checkout (needs the routers deployed)", () => {
  it("is paid on the home network and the merchant gets a signed webhook", async () => {
    const { address, key } = await merchant();
    const endpoint = await (
      await api("/v1/webhook_endpoints", {
        token: key,
        body: { url: "https://merchant.example/hooks" },
      })
    ).json<{
      secret: string;
    }>();
    const { id } = await intent(key);
    expect(await (await api(`/checkout/v1/${id}`)).json()).toMatchObject({
      amount: "5",
      merchant: { address },
      home_network: "eip155:421614",
    });

    const { authorization, hash } = await pay(arbitrum, id);
    expect(authorization.total).toBe("5.025"); // 50 bps platform fee, paid by the payer
    expect(await usdcOf(arbitrum, address)).toBe(5_000_000n);
    const confirmed = await api(`/checkout/v1/${id}/confirm`, {
      body: { network: "eip155:421614", transaction_hash: hash },
    });
    expect(await confirmed.json()).toMatchObject({
      status: "succeeded",
      payment: { network: "eip155:421614", transaction_hash: hash, payer: payer.address },
    });

    await runScheduled();
    const delivered = webhooks.find(
      (webhook) => JSON.parse(webhook.body).type === "payment_intent.succeeded",
    )!;
    const [, timestamp, signature] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(delivered.signature)!;
    const expected = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(endpoint.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      new TextEncoder().encode(`${timestamp}.${delivered.body}`),
    );
    expect(signature).toBe(bytesToHex(new Uint8Array(expected)).slice(2));
  });

  it("is paid from another network and settles once Circle mints to the merchant", async () => {
    const { key } = await merchant();
    const { id } = await intent(key);
    await runScheduled(); // starts reading both networks from their latest block
    const { authorization, hash } = await pay(fuji, id);
    // 5 + 0.025 fee + 0.2 forwarding ceiling (Standard transfer from Avalanche: no protocol fee)
    expect(authorization.total).toBe("5.225");

    iris = null;
    await runScheduled();
    expect(await (await api(`/v1/payment_intents/${id}`, { token: key })).json()).toMatchObject({
      status: "processing",
      payment: { network: "eip155:43113", transaction_hash: hash },
    });

    // Circle's mint on the home network: any confirmed transaction stands in for it on the fork.
    const mint = await arbitrum.wallet.sendTransaction({ to: payer.address, value: 0n });
    await arbitrum.public.waitForTransactionReceipt({ hash: mint });
    iris = { forwardState: "COMPLETE", forwardTxHash: mint };
    await runScheduled();
    expect(await (await api(`/v1/payment_intents/${id}`, { token: key })).json()).toMatchObject({
      status: "succeeded",
    });
  });
});
