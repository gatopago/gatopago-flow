import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { FORKS, SIGNER_KEY, forkUrl } from './test/forks.ts';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Newest date the installed workerd supports.
        compatibilityDate: '2026-08-22',
        bindings: {
          WALLET_NETWORKS: FORKS.map((fork) => fork.id).join(','),
          HOME_NETWORK: 'eip155:421614',
          PLATFORM_FEE_BPS: '50',
          FLOW_RPC_URLS: JSON.stringify(
            Object.fromEntries(FORKS.map((fork) => [fork.id, forkUrl(fork.port)])),
          ),
          PAYMENT_SIGNER_PRIVATE_KEY: SIGNER_KEY,
          WEBHOOK_SECRET_KEY: randomBytes(32).toString('base64'),
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL('./migrations', import.meta.url)),
          ),
        },
        // Wallet Core, as Flow asks it about a session: `session.<user>.<address>` counts, any
        // other token (`ended.…`, one it ended) does not.
        serviceBindings: {
          WALLET_CORE: (request: Request) => {
            const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
            const [kind, user_id, address] = token?.split('.') ?? [];
            return kind === 'session' && user_id && address
              ? Response.json({ user_id, address })
              : Response.json({ error_code: 'UNAUTHENTICATED' }, { status: 401 });
          },
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/fork.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
