import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { developmentClient } from '../scripts/development-database.mjs';

test('Phase 6B SQL contract, isolated rollback-only fixtures', async (t) => {
  const db = developmentClient();
  await db.connect();
  const q = (text, values) => db.query(text, values);
  try {
    await q('BEGIN');
    if (process.env.COUPON_SCHEMA_PREVIEW === '1') {
      assert.equal(
        (await q("SELECT to_regclass('public.coupons') AS name")).rows[0].name,
        null,
      );
      const sql = readFileSync(
        new URL(
          '../prisma/migrations/20261002010000_phase_6b_rule_coupons/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await q(sql.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
      const retention = readFileSync(
        new URL(
          '../prisma/migrations/20261002011000_phase_6b_coupon_history_retention/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await q(retention.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
    }
    const user = (
      await q(
        "SELECT id FROM public.users WHERE status='ACTIVE' ORDER BY id LIMIT 1",
      )
    ).rows[0]?.id;
    assert.ok(
      user,
      'Requires an existing public User backed by Auth; never creates identities',
    );
    const restaurant = randomUUID(),
      location = randomUUID(),
      reward = randomUUID(),
      rule = randomUUID(),
      visit = randomUUID();
    const now = new Date();
    await q(
      "INSERT INTO public.restaurants(id,name,slug,status) VALUES($1::uuid,'6B SQL fixture',$1::text,'ACTIVE')",
      [restaurant],
    );
    await q(
      "INSERT INTO public.restaurant_locations(id,restaurant_id,name,slug,address_line_1,city,region,country_code,time_zone,status) VALUES($1::uuid,$2,'Fixture',$1::text,'Fixture','City','Region','AR','UTC','ACTIVE')",
      [location, restaurant],
    );
    await q(
      "INSERT INTO public.rewards(id,restaurant_id,name,description,reward_type,item_reference,terms_text,status,valid_days_after_issue) VALUES($1::uuid,$2,'Fixture','Fixture','FREE_ITEM','test-item','Fixture only','ACTIVE',7)",
      [reward, restaurant],
    );
    await q(
      "INSERT INTO public.reward_rules(id,reward_id,name,metric,operator,threshold,window_days,min_visit_spacing_hours,max_awards_per_user,status) VALUES($1::uuid,$2,'Fixture','VISIT_COUNT','GTE',1,NULL,0,1,'ACTIVE')",
      [rule, reward],
    );
    await q(
      "INSERT INTO public.visits(id,user_id,location_id,source,status,checked_in_at,verified_at,idempotency_key) VALUES($1::uuid,$2,$3,'MANUAL','VERIFIED',$4,$4,$1::text)",
      [visit, user, location, now],
    );
    await q('SET CONSTRAINTS ALL IMMEDIATE');
    await q('SET CONSTRAINTS ALL DEFERRED');
    const snapshot = () => ({
      schemaVersion: 1,
      source: 'RULE',
      userId: user,
      rewardRuleId: rule,
      rewardId: reward,
      evaluatedAt: now.toISOString(),
      triggeringVisitId: visit,
      eligible: true,
      rule: {
        metric: 'VISIT_COUNT',
        operator: 'GTE',
        threshold: 1,
        windowDays: null,
        minVisitSpacingHours: 0,
        maxAwardsPerUser: 1,
        startsAt: null,
        endsAt: null,
      },
      scope: { restaurantId: restaurant, locationIds: [] },
      rewardWindow: { startsAt: null, endsAt: null },
      count: 1,
      countedVisits: [
        { id: visit, locationId: location, checkedInAt: now.toISOString() },
      ],
    });
    const insert = async (overrides = {}, origin = true) => {
      const row = {
        id: randomUUID(),
        source: 'RULE',
        publicCode: randomBytes(24).toString('base64url'),
        key: `rule:${rule}:user:${user}`,
        snapshot: snapshot(),
        expiresAt: new Date(+now + 7 * 86400000),
        ...overrides,
      };
      await q(
        "INSERT INTO public.coupons(id,user_id,source,public_code,status,issued_at,expires_at,issuance_key,eligibility_snapshot) VALUES($1::uuid,$2,$3,$4,'ISSUED',$5,$6,$7,$8)",
        [
          row.id,
          user,
          row.source,
          row.publicCode,
          now,
          row.expiresAt,
          row.key,
          row.snapshot,
        ],
      );
      if (origin)
        await q(
          'INSERT INTO public.coupon_rule_origins(coupon_id,reward_rule_id) VALUES($1::uuid,$2)',
          [row.id, row.ruleId ?? rule],
        );
      return row;
    };
    const valid = await insert();
    await q('SET CONSTRAINTS ALL IMMEDIATE');
    await q('SET CONSTRAINTS ALL DEFERRED');
    await t.test(
      'valid FREE_ITEM coupon and canonical rule origin survive deferred validation',
      async () => {
        assert.equal(
          (
            await q(
              'SELECT count(*)::int AS n FROM public.coupon_rule_origins WHERE coupon_id=$1',
              [valid.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'contract columns, native types and reserved enums match v1.1',
      async () => {
        const expected = {
          coupons: [
            'id:uuid!',
            'user_id:uuid!',
            'source:coupon_source!',
            'public_code:character varying(32)!',
            'status:coupon_status!',
            'issued_at:timestamp(6) with time zone!',
            'expires_at:timestamp(6) with time zone',
            'issuance_key:character varying(200)!',
            'eligibility_snapshot:jsonb!',
            'created_at:timestamp(6) with time zone!',
            'updated_at:timestamp(6) with time zone!',
          ],
          coupon_rule_origins: ['coupon_id:uuid!', 'reward_rule_id:uuid!'],
        };
        const rows = (
          await q(
            "SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.oid IN ('public.coupons'::regclass,'public.coupon_rule_origins'::regclass) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
          )
        ).rows;
        for (const [table, columns] of Object.entries(expected))
          assert.deepEqual(
            rows
              .filter((r) => r.relname === table)
              .map((r) => `${r.attname}:${r.type}${r.attnotnull ? '!' : ''}`),
            columns,
          );
        for (const [name, values] of Object.entries({
          coupon_source: ['RULE', 'CAMPAIGN', 'MANUAL'],
          coupon_status: ['ISSUED', 'REDEEMED', 'EXPIRED', 'REVOKED'],
        })) {
          assert.deepEqual(
            (
              await q(
                'SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=$1::regtype ORDER BY e.enumsortorder',
                ['public.' + name],
              )
            ).rows.map((r) => r.enumlabel),
            values,
          );
        }
      },
    );
    const reject = async (name, operation, expected = '23514') =>
      t.test(name, async () => {
        await q('SAVEPOINT invalid_case');
        let code;
        try {
          await operation();
          await q('SET CONSTRAINTS ALL IMMEDIATE');
        } catch (error) {
          code = error.code;
        } finally {
          await q('ROLLBACK TO SAVEPOINT invalid_case');
          await q('RELEASE SAVEPOINT invalid_case');
        }
        assert.equal(
          code,
          expected,
          'Expected constraint failure (sensitive SQL details suppressed)',
        );
      });
    const fresh = async (overrides, origin = true) => {
      const ruleId = randomUUID();
      await q(
        "INSERT INTO public.reward_rules(id,reward_id,name,metric,operator,threshold,window_days,min_visit_spacing_hours,max_awards_per_user,status) VALUES($1,$2,'Fixture','VISIT_COUNT','GTE',1,NULL,0,1,'ACTIVE')",
        [ruleId, reward],
      );
      const decision = overrides.snapshot ?? snapshot();
      if (decision.rewardRuleId === rule) decision.rewardRuleId = ruleId;
      return insert(
        {
          key: `rule:${ruleId}:user:${user}`,
          ...overrides,
          ruleId,
          snapshot: decision,
        },
        origin,
      );
    };
    await reject(
      'removing coupon and origin cannot unlock a surviving benefit',
      async () => {
        await q('DELETE FROM public.coupons WHERE id=$1', [valid.id]);
        await q('DELETE FROM public.coupon_rule_origins WHERE coupon_id=$1', [
          valid.id,
        ]);
      },
    );
    await reject('source CAMPAIGN reserved but unsupported', () =>
      fresh({ source: 'CAMPAIGN' }),
    );
    await reject('source MANUAL reserved but unsupported', () =>
      fresh({ source: 'MANUAL' }),
    );
    await reject('orphan coupon rejected at final constraint check', () =>
      fresh({}, false),
    );
    await reject('canonical key enforced beyond UNIQUE', () =>
      fresh({ key: 'noncanonical' }),
    );
    await reject('same rule/user cannot issue twice', () => insert(), '23505');
    await reject(
      'public code is unique',
      () => insert({ publicCode: valid.publicCode, key: randomUUID() }),
      '23505',
    );
    await reject('public code must contain 32 random-format characters', () =>
      fresh({ publicCode: 'short' }),
    );
    await reject('expiry must be later than issuance', () =>
      fresh({ expiresAt: now }),
    );
    await reject('expiry must match promised UTC elapsed days', () =>
      fresh({ expiresAt: new Date(+now + 86400000) }),
    );
    for (const [name, mutate] of [
      [
        'missing schema version',
        (s) => {
          delete s.schemaVersion;
        },
      ],
      [
        'unknown schema version',
        (s) => {
          s.schemaVersion = 2;
        },
      ],
      [
        'wrong recipient',
        (s) => {
          s.userId = randomUUID();
        },
      ],
      [
        'wrong rule',
        (s) => {
          s.rewardRuleId = randomUUID();
        },
      ],
      [
        'wrong restaurant',
        (s) => {
          s.scope.restaurantId = randomUUID();
        },
      ],
      [
        'missing threshold',
        (s) => {
          delete s.rule.threshold;
        },
      ],
      [
        'false count',
        (s) => {
          s.count = 99;
        },
      ],
      [
        'unverified/nonexistent visit',
        (s) => {
          s.countedVisits[0].id = randomUUID();
        },
      ],
      [
        'foreign trigger',
        (s) => {
          s.triggeringVisitId = randomUUID();
        },
      ],
      [
        'duplicated visits',
        (s) => {
          s.countedVisits.push(s.countedVisits[0]);
          s.count = 2;
        },
      ],
    ])
      await reject(`snapshot rejects ${name}`, () => {
        const s = snapshot();
        mutate(s);
        return fresh({ snapshot: s });
      });
    for (const [name, sql, values] of [
      [
        'snapshot',
        "UPDATE public.coupons SET eligibility_snapshot=jsonb_set(eligibility_snapshot,'{schemaVersion}','2') WHERE id=$1",
        [valid.id],
      ],
      [
        'recipient',
        'UPDATE public.coupons SET user_id=$2 WHERE id=$1',
        [valid.id, randomUUID()],
      ],
      [
        'origin',
        'UPDATE public.coupon_rule_origins SET reward_rule_id=$2 WHERE coupon_id=$1',
        [valid.id, randomUUID()],
      ],
      [
        'origin removal',
        'DELETE FROM public.coupon_rule_origins WHERE coupon_id=$1',
        [valid.id],
      ],
      [
        'reward terms',
        "UPDATE public.rewards SET terms_text='changed' WHERE id=$1",
        [reward],
      ],
      [
        'reward owner',
        'UPDATE public.rewards SET restaurant_id=$2 WHERE id=$1',
        [reward, randomUUID()],
      ],
      [
        'rule threshold',
        'UPDATE public.reward_rules SET threshold=2 WHERE id=$1',
        [rule],
      ],
      [
        'rule reward',
        'UPDATE public.reward_rules SET reward_id=$2 WHERE id=$1',
        [rule, randomUUID()],
      ],
      [
        'scope expansion/restriction',
        'INSERT INTO public.reward_locations(reward_id,location_id) VALUES($1::uuid,$2)',
        [reward, location],
      ],
    ])
      await reject(`published ${name} is immutable`, () => q(sql, values));
    await reject(
      'delete then reinsert origin cannot bypass immutability',
      async () => {
        await q('DELETE FROM public.coupon_rule_origins WHERE coupon_id=$1', [
          valid.id,
        ]);
        await q('INSERT INTO public.coupon_rule_origins VALUES($1::uuid,$2)', [
          valid.id,
          rule,
        ]);
      },
    );
    await t.test(
      'pause permits operational change without rewriting/revoking coupon',
      async () => {
        await q("UPDATE public.rewards SET status='PAUSED' WHERE id=$1", [
          reward,
        ]);
        await q("UPDATE public.reward_rules SET status='PAUSED' WHERE id=$1", [
          rule,
        ]);
        assert.equal(
          (await q('SELECT status FROM public.coupons WHERE id=$1', [valid.id]))
            .rows[0].status,
          'ISSUED',
        );
      },
    );
    await t.test(
      'catalog: PK/FK, unique indexes, deferred triggers and client privileges',
      async () => {
        const tables = ['coupons', 'coupon_rule_origins'];
        const rls = (
          await q(
            'SELECT relrowsecurity FROM pg_class WHERE oid IN ($1::regclass,$2::regclass)',
            tables.map((x) => 'public.' + x),
          )
        ).rows;
        assert.equal(rls.length, 2);
        assert.ok(rls.every((r) => r.relrowsecurity));
        const constraints = (
          await q(
            "SELECT conname,contype,condeferrable,condeferred FROM pg_constraint WHERE conrelid IN ('public.coupons'::regclass,'public.coupon_rule_origins'::regclass)",
          )
        ).rows;
        assert.equal(constraints.filter((c) => c.contype === 'p').length, 2);
        assert.equal(constraints.filter((c) => c.contype === 'f').length, 3);
        assert.ok(
          constraints
            .filter((c) => c.contype === 't')
            .every((c) => c.condeferrable && c.condeferred),
        );
        assert.equal(
          (
            await q(
              "SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)",
              [tables],
            )
          ).rows[0].n,
          6,
        );
        for (const role of ['anon', 'authenticated'])
          for (const table of tables) {
            assert.equal(
              (
                await q(
                  "SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",
                  [role, 'public.' + table],
                )
              ).rows[0].allowed,
              false,
            );
          }
      },
    );
  } finally {
    await q('ROLLBACK');
    await db.end();
  }
});
