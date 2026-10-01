import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT, decodeJwt } from 'jose';

export async function authFixture() {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'ES256', use: 'sig' };
  const issuer = 'https://abcdefghijklmnopqrst.supabase.co/auth/v1';
  const config = new ConfigService({
    SUPABASE_URL: issuer.replace('/auth/v1', ''),
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_for_tests_only',
  });
  const state = { authStatus: 200, jwksStatus: 200, authId: undefined, authCalls: 0, jwksCalls: 0, failNetwork: false };
  const authFetch = async (input, options) => {
    if (state.failNetwork) throw new Error('Synthetic network failure');
    const url = String(input);
    if (url === `${issuer}/.well-known/jwks.json`) {
      state.jwksCalls++;
      return Response.json({ keys: [publicJwk] }, {status: state.jwksStatus});
    }
    if (url === `${issuer}/user`) {
      state.authCalls++;
      const token = new Headers(options.headers).get('Authorization').slice(7);
      return Response.json({ id: state.authId ?? decodeJwt(token).sub }, {status: state.authStatus});
    }
    throw new Error('Unexpected Auth URL');
  };
  const sign = async (claims = {}, options = {}) => {
    const now = Math.floor(Date.now()/1000);
    const payload = { sub: userId, session_id: sessionId, iss: issuer, aud: 'authenticated',
      role: 'authenticated', iat: now, exp: now+300, ...claims };
    for (const key of options.omit ?? []) delete payload[key];
    return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'fixture-key', ...options.header })
      .sign(options.key ?? privateKey);
  };
  return { userId, sessionId, issuer, config, authFetch, sign, state };
}
