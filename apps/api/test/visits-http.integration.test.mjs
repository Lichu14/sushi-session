import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Test} from '@nestjs/testing';
import {AppModule} from '../dist/app.module.js';
import {PrismaService} from '../dist/prisma/prisma.service.js';
import {SupabaseJwtService} from '../dist/auth/supabase-jwt.service.js';
import {AuthProfileService} from '../dist/auth/auth-profile.service.js';
import {authFixture} from './helpers/auth-fixture.mjs';
import {visitFixture} from './helpers/visit-fixture.mjs';
import {developmentConnection,developmentClient} from '../scripts/development-database.mjs';

test('Phase 3 HTTP: real NestJS, Prisma, PostgreSQL and concurrent requests; signed Auth fixture',async(t)=>{
  developmentConnection();
  const auth=await authFixture();
  const module=await Test.createTestingModule({imports:[AppModule]})
    .overrideProvider(SupabaseJwtService).useValue(new SupabaseJwtService(auth.config,auth.authFetch))
    .overrideProvider(AuthProfileService).useFactory({inject:[PrismaService],factory:(prisma)=>{
      const actual=new AuthProfileService(prisma);
      return {getOrCreate:identity=>identity.id===auth.userId
        // This second identity tests denied access only; never written to Auth or public.users.
        ? Promise.resolve({id:auth.userId,status:'ACTIVE',deletedAt:null}) : actual.getOrCreate(identity)};
    }}).compile();
  const app=module.createNestApplication({logger:false});
  let f;
  const prisma=app.get(PrismaService);
  try {
    await app.listen(0,'127.0.0.1');
    const base=await app.getUrl();
    const profile=await prisma.user.findFirst({where:{status:'ACTIVE',deletedAt:null}});
    assert.ok(profile,'An existing development Auth/public profile from phase 2 is required.');
    const token=await auth.sign({sub:profile.id});const other=await auth.sign();
    f=await visitFixture(prisma);
    const l=await f.location(), l2=await f.location();const qr=await f.code(l.id);
    const input={locationId:l.id,token:qr.token,idempotencyKey:randomUUID()};
    const http=async(method,path,body,access=token)=>{
      const response=await fetch(base+path,{method,headers:{...(access?{Authorization:`Bearer ${access}`} : {}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
      return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control')};
    };
    const post=(path,body,access)=>http('POST',path,body,access);
    let visit,session;
    await t.test('all six routes require authentication; health stays public',async()=>{
      for(const [method,path,body] of [['POST','/check-ins',input],['POST',`/visits/${randomUUID()}/session`,{}],['PATCH',`/sessions/${randomUUID()}`,{pieceCount:2,version:1}],['POST',`/sessions/${randomUUID()}/complete`,{version:1}],['GET','/me/visits'],['GET','/me/sessions']]) {
        assert.equal((await http(method,path,body,null)).status,401);
        assert.equal((await http(method,path,body,'invalid')).status,401);
      }
      assert.deepEqual((await http('GET','/health',undefined,null)).data,{status:'ok'});
      assert.equal((await http('GET','/me')).data.id,profile.id);
    });
    await t.test('duplicate simultaneous check-ins produce one Visit and one evidence',async()=>{
      const responses=await Promise.all(Array.from({length:4},()=>post('/check-ins',input)));
      assert.ok(responses.every(r=>r.status===201),JSON.stringify(responses.map(r=>({status:r.status,message:r.data.message}))));
      visit=responses[0].data;assert.ok(responses.every(r=>r.data.id===visit.id));
      assert.equal(visit.userId,profile.id);assert.equal(visit.status,'PENDING');assert.equal(visit.source,'QR');assert.equal(visit.verifiedAt,null);
      assert.equal(await prisma.visit.count({where:{idempotencyKey:input.idempotencyKey}}),1);
      assert.equal(await prisma.visitCheckInEvidence.count({where:{checkInCodeId:qr.row.id}}),1);
      assert.equal(await prisma.sushiSession.count({where:{visitId:visit.id}}),0);
      assert.equal('tokenHash' in visit,false);assert.equal('evidence' in visit,false);assert.equal(responses[0].cache,'no-store');
    });
    await t.test('a reused key with different payload or owner gets 409',async()=>{
      for(const changed of [{locationId:l2.id},{token:'different-token'}]) assert.equal((await post('/check-ins',{...input,...changed})).status,409);
      assert.equal((await post('/check-ins',input,other)).status,409);
    });
    await t.test('different keys inside the four-hour window get 409 without extra uses',async()=>{
      const responses=await Promise.all(Array.from({length:3},()=>post('/check-ins',{...input,idempotencyKey:randomUUID()})));
      assert.ok(responses.every(r=>r.status===409));
      assert.equal(await prisma.visitCheckInEvidence.count({where:{checkInCodeId:qr.row.id}}),1);
      assert.equal((await prisma.visit.findUnique({where:{id:visit.id}})).checkedInAt.toISOString(),visit.checkedInAt);
    });
    await t.test('invalid, revoked, expired, future and exhausted codes are rejected',async()=>{
      assert.equal((await post('/check-ins',{...input,token:'unknown',idempotencyKey:randomUUID()})).status,400);
      for(const data of [{status:'REVOKED',revokedAt:new Date()},{status:'EXPIRED'},{validFrom:new Date(Date.now()-120000),validUntil:new Date(Date.now()-60000)},{validFrom:new Date(Date.now()+60000)}]){
        const code=await f.code(l2.id,data);
        assert.equal((await post('/check-ins',{locationId:l2.id,token:code.token,idempotencyKey:randomUUID()})).status,400);
      }
      const one=await f.code(l2.id,{mode:'ONE_TIME',maxUses:1,validUntil:new Date(Date.now()+60000)});
      const body={locationId:l2.id,token:one.token,idempotencyKey:randomUUID()};
      assert.equal((await post('/check-ins',body)).status,201);
      assert.equal((await post('/check-ins',{...body,idempotencyKey:randomUUID()})).status,400);
      assert.equal((await post('/check-ins',body)).status,201,'idempotent retry of exhausted code must succeed');
    });
    await t.test('QR of another location is rejected with no Visit',async()=>{
      const body={...input,locationId:l2.id,idempotencyKey:randomUUID()};
      assert.equal((await post('/check-ins',body)).status,400);
      assert.equal(await prisma.visit.count({where:{idempotencyKey:body.idempotencyKey}}),0);
    });
    await t.test('retry succeeds after revocation without changing evidence or timestamps',async()=>{
      const before=await prisma.visitCheckInEvidence.findUnique({where:{visitId:visit.id}});
      await prisma.checkInCode.update({where:{id:qr.row.id},data:{status:'REVOKED',revokedAt:new Date()}});
      assert.deepEqual((await post('/check-ins',input)).data,visit);
      assert.deepEqual(await prisma.visitCheckInEvidence.findUnique({where:{visitId:visit.id}}),before);
    });
    await t.test('userId and client-controlled server fields are rejected',async()=>{
      for(const field of ['userId','status','source','checkedInAt','verifiedAt']) assert.equal((await post('/check-ins',{...input,[field]:profile.id})).status,400);
      assert.equal((await post(`/visits/${visit.id}/session`,{userId:profile.id})).status,400);
      assert.equal((await http('GET',`/me/visits?userId=${profile.id}`)).status,400);
      assert.equal((await http('GET',`/me/sessions?userId=${profile.id}`)).status,400);
    });
    await t.test('other user cannot create session for a Visit; invalid UUID gives 400',async()=>{
      assert.equal((await post(`/visits/${visit.id}/session`,{},other)).status,404);
      assert.equal((await post('/visits/not-a-uuid/session',{})).status,400);
    });
    await t.test('concurrent starts produce one session and one 409',async()=>{
      const responses=await Promise.all([post(`/visits/${visit.id}/session`,{}),post(`/visits/${visit.id}/session`,{})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
      session=responses.find(r=>r.status===201).data;
      assert.equal(session.version,1);assert.equal(session.pieceCount,0);assert.equal(session.entryMode,'TAP');assert.equal(session.endedAt,null);
      assert.equal(await prisma.sushiSession.count({where:{visitId:visit.id}}),1);
    });
    await t.test('other user cannot read or mutate private visits, sessions or cursors',async()=>{
      assert.equal((await http('PATCH',`/sessions/${session.id}`,{pieceCount:6,version:1},other)).status,404);
      assert.equal((await post(`/sessions/${session.id}/complete`,{version:1},other)).status,404);
      for(const [kind,id] of [['visits',visit.id],['sessions',session.id]]){
        assert.deepEqual((await http('GET',`/me/${kind}`,undefined,other)).data.items,[]);
        assert.equal((await http('GET',`/me/${kind}?cursor=${id}`,undefined,other)).status,404);
      }
    });
    await t.test('pieceCount is a validated absolute integer; version is mandatory',async()=>{
      for(const value of [-1,1001,1.5,'2',null]) assert.equal((await http('PATCH',`/sessions/${session.id}`,{pieceCount:value,version:1})).status,400);
      for(const body of [{pieceCount:2},{pieceCount:2,version:0},{pieceCount:2,version:'1'},{increment:2,version:1},{pieceCount:2,version:1,userId:profile.id},{pieceCount:2,version:1,endedAt:new Date().toISOString()}]) assert.equal((await http('PATCH',`/sessions/${session.id}`,body)).status,400);
      const set=await http('PATCH',`/sessions/${session.id}`,{pieceCount:7,version:1});assert.equal(set.status,200);assert.equal(set.data.pieceCount,7);assert.equal(set.data.version,2);
      const lower=await http('PATCH',`/sessions/${session.id}`,{pieceCount:3,version:2});assert.equal(lower.status,200);assert.equal(lower.data.pieceCount,3);assert.equal(lower.data.version,3);
    });
    await t.test('two writes with same expected version produce one 200 and one 409',async()=>{
      const results=await Promise.all([http('PATCH',`/sessions/${session.id}`,{pieceCount:10,version:3}),http('PATCH',`/sessions/${session.id}`,{pieceCount:20,version:3})]);
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      session=results.find(r=>r.status===200).data;assert.equal(session.version,4);assert.ok([10,20].includes(session.pieceCount));
      assert.equal((await http('PATCH',`/sessions/${session.id}`,{pieceCount:30,version:3})).status,409);
    });
    await t.test('complete uses CAS and server timestamp; no count-based verification',async()=>{
      assert.equal((await post(`/sessions/${session.id}/complete`,{version:3})).status,409);
      assert.equal((await post(`/sessions/${session.id}/complete`,{version:4,endedAt:'2000-01-01'})).status,400);
      const close=await post(`/sessions/${session.id}/complete`,{version:4});assert.equal(close.status,200);assert.equal(close.data.status,'COMPLETED');assert.equal(close.data.version,5);assert.equal(close.data.pieceCount,session.pieceCount);
      assert.ok(new Date(close.data.endedAt)>=new Date(close.data.startedAt));
      session=close.data;
      const row=await prisma.visit.findUnique({where:{id:visit.id}});assert.equal(row.status,'PENDING');assert.equal(row.verifiedAt,null);assert.equal(row.checkedOutAt,null);
    });
    await t.test('completed session rejects edits, repeated closure and replacement',async()=>{
      assert.equal((await http('PATCH',`/sessions/${session.id}`,{pieceCount:100,version:5})).status,409);
      assert.equal((await post(`/sessions/${session.id}/complete`,{version:5})).status,409);
      assert.equal((await post(`/visits/${visit.id}/session`,{})).status,409);
      assert.equal((await prisma.sushiSession.findUnique({where:{id:session.id}})).endedAt.toISOString(),session.endedAt);
    });
    await t.test('a different key after four hours can create a new Visit',async()=>{
      const location=await f.location(),code=await f.code(location.id);
      const body={locationId:location.id,token:code.token,idempotencyKey:randomUUID()};
      const first=await post('/check-ins',body);assert.equal(first.status,201);
      await prisma.$executeRaw`UPDATE public.visits SET checked_in_at=clock_timestamp()-interval '4 hours 1 second' WHERE id=${first.data.id}::uuid`;
      const second=await post('/check-ins',{...body,idempotencyKey:randomUUID()});assert.equal(second.status,201);assert.notEqual(second.data.id,first.data.id);
    });
    await t.test('different keys racing at a fresh location cannot bypass four-hour window',async()=>{
      const location=await f.location(),code=await f.code(location.id);
      const replies=await Promise.all(Array.from({length:3},()=>post('/check-ins',{locationId:location.id,token:code.token,idempotencyKey:randomUUID()})));
      assert.deepEqual(replies.map(r=>r.status).sort(),[201,409,409]);
      assert.equal(await prisma.visitCheckInEvidence.count({where:{checkInCodeId:code.row.id}}),1);
    });
    await t.test('code capacity is serialized across independent PostgreSQL transactions',async()=>{
      const location=await f.location(),code=await f.code(location.id,{mode:'ONE_TIME',maxUses:1,validUntil:new Date(Date.now()+60000)});
      const a=developmentClient(),b=developmentClient();await a.connect();await b.connect();
      try {
        const va=randomUUID(),vb=randomUUID();
        for(const [db,id] of [[a,va],[b,vb]]){
          await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");
          await db.query(`INSERT INTO public.visits(id,user_id,location_id,source,status,checked_in_at,idempotency_key) VALUES($1::uuid,$2,$3,'QR','PENDING',clock_timestamp(),$1::text)`,[id,profile.id,location.id]);
        }
        const evidence=(db,id)=>db.query('INSERT INTO public.visit_check_in_evidence VALUES($1,$2,clock_timestamp())',[id,code.row.id]);
        await evidence(a,va);
        const blocked=evidence(b,vb).then(()=>({ok:true}),error=>({ok:false,code:error.code,constraint:error.constraint}));
        await a.query('COMMIT');
        assert.deepEqual(await blocked,{ok:false,code:'23514',constraint:'check_in_codes_capacity_check'});
        await b.query('ROLLBACK');
        assert.equal(await prisma.visitCheckInEvidence.count({where:{checkInCodeId:code.row.id}}),1);
      } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');await a.end();await b.end();}
    });
    await t.test('history is private, bounded, ordered and paginated without duplicates',async()=>{
      const seen=[];let cursor;
      do {
        const result=await http('GET','/me/visits?limit=2'+(cursor?`&cursor=${cursor}`:''));assert.equal(result.status,200);assert.equal(result.cache,'no-store');
        for(const row of result.data.items){assert.equal(row.userId,profile.id);seen.push(row.id);}
        cursor=result.data.nextCursor;
      } while(cursor);
      assert.equal(new Set(seen).size,seen.length);assert.ok(seen.includes(visit.id));
      const sessions=await http('GET','/me/sessions');assert.equal(sessions.status,200);assert.ok(sessions.data.items.some(r=>r.id===session.id&&r.status==='COMPLETED'));
      for(const suffix of ['limit=0','limit=101','limit=2.5','limit=1&limit=2','cursor=bad']) assert.equal((await http('GET',`/me/visits?${suffix}`)).status,400);
    });
  } finally {
    try {if(f) await f.cleanup();} finally {await app.close();}
  }
});
