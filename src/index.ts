import { authenticate } from "./auth";
import { authorize, confirm, readCheckout } from "./checkout";
import { Budget } from "./budget";
import { config, type Config } from "./config";
import { HttpError, json, rateLimit, withCors } from "./http";
import {
  cancelIntent,
  createIntent,
  expireIntents,
  listIntents,
  readIntent,
  simulatePayment,
} from "./intents";
import { createApiKey, listApiKeys, readMerchant, revokeApiKey, updateMerchant } from "./merchants";
import { completeCrossings, scanNetworks } from "./reconcile";
import {
  createEndpoint,
  deleteEndpoint,
  deliverWebhooks,
  listEndpoints,
  listEvents,
  resendEvent,
} from "./webhooks";

async function route(request: Request, env: Env, settings: Config): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  const checkout = /^\/checkout\/v1\/(pi_[0-9a-f]{32})(?:\/(authorize|confirm))?$/.exec(pathname);
  if (checkout) {
    const [, id, action] = checkout;
    if (!action && method === "GET") {
      return readCheckout(env, settings, id);
    }
    if (action === "authorize" && method === "POST") {
      return authorize(request, env, settings, id);
    }
    if (action === "confirm" && method === "POST") {
      return confirm(request, env, settings, id);
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  const [resource, id, action, extra] = pathname.startsWith("/v1/")
    ? pathname.slice(4).split("/")
    : [];
  if (extra !== undefined) {
    throw new HttpError(404, "NOT_FOUND");
  }
  // Merchant profile and API keys need the owner's GatoPago session; the rest accepts API keys too.
  const sessionOnly = resource === "merchant" || resource === "api_keys";
  const merchant = await authenticate(request, env, settings, { sessionOnly });
  await rateLimit(env, `api:${merchant.id}`);
  switch (`${method} ${resource}${id ? "/:id" : ""}${action ? `/${action}` : ""}`) {
    case "GET merchant":
      return readMerchant(merchant);
    case "POST merchant":
      return updateMerchant(request, env, merchant);
    case "GET api_keys":
      return listApiKeys(env, merchant);
    case "POST api_keys":
      return createApiKey(env, settings, merchant);
    case "DELETE api_keys/:id":
      return revokeApiKey(env, merchant, id);
    case "GET payment_intents":
      return listIntents(env, settings, merchant);
    case "POST payment_intents":
      return createIntent(request, env, settings, merchant);
    case "GET payment_intents/:id":
      return readIntent(env, settings, merchant, id);
    case "POST payment_intents/:id/cancel":
      return cancelIntent(env, settings, merchant, id);
    case "POST payment_intents/:id/simulate":
      return simulatePayment(env, settings, merchant, id);
    case "GET events":
      return listEvents(env, merchant);
    case "POST events/:id/resend":
      return resendEvent(env, merchant, id);
    case "GET webhook_endpoints":
      return listEndpoints(env, merchant);
    case "POST webhook_endpoints":
      return createEndpoint(request, env, settings, merchant);
    case "DELETE webhook_endpoints/:id":
      return deleteEndpoint(env, merchant, id);
  }
  throw new HttpError(404, "NOT_FOUND");
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/v1/health") {
      try {
        await config(env);
        return json({ status: "ok" });
      } catch (error) {
        console.error(error);
        return json({ status: "misconfigured" }, 503);
      }
    }
    let settings: Config;
    try {
      settings = await config(env);
    } catch (error) {
      console.error(error);
      return json({ error_code: "SERVICE_UNAVAILABLE" }, 503);
    }
    // The app (checkout, charges) and GatoPago Business (the merchant console).
    const origin = request.headers.get("Origin");
    const cors = (response: Response) =>
      origin && (origin === settings.webOrigin || origin === settings.businessOrigin)
        ? withCors(response, origin)
        : response;
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    try {
      return cors(await route(request, env, settings));
    } catch (error) {
      if (error instanceof HttpError) {
        return cors(json({ error_code: error.code }, error.status));
      }
      console.error(error);
      return cors(json({ error_code: "INTERNAL_ERROR" }, 500));
    }
  },

  /**
   * Every minute: payments onchain first, then crossings Circle completed, webhooks and
   * expirations, within `SUBREQUESTS_PER_RUN` external requests; what does not fit waits a minute.
   */
  async scheduled(_controller, env) {
    const settings = await config(env);
    const budget = new Budget(settings.subrequestsPerRun);
    const results = [
      ...(await Promise.allSettled([scanNetworks(env, settings, budget)])),
      ...(await Promise.allSettled([
        completeCrossings(env, settings, budget),
        deliverWebhooks(env, settings, budget),
        expireIntents(env, settings),
      ])),
    ];
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(result.reason);
      }
    }
  },
} satisfies ExportedHandler<Env>;
