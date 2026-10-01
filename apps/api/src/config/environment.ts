import { fileURLToPath } from 'node:url';

// The same relative location works in src/config and dist/config.
export const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
export const envFilePath = fileURLToPath(
  new URL('../../.env', import.meta.url),
);

export interface Environment {
  PORT: number;
  DATABASE_URL: string;
  DATABASE_CA_CERT_PATH?: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
}

export function validateSupabaseUrl(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('SUPABASE_URL es obligatoria.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL debe ser la URL HTTPS del proyecto.');
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'SUPABASE_URL debe ser https://PROJECT_REF.supabase.co, sin rutas ni credenciales.',
    );
  }
  return url.origin;
}

export function validatePublishableKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(value)
  ) {
    throw new Error(
      'SUPABASE_PUBLISHABLE_KEY debe ser una clave publicable; no usar secret ni service_role.',
    );
  }
  return value;
}

export function validateDatabaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'DATABASE_URL es obligatoria; configurala en apps/api/.env.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL debe ser una URL PostgreSQL válida.');
  }

  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error(
      'La contraseña de DATABASE_URL debe estar codificada para una URL.',
    );
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    url.pathname === '/' ||
    !url.pathname ||
    url.hash
  ) {
    throw new Error(
      'DATABASE_URL requiere host, usuario, contraseña y base de datos válidos.',
    );
  }

  const schemas = url.searchParams.getAll('schema');
  if (schemas.length !== 1 || schemas[0] !== 'public') {
    throw new Error('DATABASE_URL debe declarar únicamente schema=public.');
  }

  if (
    url.searchParams.getAll('sslmode').length !== 1 ||
    url.searchParams.get('sslmode') !== 'require' ||
    url.searchParams.getAll('sslaccept').length !== 1 ||
    url.searchParams.get('sslaccept') !== 'strict'
  ) {
    throw new Error(
      'DATABASE_URL debe incluir sslmode=require y sslaccept=strict.',
    );
  }

  return value;
}

export function validateEnvironment(
  values: Record<string, unknown>,
): Environment {
  const port = Number(values.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT debe ser un entero entre 1 y 65535.');
  }

  const caPath = values.DATABASE_CA_CERT_PATH;
  if (caPath !== undefined && typeof caPath !== 'string') {
    throw new Error('DATABASE_CA_CERT_PATH debe ser una ruta de archivo.');
  }

  return {
    PORT: port,
    DATABASE_URL: validateDatabaseUrl(values.DATABASE_URL),
    DATABASE_CA_CERT_PATH:
      typeof caPath === 'string' && caPath.trim() ? caPath : undefined,
    SUPABASE_URL: validateSupabaseUrl(values.SUPABASE_URL),
    SUPABASE_PUBLISHABLE_KEY: validatePublishableKey(
      values.SUPABASE_PUBLISHABLE_KEY,
    ),
  };
}
