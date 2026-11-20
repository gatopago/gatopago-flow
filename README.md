# GatoPago Flow

Payments API for businesses: create a payment intent, share its checkout link and get a signed
webhook when it is paid in USDC. Any wallet pays it, including a GatoPago account (which pays with
one tap and no gas). Served at `api.gatopago.com/v1` and `/checkout/v1`.

## How a payment works

1. The merchant creates an intent (`POST /v1/payment_intents { amount: "18.00", currency? }`) and
   sends the payer its `checkout_url` (`gatopago.com/pay/pi_…`). `currency` is `USDC` (the default)
   or another coin of Flow's networks, such as `AUSD` on Monad; test tokens are refused.
2. The payer's wallet asks for an authorization (`POST /checkout/v1/:id/authorize { payer, network }`):
   Flow signs (EIP-712) the exact payment for `GatoPagoPaymentRouter` on that network, in the
   intent's coin (`token`), valid for
   5 minutes. One network at a time: each router only knows its own payments, so while that
   authorization can still pay, another network is refused (`AUTHORIZED_ON_OTHER_NETWORK`).
3. The wallet approves USDC and calls `pay` (a GatoPago account does both in one operation). On the
   home network the router pays the merchant directly; from another network it burns with Circle
   CCTP and Circle's Forwarding Service mints to the merchant on the home network.
4. Flow reads the router's `PaymentSent` events every minute (or right away through
   `POST /checkout/v1/:id/confirm`). A crossing payment is `processing` until Circle reports the
   mint (`forwardState: COMPLETE`) and its transaction is confirmed on the home network.
5. The intent becomes `succeeded` and each webhook endpoint receives the event, signed with
   `GatoPago-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>` and retried with backoff.

### Paying to the deposit address

Every intent also has a `deposit_address` (Cascabel's `CascabelDeposit`, in `protocol`): the same
address on every network, paid with a plain transfer from any wallet or exchange, with no
authorization. It is derived from the intent and its settlement (the merchant's address, the home
network and Circle's crossing fee, quoted when the intent is created and fixed in the address), so
its funds can only reach the merchant.

1. Every minute Flow reads, with one multicall per network, what each deposit holds in the intent's
   coin, for intents until 7 days after they expire.
2. When a deposit holds the intent's amount on some network, the intent becomes `succeeded` there
   (`payment.network`; no transaction or payer, since it may take several transfers from anyone):
   from then on the funds can only go to the merchant. Less than the amount waits for the rest.
3. Flow sweeps it (`SWEEPER_PRIVATE_KEY` pays the gas): on the home network to the merchant; USDC
   paid on another network crosses with CCTP and the Forwarding Service mints to the merchant on
   the home network; another coin goes to the merchant on its own network. What arrives at the
   deposit of an intent already paid is swept too. Anyone may sweep: if Flow stops, the funds still
   reach only the merchant.

The merchant receives at their GatoPago account address; GatoPago never holds the funds. The payer
pays the platform fee (`PLATFORM_FEE_BPS`, in the intent's coin) and, when crossing networks,
Circle's fee ceiling. Only USDC crosses networks: an intent in another coin is paid and received on
that coin's network (`CURRENCY_NOT_ON_NETWORK` elsewhere), and the checkout read lists where it can
be paid (`networks`).

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
GatoPago app or to Business, checked with Wallet Core itself (`WALLET_CORE` service binding,
`GET /app/v1/auth/session`), so a session it ended (an owner of the account was removed) is refused
here too. A GatoPago user is a merchant from their first request.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm wrangler d1 create gatopago-flow   # paste the id into wrangler.jsonc
pnpm db:migrate
```

Then set the configuration below and `pnpm run deploy`. It serves `api.gatopago.com/v1/*` and
`api.gatopago.com/checkout/v1/*` (routes in `wrangler.jsonc`).

## Configuration

Plain settings live in `wrangler.jsonc` (`vars`); secrets are set with
`pnpm wrangler secret put <NAME>` and listed in `.dev.vars.example`. `/v1/health` answers 503 while
any of them is missing or invalid.

| Name | Kind | What it is | How to get it |
|---|---|---|---|
| `WEB_ORIGIN` | var | The web app's origin: CORS and the `checkout_url` of every intent | `https://gatopago.com` |
| `WALLET_NETWORKS` | var | CAIP-2 ids of the networks payers can pay from | The networks with a payment router (`paymentRouter` in `@gatopago/shared`) |
| `HOME_NETWORK` | var | Where merchants are paid; payments from other networks cross with CCTP | The web's `GATOPAGO_HOME_NETWORK` |
| `PLATFORM_FEE_BPS` | var | GatoPago's fee, in basis points, paid by the payer | Business policy; `0` on testnet |
| `SUBREQUESTS_PER_RUN` | var | External requests one cron run may make: payments are read first, then crossings and webhooks; the rest waits a minute | Workers Free allows 50 per invocation: `45`. Workers Paid: up to `1000` |
| `WALLET_CORE` | service binding | Wallet Core, which answers whether a session still counts | `services` in `wrangler.jsonc`: the Worker `gatopago-wallet-core`, deployed in the same account |
| `FLOW_RPC_URLS` | secret | `{"<network>": "<url>"}`: RPC that reads the routers' events and payments | Public RPCs. Flow reads 100 blocks per `eth_getLogs`, more than Alchemy's free tier allows (10) |
| `PAYMENT_SIGNER_PRIVATE_KEY` | secret | Signs each payment authorization the routers check | A dedicated key (`cast wallet new`); its address must be every router's `signer` (`setSigner`, called by the routers' owner) |
| `SWEEPER_PRIVATE_KEY` | secret | Sends the sweeps of deposit addresses and pays their gas | A dedicated key (`cast wallet new`), not the routers' signer; fund it with gas on every network in `WALLET_NETWORKS`. It can only move a deposit's funds to the deposit's settlement |
| `WEBHOOK_SECRET_KEY` | secret | Encrypts merchants' webhook signing secrets at rest | `openssl rand -base64 32`; changing it makes the stored secrets unreadable |

Bindings in `wrangler.jsonc`: `FLOW_DB` (D1, its id from `wrangler d1 create`) and
`RATE_LIMITER`.

`pnpm test` runs the Worker against a local D1 and anvil forks of Arbitrum Sepolia and Avalanche
Fuji, where the deployed routers are paid with Circle's USDC. The payment tests are skipped until
the routers are deployed (`DeployPayments.s.sol` in the protocol repository).
