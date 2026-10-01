import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflareWorkers.ts", import.meta.url)) } },
	test: { environment: "node", include: ["test/**/*.test.ts"] },
});
