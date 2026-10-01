import { NestFactory } from '@nestjs/core';
import { type INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { PrismaService } from './prisma.service.js';

let app: INestApplicationContext | undefined;
try {
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const prisma = app.get(PrismaService);
  const rows = await prisma.$queryRaw<
    Array<{ ok: number }>
  >`SELECT 1::integer AS ok`;
  if (rows.length !== 1 || rows[0].ok !== 1)
    throw new Error('Unexpected result');
  console.log(
    'PostgreSQL: conexión verificada desde NestJS / Prisma (SELECT 1 = 1).',
  );
} catch {
  // Never log driver errors or connection strings: they may contain credentials.
  console.error(
    'No se pudo verificar PostgreSQL. Revisá la configuración local, la red y TLS.',
  );
  process.exitCode = 1;
} finally {
  await app?.close();
}
