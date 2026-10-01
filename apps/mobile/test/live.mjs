// Node-only integration runner. Never imported by Expo; server secrets stay here/API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  apiRoot,
  developmentConnection,
  developmentProjectId,
} from '../../api/scripts/development-database.mjs';
import { visitFixture } from '../../api/test/helpers/visit-fixture.mjs';
import { AppModule } from '../../api/dist/app.module.js';
import { PrismaService } from '../../api/dist/prisma/prisma.service.js';
import { createApiClient } from '../src/core/api-client.ts';
import { createSushiApi } from '../src/core/sushi-api.ts';
import { parseCheckInQr } from '../src/core/qr.ts';
import { Counter } from '../src/core/counter.ts';

const apiRequire = createRequire(resolve(apiRoot, 'package.json'));
const { NestFactory } = apiRequire('@nestjs/core');
const { parse } = apiRequire('dotenv');
let app, fixture, supabase, counter;
let stage = 'development-only configuration';
try {
  developmentConnection();
  assert.equal(
    process.env.SUPABASE_URL,
    `https://${developmentProjectId}.supabase.co`,
  );
  assert.ok(
    process.env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_'),
  );
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          }),
      },
    },
  );
  const credentials = parse(
    readFileSync(resolve(apiRoot, '.env.auth-test'), 'utf8'),
  );
  assert.ok(credentials.TEST_AUTH_EMAIL && credentials.TEST_AUTH_PASSWORD);
  stage = 'Supabase password login';
  const login = await supabase.auth.signInWithPassword({
    email: credentials.TEST_AUTH_EMAIL,
    password: credentials.TEST_AUTH_PASSWORD,
  });
  delete credentials.TEST_AUTH_PASSWORD;
  assert.equal(login.error, null);
  const userId = login.data.user.id;
  stage = 'NestJS startup';
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  const api = createSushiApi(
    createApiClient(await app.getUrl(), supabase.auth),
  );
  assert.equal((await api.me()).id, userId);
  fixture = await visitFixture(prisma);
  const location = await fixture.location(),
    code = await fixture.code(location.id);
  stage = 'mobile QR parser, idempotent check-in and session start';
  const input = {
    ...parseCheckInQr(
      JSON.stringify({ v: 1, locationId: location.id, token: code.token }),
    ),
    idempotencyKey: randomUUID(),
  };
  const visit = await api.checkIn(input);
  assert.equal(visit.status, 'PENDING');
  assert.equal((await api.checkIn(input)).id, visit.id);
  const session = await api.startSession(visit.id);
  assert.equal(session.pieceCount, 0);
  assert.equal((await api.startSession(visit.id)).id, session.id);
  counter = new Counter(api, session);
  stage = 'instant local taps and real version conflict reconciliation';
  counter.tap(1);
  counter.tap(1);
  counter.tap(-1);
  assert.equal(counter.getSnapshot().count, 1);
  await counter.flush();
  const otherDevice = await api.updateSession(
    session.id,
    10,
    counter.getSnapshot().session.version,
  );
  counter.tap(1);
  await assert.rejects(counter.flush(), (error) => error.status === 409);
  assert.equal(counter.getSnapshot().conflict, true);
  assert.equal(counter.getSnapshot().session.version, otherDevice.version);
  counter.resolveConflict(false);
  assert.equal(counter.getSnapshot().count, 10);
  stage = 'Supabase refresh and final absolute sync before completion';
  const refreshed = await supabase.auth.refreshSession();
  assert.equal(refreshed.error, null);
  assert.equal((await api.me()).id, userId);
  counter.tap(1);
  counter.tap(1);
  await counter.finish();
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().count, 12);
  stage = 'real history and unchanged Visit semantics';
  const final = await api.findSession(session.id);
  assert.equal(final.pieceCount, 12);
  assert.equal(final.status, 'COMPLETED');
  assert.ok((await api.visits()).items.some((row) => row.id === visit.id));
  const persistedVisit = await prisma.visit.findUniqueOrThrow({
    where: { id: visit.id },
  });
  assert.equal(persistedVisit.status, 'PENDING');
  assert.equal(persistedVisit.verifiedAt, null);
  console.log(
    'PASS: mobile client -> real Supabase Auth -> NestJS -> PostgreSQL.',
  );
  console.log(
    'Login, Bearer, QR parsing, idempotency, duplicate start, local taps, 409 reread, refresh, final sync, completion and histories verified.',
  );
  console.log(
    'Visit remains PENDING. This is not a physical camera/SecureStore device test.',
  );
} catch (error) {
  console.error(
    `Phase 4 live verification failed at: ${stage}${Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : ''}.`,
  );
  process.exitCode = 1;
} finally {
  counter?.dispose();
  try {
    if (fixture) {
      await fixture.cleanup();
      console.log(
        "Removed only this run's temporary restaurant, locations, codes, visits and sessions. Existing user/profile preserved.",
      );
    }
  } catch {
    console.error('Temporary fixture cleanup needs review.');
    process.exitCode = 1;
  }
  if (app) await app.close();
  if (supabase) {
    try {
      const result = await supabase.auth.signOut({ scope: 'local' });
      assert.equal(result.error, null);
      assert.equal((await supabase.auth.getSession()).data.session, null);
      console.log(
        'Test login signed out; no tokens saved; local test API stopped.',
      );
    } catch {
      console.error('Test sign-out could not be confirmed.');
      process.exitCode = 1;
    }
  }
}
