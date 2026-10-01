import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { apiRoot, developmentConnection, developmentProjectId } from './development-database.mjs';

// Explicit live test: logs in to Auth using a user the developer already created.
// Never creates/deletes Auth identities or prints credentials/access/refresh tokens.
// The resulting public profile is intentionally retained, so it can be inspected.
let app;
let accessToken;
let authUrl;
let publishableKey;
let stage='development configuration';
try {
  developmentConnection();
  assert.equal(process.env.SUPABASE_URL,`https://${developmentProjectId}.supabase.co`);
  authUrl=`${process.env.SUPABASE_URL}/auth/v1`;
  publishableKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  const credentials=parse(readFileSync(resolve(apiRoot,'.env.auth-test'),'utf8'));
  assert.ok(credentials.TEST_AUTH_EMAIL && credentials.TEST_AUTH_PASSWORD);
  stage='Supabase password sign-in';
  const login=await fetch(`${authUrl}/token?grant_type=password`,{
    method:'POST',
    headers:{apikey:publishableKey,'Content-Type':'application/json'},
    body:JSON.stringify({email:credentials.TEST_AUTH_EMAIL,password:credentials.TEST_AUTH_PASSWORD}),
    signal:AbortSignal.timeout(10_000),redirect:'error',
  });
  delete credentials.TEST_AUTH_PASSWORD;
  assert.equal(login.status,200,'Auth sign-in must succeed');
  const session=await login.json();
  assert.ok(session.access_token && session.user?.id);
  accessToken=session.access_token;
  const expectedId=session.user.id;
  delete session.access_token;
  delete session.refresh_token;
  stage='NestJS startup';
  app=await NestFactory.create(AppModule,{logger:false,abortOnError:false});
  const prisma=app.get(PrismaService);
  const before=await prisma.user.findUnique({where:{id:expectedId}});
  await app.listen(app.get(ConfigService).get('PORT'),'127.0.0.1');
  const base=await app.getUrl();
  stage='unauthenticated /me and public health';
  assert.equal((await fetch(`${base}/me`)).status,401);
  assert.equal((await fetch(`${base}/me`,{headers:{Authorization:'Bearer invalid'}})).status,401);
  const health=await fetch(`${base}/health`);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{status:'ok'});
  stage='concurrent authenticated /me requests';
  const responses=await Promise.all(Array.from({length:4},()=>fetch(`${base}/me?userId=00000000-0000-0000-0000-000000000000`,{
    headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(15_000),
  })));
  for(const response of responses){
    assert.equal(response.status,200,'GET /me must succeed');
    assert.equal(response.headers.get('cache-control'),'no-store');
    const profile=await response.json();
    assert.equal(profile.id,expectedId);
    assert.equal(profile.status,'ACTIVE');
    for(const field of ['password','access_token','refresh_token','email','user_metadata','sessionId']){
      assert.equal(field in profile,false);
    }
  }
  stage='persisted profile verification';
  const after=await prisma.user.findUnique({where:{id:expectedId}});
  assert.ok(after);
  assert.equal(after.id,expectedId);
  assert.equal(await prisma.user.count({where:{id:expectedId}}),1);
  if(before) assert.deepEqual(after,before);
  console.log(`Verified real Supabase Auth identity: ${expectedId}`);
  console.log(before ? 'Existing public profile preserved.' : 'New public profile provisioned from Auth identity.');
  console.log('GET /me: 4 concurrent HTTP 200 responses; identical UUID, one profile, no Auth credentials returned.');
  console.log('Missing/invalid token: HTTP 401. GET /health: HTTP 200.');
} catch(error) {
  // Only the stage and HTTP status are diagnostic. No response bodies or secrets.
  const status=error?.actual;
  console.error(`Auth live verification failed at: ${stage}${Number.isInteger(status)?` (HTTP ${status})`:''}.`);
  process.exitCode=1;
} finally {
  if(app) await app.close();
  if(accessToken && authUrl && publishableKey){
    // Revoke only the test's refresh session, not the user's other sessions.
    try {
      const logout=await fetch(`${authUrl}/logout?scope=local`,{
        method:'POST',headers:{apikey:publishableKey,Authorization:`Bearer ${accessToken}`},
        signal:AbortSignal.timeout(5_000),redirect:'error',
      });
      if(!logout.ok) console.error('Test session logout was not confirmed.');
      else console.log('Test session signed out; no tokens saved. NestJS test server closed.');
    } catch {console.error('Test session logout was not confirmed.');}
  }
  accessToken=undefined;
}
