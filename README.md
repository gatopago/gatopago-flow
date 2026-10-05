# GatoPago Flow

Payments API for businesses: create a payment intent, share its checkout link and get a signed
webhook when it is paid in USDC. Any wallet pays it, including a GatoPago account (which pays with
one tap and no gas). Served at `api.gatopago.com/v1` and `/checkout/v1`.

## How a payment works

1. The merchant creates an intent (`POST /v1/payment_intents { amount: "18.00" }`) and sends the
   payer its `checkout_url` (`gatopago.com/pay/pi_…`).
2. The payer's wallet asks for an authorization (`POST /checkout/v1/:id/authorize { payer, network }`):
   Flow signs (EIP-712) the exact payment for `GatoPagoPaymentRouter` on that network.
3. The wallet approves USDC and calls `pay` (a GatoPago account does both in one operation). On the
   home network the router pays the merchant directly; from another network it burns with Circle
   CCTP and Circle's Forwarding Service mints to the merchant on the home network.
4. Flow reads the router's `PaymentSent` events every minute (or right away through
   `POST /checkout/v1/:id/confirm`). A crossing payment is `processing` until Circle reports the
   mint (`forwardState: COMPLETE`) and its transaction is confirmed on the home network.
5. The intent becomes `succeeded` and each webhook endpoint receives the event, signed with
   `GatoPago-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>` and retried with backoff.

The merchant receives at their GatoPago account address; GatoPago never holds the funds. The payer
pays the platform fee (`PLATFORM_FEE_BPS`) and, when crossing networks, Circle's fee ceiling.

## API

| Route | Auth |
|---|---|
| `GET`/`POST /v1/merchant` | Session |
| `GET`/`POST /v1/api_keys`, `DELETE /v1/api_keys/:id` | Session |
| `GET`/`POST /v1/payment_intents` (`Idempotency-Key`), `GET /v1/payment_intents/:id` | Key or session |
| `POST /v1/payment_intents/:id/cancel`, `/simulate` (testnet) | Key or session |
| `GET /v1/events` (with each delivery's state), `POST /v1/events/:id/resend`, `GET`/`POST /v1/webhook_endpoints`, `DELETE /v1/webhook_endpoints/:id` | Key or session |
| `GET /checkout/v1/:id`, `POST …/authorize`, `POST …/confirm` | Public |
| `GET /v1/health` | Public |

A key is `Authorization: Bearer sk_test_…`; a session is the token Wallet Core issues to the
GatoPago app, verified with Wallet Core's public key (`SESSION_PUBLIC_JWK`). A GatoPago user is a
merchant from their first request.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm wrangler d1 create gatopago-flow   # paste the id into wrangler.jsonc
pnpm db:migrate
```

Set `SESSION_PUBLIC_JWK` in `wrangler.jsonc` and the secrets in `.dev.vars.example`, then
`pnpm run deploy`. The router signer (`PAYMENT_SIGNER_PRIVATE_KEY`) must be the routers' `signer`.

`pnpm test` runs the Worker against a local D1 and anvil forks of Arbitrum Sepolia and Avalanche
Fuji, where the deployed routers are paid with Circle's USDC. The payment tests are skipped until
the routers are deployed (`DeployPayments.s.sol` in the protocol repository).
