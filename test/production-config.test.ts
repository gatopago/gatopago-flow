import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("wrangler.jsonc", root), "utf8"));

describe("Worker deployment configuration", () => {
  it("uses production routes, checkout and the same-environment identity service", () => {
    expect(config.name).toBe("gatopago-flow");
    expect(config.vars.GATOPAGO_ENVIRONMENT).toBe("production");
    expect(config.vars.ALLOWED_ORIGINS).toBe("https://gatopago.com,https://business.gatopago.com");
    expect(config.vars.CHECKOUT_BASE_URL).toBe("https://gatopago.com/pay");
    expect(config.vars.PAYMENT_LIVE_ENABLED).toBe("false");
    expect(config.services).toEqual([
      { binding: "WALLET_IDENTITY", service: "gatopago-wallet-core", entrypoint: "WalletIdentity" },
    ]);
    expect(
      readdirSync(root)
        .filter((name) => /^wrangler\..*jsonc$/.test(name))
        .sort(),
    ).toEqual(["wrangler.jsonc", "wrangler.test.jsonc"]);
  });
  it("binds the verified production database and aligns queue delivery names", () => {
    expect(config.d1_databases).toEqual([
      {
        binding: "PAYMENTS_DB",
        database_name: "gatopago-flow",
        database_id: "9b6e90e5-3016-4f5c-bb14-51879b8a1a52",
        migrations_dir: "migrations",
      },
    ]);
    expect(config.vars.PAYMENT_JOBS_QUEUE_NAME).toBe("gatopago-flow-jobs");
    expect(config.queues.producers).toEqual([
      { binding: "PAYMENT_JOBS_QUEUE", queue: config.vars.PAYMENT_JOBS_QUEUE_NAME },
    ]);
    expect(config.queues.consumers[0]).toMatchObject({
      queue: config.vars.PAYMENT_JOBS_QUEUE_NAME,
      dead_letter_queue: "gatopago-flow-jobs-dlq",
    });
  });
});
