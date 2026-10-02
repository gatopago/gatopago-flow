import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Avoid Oxc's large raw-transfer buffer reservation on Windows.
const cli = fileURLToPath(new URL('../bin/knip.js', import.meta.resolve('knip')));
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
