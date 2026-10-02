import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ownerArgument } from '../scripts/dev-qr-fixture.mjs';
import {
  developmentConnection,
  developmentProjectId,
} from '../scripts/development-database.mjs';

test('dev:qr accepts only an explicit UUID owner argument', () => {
  assert.equal(ownerArgument([]), undefined);
  const id = randomUUID();
  assert.equal(ownerArgument(['--owner-user-id', id.toUpperCase()]), id);
  for (const args of [
    ['--owner-user-id'],
    ['--owner-user-id', 'not-a-uuid'],
    ['--owner', id],
    ['--owner-user-id', id, 'extra'],
  ])
    assert.throws(() => ownerArgument(args));
});

test('development guard refuses production, another project, pool mode and database without connecting', () => {
  const saved = { ...process.env };
  try {
    // This only validates configuration: no Client, PrismaService or .connect().
    // A dummy password also makes the test independent of a local .env file.
    const original = new URL(
      `postgresql://postgres:ci-not-a-secret@db.${developmentProjectId}.supabase.co:5432/postgres?schema=public&sslmode=require&sslaccept=strict`,
    );
    process.env.DATABASE_URL = original.toString();
    process.env.DATABASE_CA_CERT_PATH = '';
    process.env.NODE_ENV = 'test';
    assert.equal(developmentConnection().ssl.rejectUnauthorized, true);
    process.env.NODE_ENV = 'production';
    assert.throws(() => developmentConnection());
    process.env.NODE_ENV = 'test';
    for (const change of [
      (url) => {
        url.hostname = 'db.other-project.supabase.co';
      },
      (url) => {
        url.port = '6543';
      },
      (url) => {
        url.pathname = '/other';
      },
      (url) => {
        url.username = 'postgres.other-project';
      },
    ]) {
      const url = new URL(original);
      change(url);
      process.env.DATABASE_URL = url.toString();
      assert.throws(() => developmentConnection());
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
