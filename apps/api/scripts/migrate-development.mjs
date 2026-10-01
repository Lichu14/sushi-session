import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { apiRoot, developmentConnection } from './development-database.mjs';

try {
  developmentConnection();
  const command = process.argv[2];
  if (!['deploy', 'status'].includes(command)) throw new Error('Unsupported command');
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', command], {
    cwd: apiRoot,
    env: process.env,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} catch {
  console.error('No se ejecutó la migración: verificá la configuración de desarrollo y la compilación.');
  process.exitCode = 1;
}
