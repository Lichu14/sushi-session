import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';
import { validateDatabaseUrl } from '../dist/config/environment.js';

export const apiRoot = fileURLToPath(new URL('../', import.meta.url));
export const developmentProjectId = 'qmlwqrfnfjphvgzjfnly';

// Shared by migration and integration checks. Never log connection configuration.
export function developmentConnection() {
  config({ path: resolve(apiRoot, '.env'), quiet: true });
  const url = new URL(validateDatabaseUrl(process.env.DATABASE_URL));
  const isSessionPooler = url.hostname.endsWith('.pooler.supabase.com')
    && decodeURIComponent(url.username) === `postgres.${developmentProjectId}`;
  const isDirect = url.hostname === `db.${developmentProjectId}.supabase.co`
    && decodeURIComponent(url.username) === 'postgres';
  if ((!isSessionPooler && !isDirect) || url.port !== '5432'
    || url.pathname !== '/postgres' || process.env.NODE_ENV === 'production') {
    throw new Error('Esta operación está limitada al proyecto sushi-session-dev, puerto 5432.');
  }
  const caPath = process.env.DATABASE_CA_CERT_PATH;
  const ca = caPath ? readFileSync(resolve(apiRoot, caPath), 'utf8') : undefined;
  url.search = '';
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'sushi-session-development-verification',
  };
}

export function developmentClient() {
  return new pg.Client(developmentConnection());
}
