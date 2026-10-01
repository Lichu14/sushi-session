import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import test from 'node:test';
import {developmentClient} from '../scripts/development-database.mjs';

const tables=['check_in_codes','visits','visit_check_in_evidence','sushi_sessions'];
const constraints='public.visits_evidence, public.visit_check_in_evidence_consistency';

test('Phase 3: real PostgreSQL contract and deferred integrity; all fixtures rolled back',async(t)=>{
  const db=developmentClient();await db.connect();
  const query=(sql,values)=>db.query(sql,values);
  const flush=()=>query(`SET CONSTRAINTS ${constraints} IMMEDIATE`);
  try {
    await t.test('exact columns, types, optionality and defaults',async()=>{
      const expected={
        check_in_codes:['id:uuid!','location_id:uuid!','label:character varying(80)','token_hash:character(64)!','mode:check_in_code_mode!','valid_from:timestamp(6) with time zone!','valid_until:timestamp(6) with time zone','max_uses:integer','status:check_in_code_status!','created_at:timestamp(6) with time zone!','revoked_at:timestamp(6) with time zone','created_by_membership_id:uuid'],
        visits:['id:uuid!','user_id:uuid!','location_id:uuid!','source:visit_source!','status:visit_status!','checked_in_at:timestamp(6) with time zone!','checked_out_at:timestamp(6) with time zone','verified_at:timestamp(6) with time zone','rejected_reason:character varying(300)','idempotency_key:character varying(120)!','created_at:timestamp(6) with time zone!','updated_at:timestamp(6) with time zone!'],
        visit_check_in_evidence:['visit_id:uuid!','check_in_code_id:uuid!','validated_at:timestamp(6) with time zone!'],
        sushi_sessions:['id:uuid!','visit_id:uuid!','status:session_status!','started_at:timestamp(6) with time zone!','ended_at:timestamp(6) with time zone','piece_count:integer!','entry_mode:session_entry_mode!','notes:character varying(500)','created_at:timestamp(6) with time zone!','updated_at:timestamp(6) with time zone!','version:integer!'],
      };
      const {rows}=await query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[tables]);
      for(const table of tables) assert.deepEqual(rows.filter(r=>r.relname===table).map(r=>`${r.attname}:${r.type}${r.attnotnull?'!':''}`),expected[table]);
      assert.equal((await query(`SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='sushi_sessions' AND column_name='version'`)).rows[0].column_default,'1');
    });
    await t.test('six exact enums',async()=>{
      const expected={check_in_code_mode:['STATIC','ROTATING','ONE_TIME'],check_in_code_status:['ACTIVE','REVOKED','EXPIRED'],visit_source:['QR','MANUAL','IMPORT'],visit_status:['PENDING','VERIFIED','REJECTED','CANCELLED'],session_status:['ACTIVE','COMPLETED','CANCELLED'],session_entry_mode:['TAP','MANUAL']};
      const {rows}=await query(`SELECT t.typname,array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY($1) GROUP BY t.typname`,[Object.keys(expected)]);
      assert.deepEqual(Object.fromEntries(rows.map(r=>[r.typname,r.values])),expected);
    });
    await t.test('PKs, RESTRICT FKs, checks, deferred constraints and exact indexes',async()=>{
      const {rows}=await query(`SELECT conname,contype,convalidated,confdeltype,confupdtype,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[])`,[tables.map(x=>`public.${x}`)]);
      assert.equal(rows.filter(r=>r.contype==='p').length,4);
      const fk=rows.filter(r=>r.contype==='f');assert.equal(fk.length,7);
      assert.ok(fk.every(r=>r.convalidated&&r.confdeltype==='r'&&r.confupdtype==='r'));
      assert.match(rows.find(r=>r.conname==='visit_check_in_evidence_pkey').definition,/PRIMARY KEY \(visit_id\)/);
      assert.match(rows.find(r=>r.conname==='visit_check_in_evidence_visit_id_fkey').definition,/FOREIGN KEY \(visit_id\) REFERENCES visits\(id\)/);
      assert.equal(rows.filter(r=>r.contype==='c').length,11);
      const deferred=rows.filter(r=>r.contype==='t');assert.equal(deferred.length,2);assert.ok(deferred.every(r=>r.condeferrable&&r.condeferred));
      const indexes=(await query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)`,[tables])).rows;
      assert.equal(indexes.length,11);
      for(const [name,suffix] of Object.entries({check_in_codes_token_hash_key:'(token_hash)',check_in_codes_location_id_status_idx:'(location_id, status)',visits_idempotency_key_key:'(idempotency_key)',visits_user_id_checked_in_at_idx:'(user_id, checked_in_at DESC)',visits_location_id_checked_in_at_idx:'(location_id, checked_in_at DESC)',visit_check_in_evidence_check_in_code_id_idx:'(check_in_code_id)',sushi_sessions_visit_id_key:'(visit_id)'})) assert.ok(indexes.find(r=>r.indexname===name)?.indexdef.endsWith(suffix));
      const security=(await query(`SELECT c.relrowsecurity,(SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1)`,[tables])).rows;
      assert.equal(security.length,4);assert.ok(security.every(r=>r.relrowsecurity&&r.policies===0));
    });

    await query('BEGIN');await query('SET CONSTRAINTS public.users_auth_user_fkey DEFERRED');
    const [user,r,l1,l2,code,otherCode,visit,session,membership]=Array.from({length:9},()=>randomUUID());
    await query(`INSERT INTO public.users(id,display_name,locale,time_zone,status) VALUES($1,'Rollback fixture','es-AR','UTC','ACTIVE')`,[user]);
    await query(`INSERT INTO public.restaurants(id,name,slug,status) VALUES($1::uuid,'Rollback fixture',$1::text,'ACTIVE')`,[r]);
    for(const id of [l1,l2]) await query(`INSERT INTO public.restaurant_locations(id,restaurant_id,name,slug,address_line_1,city,region,country_code,time_zone,status) VALUES($1::uuid,$2,'Fixture',$1::text,'Fixture','City','Region','AR','UTC','ACTIVE')`,[id,r]);
    const addCode=(id,location,mode='STATIC',max=null,until=null,status='ACTIVE',creator=null)=>query(`INSERT INTO public.check_in_codes(id,location_id,token_hash,mode,valid_from,valid_until,max_uses,status,created_by_membership_id) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour',$5,$6,$7,$8)`,[id,location,createHash('sha256').update(id).digest('hex'),mode,until,max,status,creator]);
    const addVisit=(id,location=l1,source='QR')=>query(`INSERT INTO public.visits(id,user_id,location_id,source,status,checked_in_at,idempotency_key) VALUES($1::uuid,$2,$3,$4,'PENDING',clock_timestamp(),$1::text)`,[id,user,location,source]);
    const evidence=(v,c=code)=>query(`INSERT INTO public.visit_check_in_evidence(visit_id,check_in_code_id,validated_at) VALUES($1,$2,clock_timestamp())`,[v,c]);
    await addCode(code,l1);await addCode(otherCode,l2);await addVisit(visit);await evidence(visit);await flush();
    await query(`SET CONSTRAINTS ${constraints} DEFERRED`);
    await query(`INSERT INTO public.sushi_sessions(id,visit_id,status,started_at,piece_count,entry_mode) VALUES($1,$2,'ACTIVE',clock_timestamp(),0,'TAP')`,[session,visit]);

    async function scenario(name,operation,errorCode,constraint){
      await t.test(name,async()=>{
        await query('SAVEPOINT scenario');
        try {
          const action=async()=>{await operation();await flush();};
          if(errorCode) await assert.rejects(action,e=>e.code===errorCode&&(!constraint||e.constraint===constraint));
          else await action();
        } finally {await query('ROLLBACK TO scenario');await query('RELEASE scenario');}
      });
    }
    await scenario('QR without evidence fails deferred check',()=>addVisit(randomUUID()),'23514','visits_evidence_source_check');
    for(const source of ['MANUAL','IMPORT']) {
      await scenario(`${source} without evidence is valid`,()=>addVisit(randomUUID(),l1,source));
      await scenario(`${source} with evidence fails`,async()=>{const id=randomUUID();await addVisit(id,l1,source);await evidence(id);},'23514','visits_evidence_source_check');
    }
    await scenario('QR from another location fails at final state',async()=>{const id=randomUUID();await addVisit(id,l2);await evidence(id);},'23514','visits_evidence_location_check');
    await scenario('deleting evidence from QR fails',()=>query('DELETE FROM public.visit_check_in_evidence WHERE visit_id=$1',[visit]),'23514','visits_evidence_source_check');
    await scenario('updating Visit location revalidates evidence',()=>query('UPDATE public.visits SET location_id=$1 WHERE id=$2',[l2,visit]),'23514','visits_evidence_location_check');
    await scenario('updating Visit source revalidates evidence',()=>query("UPDATE public.visits SET source='MANUAL' WHERE id=$1",[visit]),'23514','visits_evidence_source_check');
    await scenario('moving evidence revalidates old Visit',async()=>{const id=randomUUID();await addVisit(id);await query('UPDATE public.visit_check_in_evidence SET visit_id=$1 WHERE visit_id=$2',[id,visit]);},'23514','visits_evidence_source_check');
    await scenario('updating evidence code revalidates location',()=>query('UPDATE public.visit_check_in_evidence SET check_in_code_id=$1 WHERE visit_id=$2',[otherCode,visit]),'23514','visits_evidence_location_check');
    await scenario('source and evidence can change atomically',async()=>{await query("UPDATE public.visits SET source='MANUAL' WHERE id=$1",[visit]);await query('DELETE FROM public.visit_check_in_evidence WHERE visit_id=$1',[visit]);});
    await scenario('duplicate evidence violates shared PK',()=>evidence(visit),'23505');
    await scenario('referenced code cannot be deleted',()=>query('DELETE FROM public.check_in_codes WHERE id=$1',[code]),'23503');
    await scenario('code location is immutable',()=>query('UPDATE public.check_in_codes SET location_id=$1 WHERE id=$2',[l2,code]),'23514','check_in_codes_identity_check');
    await scenario('evidence TRUNCATE cannot bypass constraints',()=>query('TRUNCATE public.visit_check_in_evidence'),'23514','visit_evidence_no_truncate_check');
    await scenario('VERIFIED requires verifiedAt',()=>query("UPDATE public.visits SET status='VERIFIED' WHERE id=$1",[visit]),'23514','visits_verified_at_check');
    await scenario('verification with timestamp is valid',()=>query("UPDATE public.visits SET status='VERIFIED',verified_at=clock_timestamp() WHERE id=$1",[visit]));
    await scenario('duplicate idempotencyKey is rejected',()=>query(`INSERT INTO public.visits(id,user_id,location_id,source,status,checked_in_at,idempotency_key) SELECT $1,user_id,location_id,source,status,checked_in_at,idempotency_key FROM public.visits WHERE id=$2`,[randomUUID(),visit]),'23505');
    for(const mode of ['ROTATING','ONE_TIME']) await scenario(`${mode} requires expiry`,()=>addCode(randomUUID(),l1,mode,1),'23514','check_in_codes_expiry_check');
    await scenario('ONE_TIME requires nonnull maxUses=1',()=>addCode(randomUUID(),l1,'ONE_TIME',null,new Date(Date.now()+60000)),'23514','check_in_codes_one_time_check');
    await scenario('maxUses must be positive',()=>addCode(randomUUID(),l1,'STATIC',0),'23514','check_in_codes_max_uses_check');
    await scenario('expiry must be after validFrom',()=>addCode(randomUUID(),l1,'ROTATING',null,new Date(Date.now()-7200000)),'23514','check_in_codes_window_check');
    for(const status of ['REVOKED','EXPIRED']) await scenario(`${status} cannot accept evidence`,async()=>{const c=randomUUID(),v=randomUUID();await addCode(c,l1,'STATIC',null,null,status);await addVisit(v);await evidence(v,c);},'23514','check_in_codes_usable_check');
    await scenario('exhausted ONE_TIME cannot accept another evidence',async()=>{const c=randomUUID();await addCode(c,l1,'ONE_TIME',1,new Date(Date.now()+60000));for(let i=0;i<2;i++){const v=randomUUID();await addVisit(v);await evidence(v,c);}},'23514','check_in_codes_capacity_check');
    await scenario('creator must cover the location and be active',async()=>{
      await query(`INSERT INTO public.merchant_memberships(id,user_id,restaurant_id,role,status,scope_type,invited_at) VALUES($1,$2,$3,'STAFF','INVITED','ALL_LOCATIONS',clock_timestamp())`,[membership,user,r]);
      await addCode(randomUUID(),l1,'STATIC',null,null,'ACTIVE',membership);
    },'23514','check_in_codes_creator_scope_check');
    await scenario('one session per Visit',()=>query(`INSERT INTO public.sushi_sessions(id,visit_id,status,started_at,piece_count,entry_mode) VALUES($1,$2,'ACTIVE',clock_timestamp(),0,'TAP')`,[randomUUID(),visit]),'23505');
    for(const value of [-1,1001]) await scenario(`pieceCount=${value} rejected`,()=>query('UPDATE public.sushi_sessions SET piece_count=$1,version=version+1 WHERE id=$2',[value,session]),'23514','sushi_sessions_piece_count_check');
    for(const value of [0,1000]) await scenario(`pieceCount=${value} accepted`,()=>query('UPDATE public.sushi_sessions SET piece_count=$1,version=version+1 WHERE id=$2',[value,session]));
    await scenario('every update must advance version exactly once',()=>query('UPDATE public.sushi_sessions SET piece_count=3 WHERE id=$1',[session]),'23514','sushi_sessions_next_version_check');
    await scenario('completion time comes from database and closed count cannot change',async()=>{
      const row=(await query(`UPDATE public.sushi_sessions SET status='COMPLETED',ended_at='2000-01-01',version=version+1 WHERE id=$1 RETURNING *`,[session])).rows[0];
      assert.equal(row.version,2);assert.ok(row.ended_at>=row.started_at);assert.ok(row.ended_at.getFullYear()>2020);
      await query('UPDATE public.sushi_sessions SET piece_count=7,version=version+1 WHERE id=$1',[session]);
    },'23514','sushi_sessions_terminal_check');
    for(const terminal of ['COMPLETED','CANCELLED']) await scenario(`${terminal} cannot return to ACTIVE`,async()=>{
      await query('UPDATE public.sushi_sessions SET status=$1,version=version+1 WHERE id=$2',[terminal,session]);
      await query("UPDATE public.sushi_sessions SET status='ACTIVE',version=version+1 WHERE id=$1",[session]);
    },'23514','sushi_sessions_terminal_check');
  } finally {await query('ROLLBACK');await db.end();}
});
