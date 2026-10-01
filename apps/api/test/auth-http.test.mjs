import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../dist/auth/auth.module.js';
import { AUTH_FETCH } from '../dist/auth/supabase-jwt.service.js';
import { AuthProfileService } from '../dist/auth/auth-profile.service.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { Prisma } from '../dist/generated/prisma/client.js';
import { HealthController } from '../dist/health.controller.js';
import { authFixture } from './helpers/auth-fixture.mjs';

test('Auth HTTP: real Nest guard/controller and signed JWTs, isolated persistence double', async (t) => {
  const f = await authFixture();
  const profiles = new Map();
  let inserts = 0;
  let reads = 0;
  const prisma = {user:{
    findUnique: async ({where}) => {reads++; return profiles.get(where.id) ?? null;},
    createMany: async ({data,skipDuplicates}) => {
      assert.equal(skipDuplicates,true);
      assert.deepEqual(Object.keys(data).sort(), ['displayName','id','locale','status','timeZone']);
      if(profiles.has(data.id)) return {count:0};
      inserts++;
      profiles.set(data.id, { ...data, avatarUrl:null, dateOfBirth:null, marketingConsentAt:null,
        createdAt:new Date(), updatedAt:new Date(), deletedAt:null });
      return {count:1};
    },
  }};
  const module = await Test.createTestingModule({
    imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,ignoreEnvVars:true}), AuthModule],
    controllers:[HealthController],
  }).overrideProvider(ConfigService).useValue(f.config)
    .overrideProvider(AUTH_FETCH).useValue(f.authFetch)
    .overrideProvider(PrismaService).useValue(prisma)
    .compile();
  const app=module.createNestApplication({logger:false});
  await app.listen(0,'127.0.0.1');
  const base=await app.getUrl();
  const token=await f.sign({ user_metadata:{id:randomUUID(),role:'OWNER',status:'ACTIVE'} });
  const get=(path='/me',authorization) => fetch(`${base}${path}`,{headers:authorization?{Authorization:authorization}:{}});
  try {
    await t.test('missing token gets 401, including a client-supplied userId or access_token', async () => {
      for(const path of ['/me',`/me?userId=${f.userId}`,`/me?access_token=${token}`]) {
        assert.equal((await get(path)).status,401);
      }
      assert.equal(reads,0);
      assert.equal(f.state.authCalls,0);
    });
    await t.test('invalid token or Bearer header gets 401 with no provisioning', async () => {
      for(const value of ['Basic example','Bearer invalid','Bearer one two','Bearer one,Bearer two']) {
        const response=await get('/me',value);
        assert.equal(response.status,401);
        assert.equal((await response.text()).includes(value),false);
      }
      assert.equal(inserts,0);
    });
    await t.test('duplicate Authorization headers get 401', async () => {
      const status=await new Promise((resolve,reject)=>{
        const req=request(`${base}/me`,{headers:{Authorization:[`Bearer ${token}`,`Bearer ${token}`]}},res=>{
          res.resume();res.on('end',()=>resolve(res.statusCode));
        });
        req.on('error',reject);req.end();
      });
      assert.equal(status,401);
    });
    await t.test('valid token provisions the exact Auth UUID and returns only public profile', async () => {
      const response=await get(`/me?userId=${randomUUID()}`,`Bearer ${token}`);
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      const profile=await response.json();
      assert.equal(profile.id,f.userId);
      assert.equal(profile.displayName,'Usuario');
      assert.equal(profile.locale,'es-AR');
      assert.equal(profile.timeZone,'UTC');
      assert.equal(profile.status,'ACTIVE');
      for(const forbidden of ['access_token','refresh_token','password','email','user_metadata','role','sessionId']) {
        assert.equal(forbidden in profile,false);
      }
      assert.equal(inserts,1);
    });
    await t.test('repeated authentication preserves profile preferences and timestamps', async () => {
      const row=profiles.get(f.userId);
      row.displayName='Nombre elegido';row.locale='en-US';row.timeZone='Europe/Madrid';
      const before=row.updatedAt.toISOString();
      const response=await get('/me',`Bearer ${token}`);
      assert.equal(response.status,200);
      const profile=await response.json();
      assert.equal(profile.displayName,'Nombre elegido');
      assert.equal(profile.locale,'en-US');
      assert.equal(profile.updatedAt,before);
      assert.equal(inserts,1);
    });
    await t.test('BLOCKED/DELETED profiles cannot be reactivated by metadata or login', async () => {
      const row=profiles.get(f.userId);
      for(const status of ['BLOCKED','DELETED']) {
        row.status=status;
        assert.equal((await get('/me',`Bearer ${token}`)).status,403);
        assert.equal(row.status,status);
      }
      row.status='ACTIVE';row.deletedAt=new Date();
      assert.equal((await get('/me',`Bearer ${token}`)).status,403);
      row.deletedAt=null;
    });
    await t.test('another verified identity obtains its own profile', async () => {
      const otherId=randomUUID();
      const other=await f.sign({sub:otherId});
      const response=await get(`/me?userId=${f.userId}`,`Bearer ${other}`);
      assert.equal(response.status,200);
      assert.equal((await response.json()).id,otherId);
    });
    await t.test('Auth outage returns 503; health remains public and available', async () => {
      f.state.authStatus=503;
      assert.equal((await get('/me',`Bearer ${token}`)).status,503);
      const health=await get('/health');
      assert.equal(health.status,200);
      assert.deepEqual(await health.json(),{status:'ok'});
      f.state.authStatus=200;
    });
    await t.test('database failure returns a generic 503 with no internal details', async () => {
      const service=new AuthProfileService({user:{findUnique:async()=>{throw new Error('sensitive database detail');}}});
      await assert.rejects(()=>service.getOrCreate({id:f.userId,sessionId:f.sessionId}),e=>
        e.getStatus()===503 && !e.message.includes('sensitive'));
    });
    await t.test('Auth FK handles identity removal during provisioning', async () => {
      const service=new AuthProfileService({user:{findUnique:async()=>null,createMany:async()=>{
        throw new Prisma.PrismaClientKnownRequestError('FK',{code:'P2003',clientVersion:'7.10.0'});
      }}});
      await assert.rejects(()=>service.getOrCreate({id:f.userId,sessionId:f.sessionId}),e=>e.getStatus()===401);
    });
  } finally {await app.close();}
});
