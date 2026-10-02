import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(apiRoot, '../..');
const directory = resolve(root, 'work');
const output = resolve(directory, 'dev-checkin-qr.png');
const temporary = resolve(directory, 'dev-checkin-qr.pending.png');
const lockPath = resolve(directory, '.dev-checkin-qr.lock');
let prisma,
  lock,
  createdId,
  published = false;
let stage = 'argumentos';
try {
  if (
    process.env.NODE_ENV &&
    !['development', 'test'].includes(process.env.NODE_ENV)
  )
    throw new Error();
  const { ownerArgument, prepareDevelopmentQr } =
    await import('./dev-qr-fixture.mjs');
  const ownerId = ownerArgument(process.argv.slice(2));
  stage = 'exclusión de Git';
  const git = ['-c', `safe.directory=${root.replaceAll('\\', '/')}`];
  await exec(
    'git',
    [...git, 'check-ignore', '--quiet', 'work/dev-checkin-qr.png'],
    { cwd: root, windowsHide: true },
  );
  const tracked = await exec('git', [...git, 'ls-files', '--', 'work'], {
    cwd: root,
    windowsHide: true,
  });
  if (tracked.stdout.trim()) throw new Error();
  stage = 'bloqueo local';
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error();
  lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  stage = 'compilación local';
  // Fresh clones need generated Prisma + Nest output. Capture build logs: do not
  // echo child output or raw exceptions, which might contain configuration values.
  for (const [entry, args] of [
    ['prisma/build/index.js', ['generate']],
    ['@nestjs/cli/bin/nest.js', ['build']],
  ]) {
    await exec(process.execPath, [require.resolve(entry), ...args], {
      cwd: apiRoot,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  stage = 'validación de sushi-session-dev';
  const { developmentConnection, developmentProjectId } =
    await import('./development-database.mjs');
  developmentConnection(); // fixed project, PostgreSQL port/database, strict TLS, public schema
  const { validateEnvironment } = await import('../dist/config/environment.js');
  const environment = validateEnvironment(process.env);
  if (
    environment.SUPABASE_URL !== `https://${developmentProjectId}.supabase.co`
  )
    throw new Error();
  const { ConfigService } = await import('@nestjs/config');
  const { PrismaService } = await import('../dist/prisma/prisma.service.js');
  prisma = new PrismaService(new ConfigService(environment));
  await prisma.onModuleInit();
  stage = 'fixture y PNG';
  const metadata = await prisma.$transaction(
    async (tx) => {
      const result = await prepareDevelopmentQr(tx, ownerId);
      // Validate and write before commit: generation/disk failures roll back rotation.
      await rm(temporary, { force: true });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(result.png);
        await file.sync();
      } finally {
        await file.close();
      }
      return result.metadata;
    },
    { maxWait: 15000, timeout: 30000 },
  );
  createdId = metadata.checkInCodeId;
  stage = 'publicación del PNG';
  await rename(temporary, output);
  published = true;
  process.stdout.write(
    JSON.stringify({ pngPath: output, ...metadata }, null, 2) + '\n',
  );
} catch {
  // Compensate if COMMIT succeeded but the PNG could not be published.
  if (createdId && !published && prisma) {
    try {
      await prisma.checkInCode.update({
        where: { id: createdId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    } catch {
      /* never print DB errors */
    }
  }
  process.stderr.write(
    `No se pudo generar el QR (${stage}). Revisá la guía dev:qr; no se muestran datos sensibles.\n`,
  );
  process.exitCode = 1;
} finally {
  if (prisma)
    await prisma.onModuleDestroy().catch(() => {
      process.exitCode = 1;
    });
  if (lock) {
    await rm(temporary, { force: true }).catch(() => {});
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
