import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiRoot, type Environment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<Environment, true>) {
    const url = new URL(config.get('DATABASE_URL', { infer: true }));
    const caPath = config.get('DATABASE_CA_CERT_PATH', { infer: true });
    let ca: string | undefined;
    if (caPath) {
      try {
        ca = readFileSync(resolve(apiRoot, caPath), 'utf8');
      } catch {
        throw new Error('No se pudo leer DATABASE_CA_CERT_PATH.');
      }
    }

    // Configure TLS, schema and pool settings explicitly; URL options must not
    // override certificate verification or the intended schema.
    url.search = '';

    const adapter = new PrismaPg(
      {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
        max: 5,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      },
      { schema: 'public' },
    );
    super({ adapter, log: [] });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      throw new Error(
        'No se pudo conectar a PostgreSQL. Revisá DATABASE_URL, red y certificado TLS.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
