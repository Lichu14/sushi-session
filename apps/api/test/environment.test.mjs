import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateDatabaseUrl,
  validateEnvironment,
  validateSupabaseUrl,
  validatePublishableKey,
} from '../dist/config/environment.js';

const url =
  'postgresql://user:example-password@localhost:5432/postgres?schema=public&sslmode=require&sslaccept=strict';
const auth = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_for_tests_only',
};

test('requires credentials without exposing their value in validation errors', () => {
  assert.throws(() => validateEnvironment({}), /DATABASE_URL/);
  const invalid = 'invalid-secret-value';
  assert.throws(
    () => validateDatabaseUrl(invalid),
    (error) => {
      assert.equal(error.message.includes(invalid), false);
      return true;
    },
  );
});

test('accepts public and rejects managed schemas or ambiguous schema parameters', () => {
  assert.equal(validateDatabaseUrl(url), url);
  for (const schema of ['auth', 'storage', 'public,auth']) {
    assert.throws(
      () =>
        validateDatabaseUrl(url.replace('schema=public', `schema=${schema}`)),
      /public/,
    );
  }
  assert.throws(() => validateDatabaseUrl(`${url}&schema=auth`), /public/);
});

test('requires strict TLS parameters', () => {
  assert.throws(
    () =>
      validateDatabaseUrl(url.replace('sslmode=require', 'sslmode=disable')),
    /sslmode/,
  );
  assert.throws(
    () =>
      validateDatabaseUrl(
        url.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'),
      ),
    /sslaccept/,
  );
});

test('validates the HTTP port independently from the PostgreSQL port', () => {
  assert.equal(validateEnvironment({ ...auth, DATABASE_URL: url }).PORT, 3001);
  assert.equal(
    validateEnvironment({ ...auth, DATABASE_URL: url, PORT: '3002' }).PORT,
    3002,
  );
  for (const PORT of ['', 'NaN', '1.5', '0', '65536']) {
    assert.throws(
      () => validateEnvironment({ ...auth, DATABASE_URL: url, PORT }),
      /PORT/,
    );
  }
});

test('Auth URL is fixed HTTPS and cannot contain paths, credentials or query parameters', () => {
  assert.equal(validateSupabaseUrl(`${auth.SUPABASE_URL}/`), auth.SUPABASE_URL);
  for (const value of [undefined, 'https://attacker.example', auth.SUPABASE_URL.replace('https:', 'http:'),
    `${auth.SUPABASE_URL}/auth/v1`, `${auth.SUPABASE_URL}?next=other`, `${auth.SUPABASE_URL}#fragment`,
    auth.SUPABASE_URL.replace('https://', 'https://user:secret@')]) {
    assert.throws(() => validateSupabaseUrl(value), /SUPABASE_URL/);
  }
  assert.throws(() => validateEnvironment({ DATABASE_URL: url }), /SUPABASE_URL/);
});

test('only a publishable API key is accepted; no secret or legacy service credential', () => {
  assert.equal(validatePublishableKey(auth.SUPABASE_PUBLISHABLE_KEY), auth.SUPABASE_PUBLISHABLE_KEY);
  for (const value of [undefined, '', 'sb_secret_do_not_use', 'eyJhbGciOiJIUzI1NiJ9.invalid.signature']) {
    assert.throws(() => validatePublishableKey(value), /SUPABASE_PUBLISHABLE_KEY/);
  }
});

test('rejects malformed password escaping and duplicate TLS parameters', () => {
  assert.throws(
    () =>
      validateDatabaseUrl(url.replace('example-password', 'example%password')),
    /codificada/,
  );
  assert.equal(
    validateDatabaseUrl(url.replace('example-password', 'example%25password')),
    url.replace('example-password', 'example%25password'),
  );
  assert.throws(() => validateDatabaseUrl(`${url}&sslmode=disable`), /sslmode/);
});
