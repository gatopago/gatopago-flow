import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.remote.jsonc', root), 'utf8'));

describe('production deployment configuration (no remote writes)', () => {
  it('uses production routes, checkout and the same-environment identity service', () => {
    expect(config.name).toBe('gatopago-flow');
    expect(config.vars.GATOPAGO_ENVIRONMENT).toBe('production');
    expect(config.vars.ALLOWED_ORIGINS).toBe('https://gatopago.com,https://business.gatopago.com');
    expect(config.vars.CHECKOUT_BASE_URL).toBe('https://gatopago.com/pay');
    expect(config.vars.PAYMENT_LIVE_ENABLED).toBe('false');
    expect(config.services).toEqual([{ binding: 'WALLET_IDENTITY', service: 'gatopago-wallet-core', entrypoint: 'WalletIdentity' }]);
    expect(JSON.stringify(config)).not.toMatch(/staging/i);
    expect(existsSync(new URL('wrangler.staging.jsonc', root))).toBe(false);
  });
  it('preserves database identity and aligns producer, consumer and delivery names', () => {
    expect(config.d1_databases).toEqual([{ binding: 'PAYMENTS_DB',
      database_id: 'f2ab2200-100d-4ae4-9248-042a6e633b8a', migrations_dir: 'migrations' }]);
    expect(config.vars.PAYMENT_JOBS_QUEUE_NAME).toBe('gatopago-flow-jobs');
    expect(config.queues.producers).toEqual([{ binding: 'PAYMENT_JOBS_QUEUE', queue: config.vars.PAYMENT_JOBS_QUEUE_NAME }]);
    expect(config.queues.consumers[0]).toMatchObject({ queue: config.vars.PAYMENT_JOBS_QUEUE_NAME,
      dead_letter_queue: 'gatopago-flow-jobs-dlq' });
  });
  it('keeps local development on loopback and isolated resources', () => {
    const local = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
    expect(local).toContain('"GATOPAGO_ENVIRONMENT": "production"');
    expect(local).toContain('"CHECKOUT_BASE_URL": "http://localhost:3000/pay"');
    expect(local).toContain('"remote": false');
    expect(local).not.toContain(config.d1_databases[0].database_id);
    expect(local).not.toContain('staging');
  });
  it('rejects the removed deployment switch before invoking Wrangler', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/deploy.mjs', root)), '--dry-run', '--staging'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_PARSE_ARGS_UNKNOWN_OPTION');
  });
  it('uses the production namespace with synthetic credentials in CI', () => {
    const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    expect(ci).toContain('GATOPAGO_ENVIRONMENT: production');
    expect(ci).toContain('FIREBASE_PROJECT_ID: v3-build-test');
    expect(ci).not.toContain('staging');
  });
});
