import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';
import { validateDatabaseUrl } from './src/config/environment.ts';

config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

const databaseUrl = process.env.DATABASE_URL
  ? new URL(validateDatabaseUrl(process.env.DATABASE_URL))
  : undefined;
if (databaseUrl && process.env.DATABASE_CA_CERT_PATH) {
  databaseUrl.searchParams.set(
    'sslcert',
    resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      process.env.DATABASE_CA_CERT_PATH,
    ),
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Generation and validation do not need a live database or credentials.
    url: databaseUrl?.toString(),
  },
});
