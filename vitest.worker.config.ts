import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [cloudflareTest(async () => ({
		main: "./src/index.ts",
		wrangler: { configPath: "./wrangler.test.jsonc", environment: "runtime-test" },
		miniflare: {
			compatibilityDate: "2026-07-08",
			bindings: {
				PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
				WEBHOOK_SECRET_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
				WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "runtime-test",
				WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: JSON.stringify({
					"runtime-old": btoa("abcdef0123456789abcdef0123456789"),
				}),
				OPS_HEALTH_TOKEN: "runtime-test-ops-token-32-characters",
				TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
			},
		},
	}))],
	test: { include: ["test-worker/**/*.test.ts"], setupFiles: ["./test-worker/setup.ts"] },
});
