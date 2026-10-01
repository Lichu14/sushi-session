import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair } from 'jose';
import { SupabaseJwtService } from '../dist/auth/supabase-jwt.service.js';
import { authFixture } from './helpers/auth-fixture.mjs';

test('JWT: signature, claims, fixed JWKS and fresh identity verification', async (t) => {
  const f = await authFixture();
  const service = new SupabaseJwtService(f.config, f.authFetch);
  const expectStatus = (action, status) => assert.rejects(action, (error) => error.getStatus?.() === status);
  await t.test('valid ES256 token retains only verified UUID and session ID', async () => {
    const token = await f.sign({ user_metadata: { role: 'OWNER', userId: 'attacker' }, email: 'not-copied@example.com' });
    assert.deepEqual(await service.authenticate(token), { id: f.userId, sessionId: f.sessionId });
    assert.equal(f.state.authCalls, 1);
  });
  for (const [name, claims, options] of [
    ['expired', { iat: 1, exp: 2 }],
    ['wrong issuer', { iss: 'https://another-project.supabase.co/auth/v1' }],
    ['wrong audience', { aud: 'service_role' }],
    ['wrong role', { role: 'service_role' }],
    ['non UUID subject', { sub: 'not-a-uuid' }],
    ['non UUID session', { session_id: 'not-a-uuid' }],
    ['future issued-at', { iat: Math.floor(Date.now()/1000)+100 }],
    ['not yet valid', { nbf: Math.floor(Date.now()/1000)+100 }],
    ['missing expiration', {}, {omit: ['exp']}],
    ['missing session', {}, {omit: ['session_id']}],
    ['missing subject', {}, {omit: ['sub']}],
    ['wrong type', {}, {header: {typ: 'refresh'}}],
    ['unknown key', {}, {header: {kid: 'unknown'}}],
  ]) {
    await t.test(`rejects ${name} before Auth lookup`, async () => {
      const calls = f.state.authCalls;
      const token = await f.sign(claims, options);
      await expectStatus(() => service.authenticate(token), 401);
      assert.equal(f.state.authCalls, calls);
    });
  }
  await t.test('rejects a signature made with another private key', async () => {
    const other = await generateKeyPair('ES256');
    const token = await f.sign({}, {key: other.privateKey});
    await expectStatus(() => service.authenticate(token), 401);
  });
  await t.test('rejects HS256 and unsigned JWTs; no shared-secret fallback', async () => {
    const token = await f.sign({}, {header:{alg:'HS256'},key:new Uint8Array(32)});
    await expectStatus(() => service.authenticate(token), 401);
    await expectStatus(() => service.authenticate('eyJhbGciOiJub25lIn0.e30.'), 401);
  });
  await t.test('rejects malformed or oversized tokens without network requests', async () => {
    const calls = f.state.authCalls + f.state.jwksCalls;
    for(const token of ['', 'not-a-jwt', 'e30.e30.invalid', 'a'.repeat(8193)]) {
      await expectStatus(() => service.authenticate(token), 401);
    }
    assert.equal(f.state.authCalls + f.state.jwksCalls, calls);
  });
  await t.test('ignores token-provided key URLs and never fetches an arbitrary issuer', async () => {
    const token = await f.sign({}, {header:{jku:'https://attacker.example/jwks'}});
    assert.equal((await service.authenticate(token)).id, f.userId);
  });
  await t.test('checks Auth on every request even with cached JWKS', async () => {
    const token = await f.sign();
    const calls = f.state.authCalls;
    await service.authenticate(token);
    await service.authenticate(token);
    assert.equal(f.state.authCalls, calls+2);
    assert.equal(f.state.jwksCalls, 1);
  });
  await t.test('rejects an identity removed in Auth', async () => {
    f.state.authStatus = 401;
    const token = await f.sign();
    await expectStatus(() => service.authenticate(token), 401);
    f.state.authStatus = 200;
  });
  await t.test('Auth response UUID must equal JWT subject', async () => {
    f.state.authId = 'another-identity';
    const token = await f.sign();
    await expectStatus(() => service.authenticate(token), 401);
    f.state.authId = undefined;
  });
  await t.test('Auth outage and JWKS outage both fail closed with 503', async () => {
    const token = await f.sign();
    f.state.authStatus = 503;
    await expectStatus(() => service.authenticate(token), 503);
    f.state.authStatus = 200;
    f.state.failNetwork = true;
    await expectStatus(() => service.authenticate(token), 503);
    const fresh = new SupabaseJwtService(f.config, f.authFetch);
    await expectStatus(() => fresh.authenticate(token), 503);
    f.state.failNetwork = false;
  });
});
