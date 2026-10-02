import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { SupabaseJwtService } from '../dist/auth/supabase-jwt.service.js';
import { AuthProfileService } from '../dist/auth/auth-profile.service.js';
import { MerchantVisitsService } from '../dist/merchant/merchant-visits.service.js';
import { MerchantAuthorizationService } from '../dist/merchant/merchant-authorization.service.js';
import { RewardEvaluationService } from '../dist/rewards/reward-evaluation.service.js';
import { CouponsService } from '../dist/rewards/coupons.service.js';
import { authFixture } from './helpers/auth-fixture.mjs';
import {
  developmentConnection,
  developmentClient,
} from '../scripts/development-database.mjs';

// Real PostgreSQL, synthetic JWT/JWKS transport. Reuses an existing public/Auth
// identity; creates only UUID-scoped business fixtures, never auth.users.
test('6B merchant confirmation, concurrency, wallet and publication races', async (t) => {
  developmentConnection();
  const auth = await authFixture();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseJwtService)
    .useValue(new SupabaseJwtService(auth.config, auth.authFetch))
    .overrideProvider(AuthProfileService)
    .useFactory({
      inject: [PrismaService],
      factory: (prisma) => {
        const service = new AuthProfileService(prisma);
        return {
          getOrCreate: (identity) =>
            identity.id === auth.userId
              ? Promise.resolve({
                  id: auth.userId,
                  status: 'ACTIVE',
                  deletedAt: null,
                })
              : service.getOrCreate(identity),
        };
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  const prisma = app.get(PrismaService),
    merchant = app.get(MerchantVisitsService);
  const created = [];
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const user = await prisma.user.findFirst({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: { id: 'asc' },
    });
    assert.ok(user, 'Existing real Auth-backed profile required');
    const token = await auth.sign({ sub: user.id }),
      outsider = await auth.sign();
    const request = async (path, access = token) => {
      const r = await fetch(base + path, {
        headers: access ? { Authorization: `Bearer ${access}` } : {},
        signal: AbortSignal.timeout(30000),
      });
      return {
        status: r.status,
        cache: r.headers.get('cache-control'),
        body: await r.json(),
      };
    };
    const fixture = async (overrides = {}) => {
      const id = randomUUID();
      const restaurant = await prisma.restaurant.create({
        data: {
          id,
          name: 'Phase 6B isolated FREE_ITEM fixture',
          slug: id,
          status: 'ACTIVE',
        },
      });
      created.push(id);
      const location = async () =>
        prisma.restaurantLocation.create({
          data: {
            restaurantId: id,
            name: '6B fixture',
            slug: randomUUID(),
            addressLine1: 'Fixture',
            city: 'City',
            region: 'Region',
            countryCode: 'AR',
            timeZone: 'UTC',
            status: 'ACTIVE',
          },
        });
      const l1 = await location(),
        l2 = await location();
      await prisma.merchantMembership.create({
        data: {
          userId: user.id,
          restaurantId: id,
          role: 'OWNER',
          status: 'ACTIVE',
          scopeType: 'ALL_LOCATIONS',
          invitedAt: new Date(),
          acceptedAt: new Date(),
        },
      });
      const reward = await prisma.reward.create({
        data: {
          restaurantId: id,
          name: 'Fictitious tea',
          description: 'Fixture only',
          rewardType: 'FREE_ITEM',
          itemReference: 'fixture-tea',
          termsText: 'One test tea. No real redemption.',
          validDaysAfterIssue: 7,
          status: 'ACTIVE',
        },
      });
      const rule = await prisma.rewardRule.create({
        data: {
          rewardId: reward.id,
          name: '6B fixture',
          metric: 'VISIT_COUNT',
          operator: 'GTE',
          threshold: 2,
          windowDays: null,
          minVisitSpacingHours: 4,
          maxAwardsPerUser: 1,
          status: 'ACTIVE',
          ...overrides,
        },
      });
      const visit = (offsetHours, status = 'PENDING', locationId = l1.id) =>
        prisma.visit.create({
          data: {
            userId: user.id,
            locationId,
            source: 'MANUAL',
            status,
            checkedInAt: new Date(Date.now() + offsetHours * 3600000),
            ...(status === 'VERIFIED' ? { verifiedAt: new Date() } : {}),
            idempotencyKey: randomUUID(),
          },
        });
      const coupons = () =>
        prisma.coupon.findMany({
          where: { ruleOrigin: { rewardRuleId: rule.id } },
          include: { ruleOrigin: true },
        });
      return { restaurant, l1, l2, reward, rule, visit, coupons };
    };
    await t.test(
      'two simultaneous pending visits reach threshold exactly once; repeated verification preserves facts',
      async () => {
        const f = await fixture();
        const a = await f.visit(-8),
          b = await f.visit(-1);
        await Promise.all([
          merchant.verify(user.id, a.id, {}),
          merchant.verify(user.id, b.id, {}),
        ]);
        const coupons = await f.coupons();
        assert.equal(coupons.length, 1);
        const c = coupons[0];
        assert.equal(c.userId, user.id);
        assert.equal(c.eligibilitySnapshot.count, 2);
        const before = await prisma.visit.findUnique({ where: { id: b.id } });
        await merchant.verify(user.id, b.id, {});
        assert.equal((await f.coupons()).length, 1);
        assert.equal(
          +(await prisma.visit.findUnique({ where: { id: b.id } })).verifiedAt,
          +before.verifiedAt,
        );
        await prisma.coupon.update({
          where: { id: c.id },
          data: { status: 'REVOKED' },
        });
        await merchant.verify(user.id, (await f.visit(0)).id, {});
        assert.equal((await f.coupons()).length, 1);
      },
    );
    await t.test(
      'threshold miss confirms normally; pending/rejected and foreign/too-close visits do not count',
      async () => {
        const f = await fixture({ threshold: 3, windowDays: 1 });
        await f.visit(-48, 'VERIFIED');
        await f.visit(-8, 'REJECTED');
        await f.visit(-7, 'PENDING');
        await f.visit(-6, 'VERIFIED');
        await f.visit(-5, 'VERIFIED', f.l2.id);
        const trigger = await f.visit(0);
        const result = await merchant.verify(user.id, trigger.id, {});
        assert.equal(result.status, 'VERIFIED');
        assert.equal((await f.coupons()).length, 0);
      },
    );
    await t.test(
      'selected branch scope filters history and triggering branch',
      async () => {
        const f = await fixture();
        await prisma.rewardLocation.create({
          data: { rewardId: f.reward.id, locationId: f.l1.id },
        });
        await f.visit(-12, 'VERIFIED', f.l2.id);
        await merchant.verify(
          user.id,
          (await f.visit(-8, 'PENDING', f.l2.id)).id,
          {},
        );
        await merchant.verify(user.id, (await f.visit(-4)).id, {});
        assert.equal((await f.coupons()).length, 0);
        await merchant.verify(user.id, (await f.visit(0)).id, {});
        assert.equal((await f.coupons()).length, 1);
        const db = developmentClient();
        await db.connect();
        try {
          for (const sql of [
            'DELETE FROM public.reward_locations WHERE reward_id=$1',
            'UPDATE public.reward_locations SET location_id=$2 WHERE reward_id=$1',
          ]) {
            let code;
            try {
              await db.query(
                sql,
                sql.includes('$2') ? [f.reward.id, f.l2.id] : [f.reward.id],
              );
            } catch (e) {
              code = e.code;
            }
            assert.equal(
              code,
              '23514',
              'Published scope must reject deletion and reassignment',
            );
          }
          await prisma.restaurantLocation.update({
            where: { id: f.l1.id },
            data: { status: 'ARCHIVED' },
          });
          assert.equal(
            await prisma.rewardLocation.count({
              where: { rewardId: f.reward.id },
            }),
            1,
          );
        } finally {
          await db.end();
        }
      },
    );
    await t.test(
      'failure after coupon insert rolls back visit, coupon and origin',
      async () => {
        const f = await fixture({ threshold: 1 }),
          v = await f.visit(-1);
        const evaluator = new RewardEvaluationService();
        const service = new MerchantVisitsService(
          prisma,
          new MerchantAuthorizationService(),
          {
            evaluate: async (tx, visit) => {
              await evaluator.evaluate(tx, visit);
              throw Error('injected failure');
            },
          },
        );
        await assert.rejects(service.verify(user.id, v.id, {}), {
          status: 503,
        });
        assert.equal(
          (await prisma.visit.findUnique({ where: { id: v.id } })).status,
          'PENDING',
        );
        assert.equal((await f.coupons()).length, 0);
      },
    );
    await t.test(
      'first issuance locks definition: concurrent commercial edit waits then is rejected',
      async () => {
        const f = await fixture({ threshold: 1 }),
          v = await f.visit(-1),
          db = developmentClient();
        await db.connect();
        let release, ready;
        const gate = new Promise((r) => {
            release = r;
          }),
          held = new Promise((r) => {
            ready = r;
          });
        const adapter = {
          $transaction: (operation) =>
            prisma.$transaction(
              async (tx) => {
                const value = await operation(tx);
                await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
                ready();
                await gate;
                return value;
              },
              { timeout: 15000 },
            ),
        };
        const service = new MerchantVisitsService(
          adapter,
          new MerchantAuthorizationService(),
          new RewardEvaluationService(),
        );
        const issuance = service.verify(user.id, v.id, {});
        issuance.catch(() => ready());
        try {
          await held;
          let settled = false;
          const edit = db
            .query(
              "UPDATE public.rewards SET terms_text='changed concurrently' WHERE id=$1",
              [f.reward.id],
            )
            .then(
              () => {
                settled = true;
                return 'accepted';
              },
              (e) => {
                settled = true;
                return e.code;
              },
            );
          await delay(150);
          assert.equal(settled, false);
          release();
          await issuance;
          assert.equal(await edit, '23514');
          assert.equal((await f.coupons()).length, 1);
        } finally {
          release();
          await issuance.catch(() => {});
          await db.end();
        }
      },
    );
    await t.test(
      'edit winning first is seen by issuer, including scope selection',
      async () => {
        const f = await fixture({ threshold: 1 }),
          v = await f.visit(-1),
          db = developmentClient();
        await db.connect();
        try {
          await db.query('BEGIN');
          await db.query(
            'INSERT INTO public.reward_locations(reward_id,location_id) VALUES($1,$2)',
            [f.reward.id, f.l2.id],
          );
          let done = false;
          const issuance = merchant.verify(user.id, v.id, {}).then((r) => {
            done = true;
            return r;
          });
          await delay(150);
          assert.equal(done, false);
          await db.query('COMMIT');
          assert.equal((await issuance).status, 'VERIFIED');
          assert.equal((await f.coupons()).length, 0);
        } finally {
          await db.query('ROLLBACK');
          await db.end();
        }
      },
    );
    await t.test(
      'GET wallet: real Auth guard, no-store, pagination, recipient isolation, no internal snapshot',
      async () => {
        assert.equal((await request('/me/coupons', null)).status, 401);
        assert.equal((await request('/me/coupons', 'invalid')).status, 401);
        assert.equal(
          (await request('/me/coupons?userId=' + user.id)).status,
          400,
        );
        const page = await request('/me/coupons?limit=1');
        assert.equal(page.status, 200);
        assert.equal(page.cache, 'no-store');
        assert.equal(page.body.items.length, 1);
        assert.ok(page.body.nextCursor);
        const c = page.body.items[0];
        assert.equal(c.reward.type, 'FREE_ITEM');
        assert.equal(typeof c.publicCode, 'string');
        assert.equal('eligibilitySnapshot' in c, false);
        assert.equal('userId' in c, false);
        assert.equal('issuanceKey' in c, false);
        const next = await request(
          '/me/coupons?limit=1&cursor=' + page.body.nextCursor,
        );
        assert.equal(next.status, 200);
        assert.notEqual(next.body.items[0].id, c.id);
        const other = await request('/me/coupons', outsider);
        assert.equal(other.status, 200);
        assert.deepEqual(other.body.items, []);
        assert.equal(
          (await request('/me/coupons?cursor=' + c.id, outsider)).status,
          404,
        );
        assert.equal((await request('/health', null)).status, 200);
        assert.equal((await request('/me')).status, 200);
      },
    );
    await t.test(
      'effective expiry does not mutate stored ISSUED status',
      async () => {
        // Existing fixture coupons use future expiry. Exercise the real query/DTO at
        // a later server clock without rewriting immutable issuance dates.
        const actual = new CouponsService(prisma),
          normal = await actual.list(user.id, {});
        const clockProxy = new Proxy(prisma, {
          get: (target, key) =>
            key === '$queryRaw'
              ? async () => [{ now: new Date('2100-01-01T00:00:00Z') }]
              : Reflect.get(target, key, target),
        });
        const later = await new CouponsService(clockProxy).list(user.id, {});
        const issued = normal.items.filter((c) => c.status === 'ISSUED');
        assert.ok(issued.length);
        for (const c of issued) {
          assert.equal(
            later.items.find((v) => v.id === c.id).status,
            'EXPIRED',
          );
          assert.equal(
            (
              await prisma.coupon.findUnique({
                where: { id: c.id },
                select: { status: true },
              })
            ).status,
            'ISSUED',
          );
        }
      },
    );
  } finally {
    // Explicit graph cleanup only for restaurant UUIDs this test created. The
    // deferred origin FK permits atomic parent+origin removal, never replacement.
    if (created.length)
      await prisma.$transaction(
        async (tx) => {
          const rewards = await tx.reward.findMany({
            where: { restaurantId: { in: created } },
            select: { id: true },
          });
          const ids = rewards.map((r) => r.id);
          const rules = await tx.rewardRule.findMany({
            where: { rewardId: { in: ids } },
            select: { id: true },
          });
          const ruleIds = rules.map((r) => r.id);
          await tx.coupon.deleteMany({
            where: { ruleOrigin: { rewardRuleId: { in: ruleIds } } },
          });
          await tx.couponRuleOrigin.deleteMany({
            where: { rewardRuleId: { in: ruleIds } },
          });
          await tx.rewardLocation.deleteMany({
            where: { rewardId: { in: ids } },
          });
          await tx.rewardRule.deleteMany({ where: { id: { in: ruleIds } } });
          await tx.reward.deleteMany({ where: { id: { in: ids } } });
          await tx.visit.deleteMany({
            where: { location: { restaurantId: { in: created } } },
          });
          await tx.merchantMembership.deleteMany({
            where: { restaurantId: { in: created } },
          });
          await tx.restaurantLocation.deleteMany({
            where: { restaurantId: { in: created } },
          });
          await tx.restaurant.deleteMany({ where: { id: { in: created } } });
        },
        { timeout: 30000 },
      );
    await app.close();
  }
});
