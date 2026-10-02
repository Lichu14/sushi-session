import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  developmentClient,
  developmentConnection,
} from '../scripts/development-database.mjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

const tables = ['rewards', 'reward_locations', 'reward_rules'];
const scope = 'public.rewards_scope, public.reward_locations_scope';
const preview = process.env.REWARD_SCHEMA_PREVIEW === '1';
const migration = new URL(
  '../prisma/migrations/20261001060000_phase_6a_rewards_and_rules/migration.sql',
  import.meta.url,
);

test('Phase 6A: v1.1 persistence, rollback-only fixtures and client isolation', async (t) => {
  const db = developmentClient();
  await db.connect();
  const query = (sql, values) => db.query(sql, values);
  try {
    await query('BEGIN');
    if (preview) {
      assert.equal(
        (await query("SELECT to_regclass('public.rewards') AS table_name"))
          .rows[0].table_name,
        null,
      );
      const sql = readFileSync(migration, 'utf8').replace(/\r\n/g, '\n');
      assert.ok(sql.startsWith('BEGIN;\n') && /\nCOMMIT;\s*$/.test(sql));
      // Exercise the reviewed migration in this transaction; ALWAYS roll back.
      await query(sql.replace(/^BEGIN;\n/, '').replace(/\nCOMMIT;\s*$/, ''));
    }
    await t.test(
      'exact columns, PostgreSQL types and optionality',
      async () => {
        const expected = {
          rewards: [
            'id:uuid!',
            'restaurant_id:uuid!',
            'name:character varying(120)!',
            'description:text!',
            'reward_type:reward_type!',
            'value:numeric(12,2)',
            'currency:character(3)',
            'item_reference:character varying(100)',
            'terms_text:text!',
            'valid_days_after_issue:smallint',
            'starts_at:timestamp(6) with time zone',
            'ends_at:timestamp(6) with time zone',
            'status:lifecycle_status!',
            'created_at:timestamp(6) with time zone!',
            'updated_at:timestamp(6) with time zone!',
          ],
          reward_locations: ['reward_id:uuid!', 'location_id:uuid!'],
          reward_rules: [
            'id:uuid!',
            'reward_id:uuid!',
            'name:character varying(120)!',
            'metric:rule_metric!',
            'operator:rule_operator!',
            'threshold:integer!',
            'window_days:smallint',
            'min_visit_spacing_hours:smallint!',
            'max_awards_per_user:smallint!',
            'starts_at:timestamp(6) with time zone',
            'ends_at:timestamp(6) with time zone',
            'status:lifecycle_status!',
            'created_at:timestamp(6) with time zone!',
            'updated_at:timestamp(6) with time zone!',
          ],
        };
        const { rows } = await query(
          `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
          [tables],
        );
        for (const table of tables)
          assert.deepEqual(
            rows
              .filter((r) => r.relname === table)
              .map((r) => `${r.attname}:${r.type}${r.attnotnull ? '!' : ''}`),
            expected[table],
          );
      },
    );
    await t.test(
      'four exact enums; no PIECE_COUNT or other operators',
      async () => {
        const expected = {
          reward_type: [
            'FREE_ITEM',
            'PERCENT_DISCOUNT',
            'FIXED_DISCOUNT',
            'CUSTOM',
          ],
          lifecycle_status: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'],
          rule_metric: ['VISIT_COUNT'],
          rule_operator: ['GTE'],
        };
        const { rows } = await query(
          `SELECT t.typname,array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY($1) GROUP BY t.typname`,
          [Object.keys(expected)],
        );
        assert.deepEqual(
          Object.fromEntries(rows.map((r) => [r.typname, r.values])),
          expected,
        );
      },
    );
    await t.test(
      'three PK, four RESTRICT FK, ten CHECK, two deferred triggers and six indexes',
      async () => {
        const { rows } = await query(
          `SELECT conname,contype,convalidated,confdeltype,confupdtype,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[])`,
          [tables.map((x) => `public.${x}`)],
        );
        assert.equal(rows.filter((r) => r.contype === 'p').length, 3);
        const fk = rows.filter((r) => r.contype === 'f');
        assert.equal(fk.length, 4);
        assert.ok(
          fk.every(
            (r) =>
              r.convalidated && r.confdeltype === 'r' && r.confupdtype === 'r',
          ),
        );
        assert.match(
          rows.find((r) => r.conname === 'reward_locations_pkey').definition,
          /PRIMARY KEY \(reward_id, location_id\)/,
        );
        assert.equal(rows.filter((r) => r.contype === 'c').length, 10);
        const deferred = rows.filter((r) => r.contype === 't');
        assert.equal(deferred.length, 2);
        assert.ok(deferred.every((r) => r.condeferrable && r.condeferred));
        const indexes = (
          await query(
            `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)`,
            [tables],
          )
        ).rows;
        assert.equal(indexes.length, 6);
        for (const [name, suffix] of Object.entries({
          rewards_restaurant_id_status_idx: '(restaurant_id, status)',
          reward_locations_location_id_reward_id_idx:
            '(location_id, reward_id)',
          reward_rules_reward_id_status_idx: '(reward_id, status)',
        }))
          assert.ok(
            indexes
              .find((r) => r.indexname === name)
              ?.indexdef.endsWith(suffix),
          );
      },
    );
    await t.test(
      'RLS without policies, no client grants and safe non-public trigger functions',
      async () => {
        const rows = (
          await query(
            `SELECT c.relrowsecurity,(SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1)`,
            [tables],
          )
        ).rows;
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.relrowsecurity && r.policies === 0));
        for (const role of ['anon', 'authenticated']) {
          for (const table of tables) {
            for (const privilege of [
              'SELECT',
              'INSERT',
              'UPDATE',
              'DELETE',
              'TRUNCATE',
              'REFERENCES',
              'TRIGGER',
            ]) {
              assert.equal(
                (
                  await query(
                    'SELECT has_table_privilege($1,$2,$3) AS allowed',
                    [role, `public.${table}`, privilege],
                  )
                ).rows[0].allowed,
                false,
              );
            }
          }
        }
        for (const name of [
          'lock_reward_selection',
          'enforce_reward_scope',
          'reject_reward_selection_truncate',
        ]) {
          const row = (
            await query(
              `SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated FROM pg_proc WHERE oid=$1::regprocedure`,
              [`public.${name}()`],
            )
          ).rows[0];
          assert.equal(row.prosecdef, false);
          assert.deepEqual(row.proconfig, ['search_path=pg_catalog']);
          assert.equal(row.anon, false);
          assert.equal(row.authenticated, false);
        }
      },
    );

    const [r1, r2, l1, l2, l3, reward1, reward2, rule] = Array.from(
      { length: 8 },
      () => randomUUID(),
    );
    for (const r of [r1, r2])
      await query(
        `INSERT INTO public.restaurants(id,name,slug,status) VALUES($1::uuid,'Phase 6A rollback fixture',$1::text,'ACTIVE')`,
        [r],
      );
    const addLocation = (id, restaurant) =>
      query(
        `INSERT INTO public.restaurant_locations(id,restaurant_id,name,slug,address_line_1,city,region,country_code,time_zone,status) VALUES($1::uuid,$2,'Fixture',$1::text,'Fixture','City','Region','AR','UTC','ACTIVE')`,
        [id, restaurant],
      );
    await addLocation(l1, r1);
    await addLocation(l2, r1);
    await addLocation(l3, r2);
    const addReward = (id, restaurant) =>
      query(
        `INSERT INTO public.rewards(id,restaurant_id,name,description,reward_type,terms_text,status) VALUES($1,$2,'Fixture','Fixture description','CUSTOM','Explicit fixture terms','DRAFT')`,
        [id, restaurant],
      );
    await addReward(reward1, r1);
    await addReward(reward2, r2);
    const link = (reward, location) =>
      query('INSERT INTO public.reward_locations VALUES($1,$2)', [
        reward,
        location,
      ]);
    await link(reward1, l1);
    await query(
      `INSERT INTO public.reward_rules(id,reward_id,name,metric,operator,threshold,min_visit_spacing_hours,max_awards_per_user,status) VALUES($1,$2,'Fixture','VISIT_COUNT','GTE',5,4,1,'DRAFT')`,
      [rule, reward1],
    );
    await query(`SET CONSTRAINTS ${scope} IMMEDIATE`);
    await query(`SET CONSTRAINTS ${scope} DEFERRED`);
    const flush = () => query(`SET CONSTRAINTS ${scope} IMMEDIATE`);
    async function scenario(name, operation, code, constraint) {
      await t.test(name, async () => {
        await query('SAVEPOINT scenario');
        try {
          const action = async () => {
            await operation();
            await flush();
          };
          if (code)
            await assert.rejects(
              action,
              (e) =>
                e.code === code && (!constraint || e.constraint === constraint),
            );
          else await action();
        } finally {
          await query('ROLLBACK TO scenario');
          await query('RELEASE scenario');
        }
      });
    }
    const updateReward = (assignment, values = []) =>
      query(`UPDATE public.rewards SET ${assignment} WHERE id=$1`, [
        reward1,
        ...values,
      ]);
    const updateRule = (assignment, values = []) =>
      query(`UPDATE public.reward_rules SET ${assignment} WHERE id=$1`, [
        rule,
        ...values,
      ]);
    await scenario(
      'duplicate association is rejected by composite PK',
      () => link(reward1, l1),
      '23505',
    );
    await scenario(
      'foreign restaurant location INSERT is rejected at final state',
      () => link(reward1, l3),
      '23514',
      'reward_locations_restaurant_check',
    );
    await scenario(
      'changing association location revalidates ownership',
      () =>
        query(
          'UPDATE public.reward_locations SET location_id=$1 WHERE reward_id=$2',
          [l3, reward1],
        ),
      '23514',
      'reward_locations_restaurant_check',
    );
    await scenario(
      'moving association to another reward revalidates both owners',
      () =>
        query(
          'UPDATE public.reward_locations SET reward_id=$1 WHERE reward_id=$2',
          [reward2, reward1],
        ),
      '23514',
      'reward_locations_restaurant_check',
    );
    await scenario(
      'reassigning reward with selections cannot leave invalid membership',
      () => updateReward('restaurant_id=$2', [r2]),
      '23514',
      'reward_locations_restaurant_check',
    );
    await scenario(
      'location owner remains immutable',
      () =>
        query(
          'UPDATE public.restaurant_locations SET restaurant_id=$1 WHERE id=$2',
          [r2, l1],
        ),
      '23514',
      'restaurant_locations_restaurant_immutable_check',
    );
    await scenario(
      'atomic reward owner and selection change validates final state',
      async () => {
        await updateReward('restaurant_id=$2', [r2]);
        await query(
          'UPDATE public.reward_locations SET location_id=$1 WHERE reward_id=$2',
          [l3, reward1],
        );
      },
    );
    await scenario(
      'deleting last association explicitly broadens scope, including future locations',
      async () => {
        await query('DELETE FROM public.reward_locations WHERE reward_id=$1', [
          reward1,
        ]);
        const future = randomUUID();
        await addLocation(future, r1);
        const allowed = await query(
          `SELECT l.id FROM public.restaurant_locations l JOIN public.rewards r ON r.restaurant_id=l.restaurant_id WHERE r.id=$1 AND (NOT EXISTS(SELECT 1 FROM public.reward_locations WHERE reward_id=r.id) OR EXISTS(SELECT 1 FROM public.reward_locations WHERE reward_id=r.id AND location_id=l.id))`,
          [reward1],
        );
        assert.deepEqual(
          allowed.rows.map((r) => r.id).sort(),
          [l1, l2, future].sort(),
        );
      },
    );
    await scenario(
      'archiving location preserves its explicit selection',
      async () => {
        await query(
          "UPDATE public.restaurant_locations SET status='ARCHIVED' WHERE id=$1",
          [l1],
        );
        assert.equal(
          (
            await query(
              'SELECT count(*)::int AS n FROM public.reward_locations WHERE reward_id=$1',
              [reward1],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    for (const [name, sql, id] of [
      ['selected location', 'restaurant_locations', l1],
      ['reward with dependents', 'rewards', reward1],
      ['restaurant with history', 'restaurants', r1],
    ]) {
      await scenario(
        `RESTRICT prevents deletion of ${name}`,
        () => query(`DELETE FROM public.${sql} WHERE id=$1`, [id]),
        '23503',
      );
    }
    await scenario(
      'TRUNCATE cannot silently broaden all scopes',
      () => query('TRUNCATE public.reward_locations'),
      '0A000',
    );
    await scenario(
      'missing reward FK is rejected',
      () => updateRule('reward_id=$2', [randomUUID()]),
      '23503',
    );
    for (const [name, assignment] of [
      [
        'percent minimum precision',
        "reward_type='PERCENT_DISCOUNT',value=0.01,currency=NULL",
      ],
      [
        'percent maximum',
        "reward_type='PERCENT_DISCOUNT',value=100,currency=NULL",
      ],
      [
        'fixed amount',
        "reward_type='FIXED_DISCOUNT',value=12.34,currency='ARS'",
      ],
      ['free item', "reward_type='FREE_ITEM',item_reference='sku-fixture'"],
      [
        'custom explicit terms',
        "reward_type='CUSTOM',terms_text='Defined benefit terms'",
      ],
    ])
      await scenario(`valid ${name}`, () => updateReward(assignment));
    for (const assignment of [
      "reward_type='PERCENT_DISCOUNT',value=NULL",
      "reward_type='PERCENT_DISCOUNT',value=0",
      "reward_type='PERCENT_DISCOUNT',value=-1",
      "reward_type='PERCENT_DISCOUNT',value=100.01",
      "reward_type='PERCENT_DISCOUNT',value=15,currency='ARS'",
      "reward_type='FIXED_DISCOUNT',value=NULL,currency='ARS'",
      "reward_type='FIXED_DISCOUNT',value=10,currency=NULL",
      "reward_type='FIXED_DISCOUNT',value=0,currency='ARS'",
      "reward_type='FIXED_DISCOUNT',value=-1,currency='ARS'",
      "reward_type='FREE_ITEM',item_reference=NULL",
      "reward_type='FREE_ITEM',item_reference=''",
      "reward_type='FREE_ITEM',item_reference=E' \t\n'",
      "reward_type='CUSTOM',terms_text=E' \t\n'",
    ])
      await scenario(
        `invalid reward values: ${assignment}`,
        () => updateReward(assignment),
        '23514',
        'rewards_type_values_check',
      );
    for (const currency of ['', 'AR', 'ars', 'A1S'])
      await scenario(
        `invalid currency format ${JSON.stringify(currency)}`,
        () => updateReward('currency=$2', [currency]),
        '23514',
        'rewards_currency_check',
      );
    await scenario(
      'NaN is never a monetary value',
      () => updateReward("value='NaN'"),
      '23514',
      'rewards_value_finite_check',
    );
    await scenario(
      'numeric precision overflow rejected',
      () => updateReward("value='10000000000.00'"),
      '22003',
    );
    await scenario(
      'unknown reward type rejected',
      () => updateReward("reward_type='POINTS'"),
      '22P02',
    );
    await scenario(
      'PIECE_COUNT excluded from MVP',
      () => updateRule("metric='PIECE_COUNT'"),
      '22P02',
    );
    await scenario(
      'operator other than GTE excluded',
      () => updateRule("operator='GT'"),
      '22P02',
    );
    for (const [column, invalid, constraint] of [
      ['threshold', [0, -1], 'threshold'],
      ['window_days', [0, -1], 'window_days'],
      ['min_visit_spacing_hours', [-1], 'spacing'],
      ['max_awards_per_user', [0, 2], 'max_awards'],
    ]) {
      for (const value of invalid)
        await scenario(
          `invalid rule ${column}=${value}`,
          () => updateRule(`${column}=$2`, [value]),
          '23514',
          `reward_rules_${constraint}_check`,
        );
    }
    await scenario(
      'fractional threshold rejected as integer input',
      () => updateRule('threshold=$2', ['1.5']),
      '22P02',
    );
    await scenario('positive rule boundaries and nullable history window', () =>
      updateRule(
        'threshold=1,window_days=NULL,min_visit_spacing_hours=0,max_awards_per_user=1',
      ),
    );
    await scenario(
      'spacing is independently configurable and does not change check-in policy',
      () => updateRule('window_days=30,min_visit_spacing_hours=12'),
    );
    for (const value of [0, -1])
      await scenario(
        `invalid validDaysAfterIssue ${value}`,
        () => updateReward('valid_days_after_issue=$2', [value]),
        '23514',
        'rewards_valid_days_check',
      );
    await scenario('positive validDaysAfterIssue', () =>
      updateReward('valid_days_after_issue=1'),
    );
    for (const [kind, update] of [
      ['reward', updateReward],
      ['rule', updateRule],
    ]) {
      for (const end of ['2026-01-01', '2025-12-31'])
        await scenario(
          `${kind} window end must follow start (${end})`,
          () => update('starts_at=$2,ends_at=$3', ['2026-01-01', end]),
          '23514',
        );
      for (const dates of [
        [null, null],
        ['2026-01-01', null],
        [null, '2026-02-01'],
        ['2026-01-01', '2026-02-01'],
      ])
        await scenario(
          `${kind} valid optional window ${JSON.stringify(dates)}`,
          () => update('starts_at=$2,ends_at=$3', dates),
        );
    }
    await scenario(
      'selection and rule updates keep SQL audit timestamps',
      async () => {
        const before = (
          await query('SELECT updated_at FROM public.rewards WHERE id=$1', [
            reward1,
          ])
        ).rows[0].updated_at;
        await link(reward1, l2);
        const after = (
          await query('SELECT updated_at FROM public.rewards WHERE id=$1', [
            reward1,
          ])
        ).rows[0].updated_at;
        assert.ok(after > before);
        await updateRule("name='Changed fixture'");
        assert.ok(
          (
            await query(
              'SELECT updated_at > created_at AS changed FROM public.reward_rules WHERE id=$1',
              [rule],
            )
          ).rows[0].changed,
        );
      },
    );
    for (const role of ['anon', 'authenticated'])
      for (const table of tables) {
        await scenario(
          `${role} cannot directly read ${table}`,
          async () => {
            await query(`SET LOCAL ROLE ${role}`);
            await query(`SELECT * FROM public.${table}`);
          },
          '42501',
        );
      }
  } finally {
    await query('ROLLBACK');
    await db.end();
  }
});

test(
  'Phase 6A: generated Prisma models, Decimal, relations and rollback',
  { skip: preview },
  async () => {
    developmentConnection();
    const app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const prisma = app.get(PrismaService),
      slug = randomUUID(),
      rollback = new Error('Fixture rollback');
    try {
      await assert.rejects(
        prisma.$transaction(
          async (tx) => {
            const restaurant = await tx.restaurant.create({
              data: {
                name: '6A Prisma fixture',
                slug,
                status: 'ACTIVE',
                locations: {
                  create: {
                    name: 'Fixture',
                    slug,
                    addressLine1: 'Fixture',
                    city: 'City',
                    region: 'Region',
                    countryCode: 'AR',
                    timeZone: 'UTC',
                    status: 'ACTIVE',
                  },
                },
              },
              include: { locations: true },
            });
            const reward = await tx.reward.create({
              data: {
                restaurantId: restaurant.id,
                name: 'Fixture',
                description: 'Fixture',
                rewardType: 'FIXED_DISCOUNT',
                value: '12.34',
                currency: 'ARS',
                termsText: 'Fixture terms',
                status: 'DRAFT',
                locations: {
                  create: { locationId: restaurant.locations[0].id },
                },
                rules: {
                  create: {
                    name: 'Fixture',
                    metric: 'VISIT_COUNT',
                    operator: 'GTE',
                    threshold: 5,
                    windowDays: 30,
                    minVisitSpacingHours: 4,
                    maxAwardsPerUser: 1,
                    status: 'DRAFT',
                  },
                },
              },
              include: {
                restaurant: true,
                locations: { include: { location: true } },
                rules: true,
              },
            });
            assert.equal(reward.value.toFixed(2), '12.34');
            assert.equal(
              reward.locations[0].location.restaurantId,
              reward.restaurant.id,
            );
            assert.equal(reward.rules[0].rewardId, reward.id);
            assert.equal(reward.validDaysAfterIssue, null);
            assert.ok(
              await tx.rewardLocation.findUnique({
                where: {
                  rewardId_locationId: {
                    rewardId: reward.id,
                    locationId: restaurant.locations[0].id,
                  },
                },
              }),
            );
            await tx.$executeRaw`SET CONSTRAINTS public.rewards_scope, public.reward_locations_scope IMMEDIATE`;
            throw rollback;
          },
          { timeout: 20000 },
        ),
        (e) => e === rollback,
      );
      assert.equal(await prisma.restaurant.count({ where: { slug } }), 0);
    } finally {
      await app.close();
    }
  },
);

test(
  'Phase 6A: concurrent ownership and selection writes cannot commit an invalid scope',
  { skip: preview },
  async (t) => {
    const setup = developmentClient(),
      a = developmentClient(),
      b = developmentClient();
    const [r1, r2, location, reward] = Array.from({ length: 4 }, () =>
      randomUUID(),
    );
    await setup.connect();
    try {
      await a.connect();
      await b.connect();
      for (const id of [r1, r2])
        await setup.query(
          `INSERT INTO public.restaurants(id,name,slug,status) VALUES($1::uuid,'Phase 6A concurrent fixture',$1::text,'ACTIVE')`,
          [id],
        );
      await setup.query(
        `INSERT INTO public.restaurant_locations(id,restaurant_id,name,slug,address_line_1,city,region,country_code,time_zone,status) VALUES($1::uuid,$2,'Fixture',$1::text,'Fixture','City','Region','AR','UTC','ACTIVE')`,
        [location, r1],
      );
      await setup.query(
        `INSERT INTO public.rewards(id,restaurant_id,name,description,reward_type,terms_text,status) VALUES($1,$2,'Fixture','Fixture','CUSTOM','Explicit terms','DRAFT')`,
        [reward, r1],
      );
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
        await t.test(
          `${isolation}: parent change commits before blocked selection`,
          async () => {
            await setup.query(
              'UPDATE public.rewards SET restaurant_id=$1 WHERE id=$2',
              [r1, reward],
            );
            try {
              await a.query('BEGIN');
              await a.query(
                'UPDATE public.rewards SET restaurant_id=$1 WHERE id=$2',
                [r2, reward],
              );
              await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
              await b.query("SET LOCAL lock_timeout='8s'");
              // Establish a snapshot while the parent still appears to belong to r1.
              assert.equal(
                (
                  await b.query(
                    'SELECT restaurant_id FROM public.rewards WHERE id=$1',
                    [reward],
                  )
                ).rows[0].restaurant_id,
                r1,
              );
              const insert = b
                .query('INSERT INTO public.reward_locations VALUES($1,$2)', [
                  reward,
                  location,
                ])
                .then(() => b.query('COMMIT'))
                .then(
                  () => 'committed',
                  (e) => e.code,
                );
              await a.query('COMMIT');
              assert.equal(
                await insert,
                isolation === 'READ COMMITTED' ? '23514' : '40001',
              );
            } finally {
              await a.query('ROLLBACK');
              await b.query('ROLLBACK');
            }
            assert.equal(
              (
                await setup.query(
                  'SELECT count(*)::int AS n FROM public.reward_locations WHERE reward_id=$1',
                  [reward],
                )
              ).rows[0].n,
              0,
            );
          },
        );
      }
      await t.test(
        'selection commits first; competing reward reassignment is rejected',
        async () => {
          await setup.query(
            'UPDATE public.rewards SET restaurant_id=$1 WHERE id=$2',
            [r1, reward],
          );
          try {
            await a.query('BEGIN');
            await a.query('INSERT INTO public.reward_locations VALUES($1,$2)', [
              reward,
              location,
            ]);
            await b.query('BEGIN');
            await b.query("SET LOCAL lock_timeout='8s'");
            const change = b
              .query('UPDATE public.rewards SET restaurant_id=$1 WHERE id=$2', [
                r2,
                reward,
              ])
              .then(() => b.query('COMMIT'))
              .then(
                () => 'committed',
                (e) => e.code,
              );
            await a.query('COMMIT');
            assert.equal(await change, '23514');
          } finally {
            await a.query('ROLLBACK');
            await b.query('ROLLBACK');
          }
          assert.equal(
            (
              await setup.query(
                'SELECT restaurant_id FROM public.rewards WHERE id=$1',
                [reward],
              )
            ).rows[0].restaurant_id,
            r1,
          );
        },
      );
    } finally {
      await a.end();
      await b.end();
      try {
        await setup.query('BEGIN');
        await setup.query(
          'DELETE FROM public.reward_locations WHERE reward_id=$1',
          [reward],
        );
        await setup.query('DELETE FROM public.rewards WHERE id=$1', [reward]);
        await setup.query(
          'DELETE FROM public.restaurant_locations WHERE id=$1',
          [location],
        );
        await setup.query(
          'DELETE FROM public.restaurants WHERE id=ANY($1::uuid[])',
          [[r1, r2]],
        );
        await setup.query('COMMIT');
      } finally {
        await setup.query('ROLLBACK');
        await setup.end();
      }
    }
  },
);
