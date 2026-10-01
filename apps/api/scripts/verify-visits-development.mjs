import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse} from 'dotenv';
import {NestFactory} from '@nestjs/core';
import {AppModule} from '../dist/app.module.js';
import {PrismaService} from '../dist/prisma/prisma.service.js';
import {apiRoot,developmentConnection,developmentProjectId} from './development-database.mjs';
import {visitFixture} from '../test/helpers/visit-fixture.mjs';

let app,fixture,accessToken,authUrl,publishableKey;
let stage='development configuration';
try {
  developmentConnection();
  assert.equal(process.env.SUPABASE_URL,`https://${developmentProjectId}.supabase.co`);
  authUrl=process.env.SUPABASE_URL+'/auth/v1';publishableKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  const credentials=parse(readFileSync(resolve(apiRoot,'.env.auth-test'),'utf8'));
  assert.ok(credentials.TEST_AUTH_EMAIL&&credentials.TEST_AUTH_PASSWORD);
  stage='real Supabase sign-in';
  const login=await fetch(`${authUrl}/token?grant_type=password`,{
    method:'POST',headers:{apikey:publishableKey,'Content-Type':'application/json'},
    body:JSON.stringify({email:credentials.TEST_AUTH_EMAIL,password:credentials.TEST_AUTH_PASSWORD}),
    signal:AbortSignal.timeout(10000),redirect:'error',
  });
  delete credentials.TEST_AUTH_PASSWORD;
  assert.equal(login.status,200);
  const auth=await login.json();accessToken=auth.access_token;const userId=auth.user.id;
  delete auth.access_token;delete auth.refresh_token;
  stage='NestJS startup';
  app=await NestFactory.create(AppModule,{logger:false,abortOnError:false});
  await app.listen(0,'127.0.0.1');
  const base=await app.getUrl(),prisma=app.get(PrismaService);
  const http=async(method,path,body)=>{
    const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,data:await response.json()};
  };
  assert.equal((await http('GET','/health')).status,200);
  assert.equal((await http('GET','/me')).data.id,userId);
  fixture=await visitFixture(prisma);
  const location=await fixture.location(),qr=await fixture.code(location.id);
  stage='authenticated check-in and retry';
  const input={locationId:location.id,token:qr.token,idempotencyKey:randomUUID()};
  const visit=await http('POST','/check-ins',input);assert.equal(visit.status,201);assert.equal(visit.data.userId,userId);
  const retry=await http('POST','/check-ins',input);assert.equal(retry.status,201);assert.equal(retry.data.id,visit.data.id);
  stage='session creation and absolute counter';
  const session=await http('POST',`/visits/${visit.data.id}/session`,{});assert.equal(session.status,201);
  const updated=await http('PATCH',`/sessions/${session.data.id}`,{pieceCount:12,version:1});assert.equal(updated.status,200);assert.equal(updated.data.version,2);
  assert.equal((await http('PATCH',`/sessions/${session.data.id}`,{pieceCount:18,version:1})).status,409);
  stage='completion and immutable closed count';
  const closed=await http('POST',`/sessions/${session.data.id}/complete`,{version:2});assert.equal(closed.status,200);assert.equal(closed.data.status,'COMPLETED');assert.ok(new Date(closed.data.endedAt)>=new Date(closed.data.startedAt));
  assert.equal((await http('PATCH',`/sessions/${session.data.id}`,{pieceCount:99,version:3})).status,409);
  stage='own history and unchanged Visit validation';
  assert.ok((await http('GET','/me/visits')).data.items.some(row=>row.id===visit.data.id));
  assert.ok((await http('GET','/me/sessions')).data.items.some(row=>row.id===session.data.id&&row.pieceCount===12));
  const row=await prisma.visit.findUnique({where:{id:visit.data.id}});assert.equal(row.status,'PENDING');assert.equal(row.verifiedAt,null);
  assert.equal(await prisma.visitCheckInEvidence.count({where:{visitId:visit.data.id}}),1);
  stage='immediate completion using database clock';
  const immediateLocation=await fixture.location(),immediateCode=await fixture.code(immediateLocation.id);
  const immediateVisit=await http('POST','/check-ins',{locationId:immediateLocation.id,token:immediateCode.token,idempotencyKey:randomUUID()});assert.equal(immediateVisit.status,201);
  const immediateSession=await http('POST',`/visits/${immediateVisit.data.id}/session`,{});assert.equal(immediateSession.status,201);
  assert.equal((await http('POST',`/sessions/${immediateSession.data.id}/complete`,{version:1})).status,200);
  console.log('Real Supabase Auth -> NestJS -> PostgreSQL: check-in, retry, session, absolute count, CAS 409, completion and histories verified.');
  console.log('GET /health and /me: HTTP 200. Visit remains PENDING; no rewards or automatic validation.');
} catch(error){
  const status=error?.actual;
  console.error(`Phase 3 live verification failed at: ${stage}${Number.isInteger(status)?` (status ${status})`:''}.`);
  process.exitCode=1;
} finally {
  try {
    if(fixture){await fixture.cleanup();console.log('Only this test restaurant and its visits/codes/sessions removed. Existing Auth identity and profile preserved.');}
  } catch {console.error('Test fixture cleanup needs review.');process.exitCode=1;}
  if(app) await app.close();
  if(accessToken&&authUrl&&publishableKey){
    try {
      const response=await fetch(`${authUrl}/logout?scope=local`,{method:'POST',headers:{apikey:publishableKey,Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!response.ok) throw new Error('Sign out failed');
      console.log('Test Auth session signed out; tokens not saved; NestJS server closed.');
    } catch {console.error('Test Auth session sign-out was not confirmed.');process.exitCode=1;}
  }
  accessToken=undefined;
}
