import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { developmentClient } from '../scripts/development-database.mjs';

const tables = ['users', 'restaurants', 'restaurant_locations', 'merchant_memberships', 'merchant_membership_locations'];
const scopeConstraints = 'public.merchant_memberships_scope, public.merchant_membership_locations_scope';

test('Phase 1: real PostgreSQL catalog and transactional integrity (development only)', async (t) => {
  const db = developmentClient();
  await db.connect();
  const query = (text, values) => db.query(text, values);
  try {
    await t.test('five tables, RLS and no client policies', async () => {
      const { rows } = await query(`SELECT c.relname, c.relrowsecurity,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname`, [tables]);
      assert.equal(rows.length, 5);
      assert.ok(rows.every((r) => r.relrowsecurity && r.policies === 0));
    });
    await t.test('all columns, types, lengths and nullability match v1.1', async () => {
      const expected = {
        users: ['id:uuid!', 'display_name:character varying(100)!', 'avatar_url:text', 'date_of_birth:date', 'locale:character varying(10)!', 'time_zone:character varying(50)!', 'status:user_status!', 'marketing_consent_at:timestamp(6) with time zone', 'created_at:timestamp(6) with time zone!', 'updated_at:timestamp(6) with time zone!', 'deleted_at:timestamp(6) with time zone'],
        restaurants: ['id:uuid!', 'name:character varying(120)!', 'slug:character varying(120)!', 'legal_name:character varying(160)', 'tax_id:character varying(40)', 'website_url:text', 'status:restaurant_status!', 'created_at:timestamp(6) with time zone!', 'updated_at:timestamp(6) with time zone!'],
        restaurant_locations: ['id:uuid!', 'restaurant_id:uuid!', 'name:character varying(120)!', 'slug:character varying(120)!', 'address_line_1:character varying(160)!', 'address_line_2:character varying(160)', 'city:character varying(100)!', 'region:character varying(100)!', 'postal_code:character varying(20)', 'country_code:character(2)!', 'latitude:numeric(9,6)', 'longitude:numeric(9,6)', 'time_zone:character varying(50)!', 'phone:character varying(30)', 'status:location_status!', 'created_at:timestamp(6) with time zone!', 'updated_at:timestamp(6) with time zone!'],
        merchant_memberships: ['id:uuid!', 'user_id:uuid!', 'restaurant_id:uuid!', 'role:merchant_role!', 'status:membership_status!', 'created_at:timestamp(6) with time zone!', 'updated_at:timestamp(6) with time zone!', 'scope_type:membership_scope_type!', 'invited_by_user_id:uuid', 'invited_at:timestamp(6) with time zone!', 'accepted_at:timestamp(6) with time zone'],
        merchant_membership_locations: ['membership_id:uuid!', 'location_id:uuid!'],
      };
      const { rows } = await query(`SELECT c.relname, a.attname,
        format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`, [tables]);
      for (const table of tables) {
        assert.deepEqual(rows.filter((r) => r.relname === table)
          .map((r) => `${r.attname}:${r.type}${r.attnotnull ? '!' : ''}`), expected[table]);
      }
    });
    await t.test('six enums and exact values', async () => {
      const expected = {
        user_status: ['ACTIVE','BLOCKED','DELETED'], restaurant_status: ['ACTIVE','INACTIVE','ARCHIVED'],
        location_status: ['ACTIVE','INACTIVE','ARCHIVED'], merchant_role: ['OWNER','ADMIN','MANAGER','STAFF','ANALYST'],
        membership_status: ['INVITED','ACTIVE','SUSPENDED','REVOKED'], membership_scope_type: ['ALL_LOCATIONS','SELECTED_LOCATIONS'],
      };
      const { rows } = await query(`SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
        FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname='public' AND t.typname=ANY($1) GROUP BY t.typname`, [Object.keys(expected)]);
      assert.deepEqual(Object.fromEntries(rows.map((r) => [r.typname, r.values])), expected);
    });
    await t.test('PKs, seven validated RESTRICT FKs, CHECK and deferred triggers', async () => {
      const { rows } = await query(`SELECT conname, contype, convalidated, confdeltype, confupdtype,
        condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=ANY($1::regclass[])`, [tables.map((v) => `public.${v}`)]);
      assert.equal(rows.filter((r) => r.contype === 'p').length, 5);
      const fks = rows.filter((r) => r.contype === 'f');
      assert.equal(fks.length, 7);
      assert.ok(fks.every((r) => r.convalidated && r.confdeltype === 'r' && r.confupdtype === 'r'));
      assert.match(rows.find((r) => r.conname === 'users_auth_user_fkey').definition, /REFERENCES auth.users\(id\)/);
      assert.match(rows.find((r) => r.conname === 'merchant_membership_locations_pkey').definition, /PRIMARY KEY \(membership_id, location_id\)/);
      assert.ok(rows.some((r) => r.conname === 'merchant_memberships_active_accepted_check' && r.contype === 'c'));
      const scopes = rows.filter((r) => ['merchant_memberships_scope','merchant_membership_locations_scope'].includes(r.conname));
      assert.equal(scopes.length, 2);
      assert.ok(scopes.every((r) => r.condeferrable && r.condeferred));
      const triggers = await query(`SELECT count(*)::int AS count FROM pg_trigger
        WHERE tgrelid=ANY($1::regclass[]) AND NOT tgisinternal`, [tables.map((v) => `public.${v}`)]);
      assert.equal(triggers.rows[0].count, 10);
    });
    await t.test('exact recommended indexes without redundant copies', async () => {
      const { rows } = await query(`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename=ANY($1)`, [tables]);
      assert.equal(rows.length, 10); // Five PK indexes, three UNIQUE, two lookup indexes.
      const check = (name, suffix) => assert.ok(rows.find((r) => r.indexname === name)?.indexdef.endsWith(suffix));
      check('restaurants_slug_key', '(slug)');
      check('restaurant_locations_restaurant_id_slug_key', '(restaurant_id, slug)');
      check('merchant_memberships_user_id_restaurant_id_key', '(user_id, restaurant_id)');
      check('merchant_memberships_restaurant_id_status_idx', '(restaurant_id, status)');
      check('merchant_membership_locations_location_id_membership_id_idx', '(location_id, membership_id)');
      assert.equal(rows.filter((r) => r.indexdef.includes('UNIQUE INDEX')).length, 8);
    });

    // The development Auth project can be empty. Only the public->Auth FK is
    // explicitly deferred for synthetic profiles; it remains fully enabled.
    // Force every scope check by name, then roll back ALL fixture data. No Auth
    // writes, disabled triggers, committed fake identities or business data.
    await query('BEGIN');
    await query('SET LOCAL lock_timeout = \'5s\'');
    await query('SET CONSTRAINTS public.users_auth_user_fkey DEFERRED');
    const [u1,u2,r1,r2,l1,l2,l3,m1,m2] = Array.from({length:9}, () => randomUUID());
    for (const id of [u1,u2]) {
      await query(`INSERT INTO public.users(id,display_name,locale,time_zone,status)
        VALUES($1,'Integration fixture','es-AR','America/Argentina/Buenos_Aires','ACTIVE')`, [id]);
    }
    for (const id of [r1,r2]) {
      await query(`INSERT INTO public.restaurants(id,name,slug,status) VALUES($1::uuid,'Fixture',$1::text,'ACTIVE')`, [id]);
    }
    for (const [id, restaurant] of [[l1,r1],[l2,r1],[l3,r2]]) {
      await query(`INSERT INTO public.restaurant_locations(id,restaurant_id,name,slug,address_line_1,city,region,country_code,time_zone,status)
        VALUES($1::uuid,$2,'Fixture',$1::text,'Fixture','City','Region','AR','America/Argentina/Buenos_Aires','ACTIVE')`, [id,restaurant]);
    }
    const membership = (id, user, restaurant, scope, status='INVITED', accepted=null) => query(`
      INSERT INTO public.merchant_memberships(id,user_id,restaurant_id,role,status,scope_type,invited_at,accepted_at)
      VALUES($1,$2,$3,'OWNER',$4,$5,CURRENT_TIMESTAMP,$6)`, [id,user,restaurant,status,scope,accepted]);
    const link = (owner, location) => query('INSERT INTO public.merchant_membership_locations VALUES($1,$2)', [owner,location]);
    const flush = () => query(`SET CONSTRAINTS ${scopeConstraints} IMMEDIATE`);
    await membership(m1,u1,r1,'SELECTED_LOCATIONS');
    await link(m1,l1);
    await membership(m2,u2,r1,'ALL_LOCATIONS');
    await flush();
    await query(`SET CONSTRAINTS ${scopeConstraints} DEFERRED`);

    async function scenario(name, operation, code, constraint) {
      await t.test(name, async () => {
        await query('SAVEPOINT scenario');
        try {
          const action = async () => { await operation(); await flush(); };
          if (code) {
            await assert.rejects(action, (e) => e.code === code && (!constraint || e.constraint === constraint));
          } else {
            await action();
          }
        } finally {
          await query('ROLLBACK TO SAVEPOINT scenario');
          await query('RELEASE SAVEPOINT scenario');
        }
      });
    }
    await scenario('valid ALL and SELECTED invitation states', async () => {});
    await scenario('Auth FK rejects a profile with no Auth identity',
      () => query('SET CONSTRAINTS public.users_auth_user_fkey IMMEDIATE'), '23503', 'users_auth_user_fkey');
    await scenario('SELECTED invitation cannot be empty',
      () => membership(randomUUID(),u1,r2,'SELECTED_LOCATIONS'), '23514', 'merchant_memberships_scope_check');
    await scenario('ALL cannot have a selection', () => link(m2,l1), '23514', 'merchant_memberships_scope_check');
    await scenario('selection cannot cross restaurants', () => link(m1,l3), '23514', 'merchant_membership_locations_restaurant_check');
    await scenario('last selected location cannot be removed',
      () => query('DELETE FROM public.merchant_membership_locations WHERE membership_id=$1',[m1]), '23514', 'merchant_memberships_scope_check');
    await scenario('association UPDATE validates its new location',
      () => query('UPDATE public.merchant_membership_locations SET location_id=$1 WHERE membership_id=$2',[l3,m1]), '23514', 'merchant_membership_locations_restaurant_check');
    await scenario('association UPDATE also validates its old owner', async () => {
      await query('UPDATE public.merchant_memberships SET scope_type=\'SELECTED_LOCATIONS\' WHERE id=$1',[m2]);
      await query('UPDATE public.merchant_membership_locations SET membership_id=$1 WHERE membership_id=$2',[m2,m1]);
    }, '23514', 'merchant_memberships_scope_check');
    await scenario('SELECTED to ALL can be changed atomically in either order', async () => {
      await query('UPDATE public.merchant_memberships SET scope_type=\'ALL_LOCATIONS\' WHERE id=$1',[m1]);
      await query('DELETE FROM public.merchant_membership_locations WHERE membership_id=$1',[m1]);
    });
    await scenario('ALL to SELECTED can insert selection before changing scope', async () => {
      await link(m2,l2);
      await query('UPDATE public.merchant_memberships SET scope_type=\'SELECTED_LOCATIONS\' WHERE id=$1',[m2]);
    });
    await scenario('a selection can be replaced atomically', async () => {
      await query('DELETE FROM public.merchant_membership_locations WHERE membership_id=$1',[m1]);
      await link(m1,l2);
    });
    await scenario('archiving a selected location preserves its association', async () => {
      await query('UPDATE public.restaurant_locations SET status=\'ARCHIVED\' WHERE id=$1',[l1]);
      assert.equal((await query('SELECT count(*)::int AS count FROM public.merchant_membership_locations WHERE membership_id=$1',[m1])).rows[0].count, 1);
    });
    await scenario('ACTIVE requires accepted_at',
      () => query('UPDATE public.merchant_memberships SET status=\'ACTIVE\' WHERE id=$1',[m1]), '23514', 'merchant_memberships_active_accepted_check');
    await scenario('ACTIVE with accepted_at is valid',
      () => query('UPDATE public.merchant_memberships SET status=\'ACTIVE\', accepted_at=CURRENT_TIMESTAMP WHERE id=$1',[m1]));
    await scenario('membership user is immutable',
      () => query('UPDATE public.merchant_memberships SET user_id=$1 WHERE id=$2',[u2,m1]), '23514', 'merchant_memberships_identity_check');
    await scenario('membership restaurant is immutable',
      () => query('UPDATE public.merchant_memberships SET restaurant_id=$1 WHERE id=$2',[r2,m1]), '23514', 'merchant_memberships_identity_check');
    await scenario('location cannot be reassigned to another restaurant',
      () => query('UPDATE public.restaurant_locations SET restaurant_id=$1 WHERE id=$2',[r2,l1]), '23514', 'restaurant_locations_restaurant_immutable_check');
    await scenario('user + restaurant is unique',
      () => membership(randomUUID(),u1,r1,'ALL_LOCATIONS'), '23505');
    await scenario('bridge composite PK rejects duplicates', () => link(m1,l1), '23505');
    await scenario('restaurant slug is unique',
      () => query('INSERT INTO public.restaurants(id,name,slug,status) VALUES($1,\'Fixture\',$2,\'ACTIVE\')',[randomUUID(),r1]), '23505');
    await scenario('location slug is unique per restaurant',
      () => query('UPDATE public.restaurant_locations SET slug=$1 WHERE id=$2',[l1,l2]), '23505');
    await scenario('referenced location cannot be deleted',
      () => query('DELETE FROM public.restaurant_locations WHERE id=$1',[l1]), '23503');
    await scenario('referenced user cannot be deleted',
      () => query('DELETE FROM public.users WHERE id=$1',[u1]), '23503');
    await scenario('referenced restaurant cannot be deleted',
      () => query('DELETE FROM public.restaurants WHERE id=$1',[r1]), '23503');
    await scenario('selected membership cannot cascade-delete its selections',
      () => query('DELETE FROM public.merchant_memberships WHERE id=$1',[m1]), '23503');
    await scenario('inviter FK requires an existing public User',
      () => query('UPDATE public.merchant_memberships SET invited_by_user_id=$1 WHERE id=$2',[randomUUID(),m1]), '23503');
    await scenario('updated_at maintained for direct SQL', async () => {
      const before = await query('SELECT updated_at FROM public.merchant_memberships WHERE id=$1',[m1]);
      await link(m1,l2);
      const after = await query('SELECT updated_at FROM public.merchant_memberships WHERE id=$1',[m1]);
      assert.ok(after.rows[0].updated_at > before.rows[0].updated_at);
    });
    await scenario('TRUNCATE cannot bypass final scope checks',
      () => query('TRUNCATE public.merchant_membership_locations'), '0A000');
    await query('ROLLBACK');
    await t.test('fixtures were rolled back', async () => {
      assert.equal((await query('SELECT count(*)::int AS count FROM public.users WHERE id=ANY($1)',[[u1,u2]])).rows[0].count, 0);
      assert.equal((await query('SELECT count(*)::int AS count FROM public.restaurants WHERE id=ANY($1)',[[r1,r2]])).rows[0].count, 0);
    });
  } finally {
    await query('ROLLBACK');
    await db.end();
  }
});
