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
import { authFixture } from './helpers/auth-fixture.mjs';
import { visitFixture } from './helpers/visit-fixture.mjs';
import {
  developmentConnection,
  developmentClient,
} from '../scripts/development-database.mjs';

test('Merchant HTTP: real PostgreSQL authorization, isolation and transitions', async (t) => {
  developmentConnection();
  const auth = await authFixture();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseJwtService)
    .useValue(new SupabaseJwtService(auth.config, auth.authFetch))
    .overrideProvider(AuthProfileService)
    .useFactory({
      inject: [PrismaService],
      factory: (prisma) => {
        const actual = new AuthProfileService(prisma);
        return {
          getOrCreate: (identity) =>
            identity.id === auth.userId
              ? Promise.resolve({
                  id: auth.userId,
                  status: 'ACTIVE',
                  deletedAt: null,
                })
              : actual.getOrCreate(identity),
        };
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  const prisma = app.get(PrismaService);
  let f, g, membership;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const profile = await prisma.user.findFirst({
      where: { status: 'ACTIVE', deletedAt: null },
    });
    assert.ok(profile);
    const token = await auth.sign({ sub: profile.id }),
      outsider = await auth.sign();
    f = await visitFixture(prisma);
    g = await visitFixture(prisma);
    const l1 = await f.location(),
      l2 = await f.location(),
      otherLocation = await g.location();
    const code = await f.code(l1.id);
    const visit = (locationId = l1.id, status = 'PENDING') =>
      prisma.visit.create({
        data: {
          userId: profile.id,
          locationId,
          source: 'MANUAL',
          status,
          checkedInAt: new Date(),
          idempotencyKey: randomUUID(),
        },
      });
    const qr = await prisma.$transaction((tx) =>
      tx.visit.create({
        data: {
          userId: profile.id,
          locationId: l1.id,
          source: 'QR',
          status: 'PENDING',
          checkedInAt: new Date(),
          idempotencyKey: randomUUID(),
          evidence: {
            create: { checkInCodeId: code.row.id, validatedAt: new Date() },
          },
        },
      }),
    );
    const session = await prisma.sushiSession.create({
      data: {
        visitId: qr.id,
        status: 'ACTIVE',
        startedAt: new Date(),
        pieceCount: 17,
        entryMode: 'MANUAL',
        notes: 'Private session note',
      },
    });
    const unselected = await visit(l2.id),
      foreign = await visit(otherLocation.id);
    membership = await prisma.$transaction((tx) =>
      tx.merchantMembership.create({
        data: {
          userId: profile.id,
          restaurantId: f.restaurant.id,
          role: 'STAFF',
          status: 'ACTIVE',
          scopeType: 'SELECTED_LOCATIONS',
          invitedAt: new Date(),
          acceptedAt: new Date(),
          locations: { create: { locationId: l1.id } },
        },
      }),
    );
    const http = async (method, path, body, access = token) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(access ? { Authorization: `Bearer ${access}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
      return {
        status: response.status,
        data: await response.json(),
        cache: response.headers.get('cache-control'),
      };
    };
    const post = (id, decision, body = {}, access) =>
      http('POST', `/merchant/visits/${id}/${decision}`, body, access);
    const setMember = (data) =>
      prisma.merchantMembership.update({ where: { id: membership.id }, data });

    await t.test(
      'global Auth protects all merchant routes; health/me preserved',
      async () => {
        for (const [method, path, body] of [
          ['GET', '/merchant/locations'],
          ['GET', '/merchant/visits'],
          ['POST', `/merchant/visits/${qr.id}/verify`, {}],
          ['POST', `/merchant/visits/${qr.id}/reject`, { reason: 'Test' }],
        ]) {
          assert.equal((await http(method, path, body, null)).status, 401);
          assert.equal((await http(method, path, body, 'invalid')).status, 401);
        }
        assert.deepEqual((await http('GET', '/health', undefined, null)).data, {
          status: 'ok',
        });
        assert.equal((await http('GET', '/me')).data.id, profile.id);
      },
    );
    await t.test(
      'SELECTED exposes only permitted locations and visits',
      async () => {
        const locations = await http('GET', '/merchant/locations');
        assert.equal(locations.status, 200);
        assert.equal(locations.cache, 'no-store');
        assert.ok(
          locations.data.items.some((row) => row.id === l1.id && row.canReview),
        );
        assert.ok(
          !locations.data.items.some((row) =>
            [l2.id, otherLocation.id].includes(row.id),
          ),
        );
        const rows = await http('GET', `/merchant/visits?locationId=${l1.id}`);
        assert.equal(rows.status, 200);
        assert.ok(rows.data.items.some((row) => row.id === qr.id));
        assert.ok(rows.data.items.every((row) => row.location.id === l1.id));
        const raw = JSON.stringify(rows.data);
        for (const field of [
          'Private session note',
          'tokenHash',
          'idempotencyKey',
          'marketingConsentAt',
          'pieceCount',
          'userId',
        ])
          assert.equal(raw.includes(field), false);
      },
    );
    await t.test(
      'foreign restaurant and unselected branch cannot be listed or mutated',
      async () => {
        for (const [id, location] of [
          [foreign.id, otherLocation.id],
          [unselected.id, l2.id],
        ]) {
          assert.equal(
            (await http('GET', `/merchant/visits?locationId=${location}`))
              .status,
            404,
          );
          assert.equal(
            (await http('GET', `/merchant/visits?cursor=${id}`)).status,
            404,
          );
          assert.equal((await post(id, 'verify')).status, 404);
          assert.equal(
            (await post(id, 'reject', { reason: 'Outside scope' })).status,
            404,
          );
        }
        assert.equal(
          (await prisma.visit.findUnique({ where: { id: foreign.id } })).status,
          'PENDING',
        );
      },
    );
    await t.test(
      'actor without membership cannot acquire access from request IDs',
      async () => {
        assert.equal(
          (await http('GET', '/merchant/visits', undefined, outsider)).status,
          403,
        );
        assert.equal((await post(qr.id, 'verify', {}, outsider)).status, 404);
        for (const extra of ['userId', 'restaurantId', 'role', 'scopeType']) {
          assert.equal(
            (await http('GET', `/merchant/visits?${extra}=${profile.id}`))
              .status,
            400,
          );
          assert.equal(
            (await post(qr.id, 'verify', { [extra]: profile.id })).status,
            400,
          );
        }
      },
    );
    for (const memberStatus of ['INVITED', 'SUSPENDED', 'REVOKED'])
      await t.test(`${memberStatus} cannot read or review`, async () => {
        await setMember({ status: memberStatus });
        try {
          // Existing unrelated memberships must remain usable. Only this fixture
          // loses access; never assume the developer has no other restaurants.
          for (const path of ['/merchant/locations', '/merchant/visits']) {
            const result = await http('GET', path);
            assert.ok([200, 403].includes(result.status));
            if (result.status === 200)
              assert.ok(
                result.data.items.every((row) =>
                  path.endsWith('locations')
                    ? ![l1.id, l2.id].includes(row.id)
                    : ![l1.id, l2.id].includes(row.location.id),
                ),
              );
          }
          assert.ok(
            [403, 404].includes(
              (await http('GET', `/merchant/visits?locationId=${l1.id}`))
                .status,
            ),
          );
          assert.equal((await post(qr.id, 'verify')).status, 404);
        } finally {
          await setMember({ status: 'ACTIVE' });
        }
      });
    await t.test(
      'ANALYST is read-only even with arbitrary permission fields',
      async () => {
        await setMember({ role: 'ANALYST' });
        try {
          assert.equal(
            (await http('GET', `/merchant/visits?locationId=${l1.id}`)).status,
            200,
          );
          assert.equal(
            (await http('GET', '/merchant/locations')).data.items.find(
              (row) => row.id === l1.id,
            ).canReview,
            false,
          );
          assert.equal((await post(qr.id, 'verify')).status, 403);
          assert.equal(
            (await post(qr.id, 'reject', { reason: 'Test' })).status,
            403,
          );
        } finally {
          await setMember({ role: 'STAFF' });
        }
      },
    );
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'])
      await t.test(`${role} can confirm and reject within scope`, async () => {
        await setMember({ role });
        const a = await visit(),
          b = await visit();
        assert.equal((await post(a.id, 'verify')).status, 200);
        assert.equal(
          (await post(b.id, 'reject', { reason: 'No corresponde' })).status,
          200,
        );
      });
    await t.test(
      'ALL_LOCATIONS covers the restaurant but never another restaurant',
      async () => {
        await prisma.$transaction(async (tx) => {
          await tx.merchantMembership.update({
            where: { id: membership.id },
            data: { scopeType: 'ALL_LOCATIONS' },
          });
          await tx.merchantMembershipLocation.deleteMany({
            where: { membershipId: membership.id },
          });
        });
        assert.ok(
          (await http('GET', '/merchant/locations')).data.items.some(
            (row) => row.id === l2.id,
          ),
        );
        assert.equal((await post(unselected.id, 'verify')).status, 200);
        assert.equal((await post(foreign.id, 'verify')).status, 404);
        await prisma.$transaction(async (tx) => {
          await tx.merchantMembership.update({
            where: { id: membership.id },
            data: { scopeType: 'SELECTED_LOCATIONS' },
          });
          await tx.merchantMembershipLocation.create({
            data: { membershipId: membership.id, locationId: l1.id },
          });
        });
      },
    );
    await t.test(
      'archived restaurant and inactive location deny access',
      async () => {
        await prisma.restaurantLocation.update({
          where: { id: l1.id },
          data: { status: 'INACTIVE' },
        });
        try {
          assert.equal((await post(qr.id, 'verify')).status, 404);
          assert.equal(
            (await http('GET', `/merchant/visits?locationId=${l1.id}`)).status,
            404,
          );
        } finally {
          await prisma.restaurantLocation.update({
            where: { id: l1.id },
            data: { status: 'ACTIVE' },
          });
        }
        await prisma.restaurant.update({
          where: { id: f.restaurant.id },
          data: { status: 'ARCHIVED' },
        });
        try {
          assert.equal((await post(qr.id, 'verify')).status, 404);
        } finally {
          await prisma.restaurant.update({
            where: { id: f.restaurant.id },
            data: { status: 'ACTIVE' },
          });
        }
      },
    );
    await t.test(
      'double confirmation is safe and preserves QR evidence, check-in and session',
      async () => {
        const evidence = await prisma.visitCheckInEvidence.findUnique({
          where: { visitId: qr.id },
        });
        const results = await Promise.all([
          post(qr.id, 'verify'),
          post(qr.id, 'verify'),
        ]);
        assert.deepEqual(
          results.map((row) => row.status),
          [200, 200],
        );
        assert.deepEqual(results[0].data, results[1].data);
        const after = await prisma.visit.findUnique({ where: { id: qr.id } });
        assert.equal(after.status, 'VERIFIED');
        assert.ok(after.verifiedAt);
        assert.deepEqual(after.checkedInAt, qr.checkedInAt);
        assert.equal(after.checkedOutAt, qr.checkedOutAt);
        assert.deepEqual(
          await prisma.visitCheckInEvidence.findUnique({
            where: { visitId: qr.id },
          }),
          evidence,
        );
        assert.deepEqual(
          await prisma.sushiSession.findUnique({ where: { id: session.id } }),
          session,
        );
        await post(qr.id, 'verify');
        assert.deepEqual(
          await prisma.visit.findUnique({ where: { id: qr.id } }),
          after,
        );
        assert.equal(
          (await post(qr.id, 'reject', { reason: 'Change decision' })).status,
          409,
        );
      },
    );
    await t.test(
      'rejection requires bounded reason; same retry preserves row; conflicting reason fails',
      async () => {
        const row = await visit();
        for (const body of [
          {},
          { reason: '' },
          { reason: '   ' },
          { reason: 'x'.repeat(301) },
          { reason: 5 },
          { reason: 'ok', verifiedAt: new Date().toISOString() },
        ])
          assert.equal((await post(row.id, 'reject', body)).status, 400);
        assert.equal(
          (await post(row.id, 'reject', { reason: '  Fuera de la sucursal  ' }))
            .status,
          200,
        );
        const after = await prisma.visit.findUnique({ where: { id: row.id } });
        assert.equal(after.status, 'REJECTED');
        assert.equal(after.rejectedReason, 'Fuera de la sucursal');
        assert.equal(after.verifiedAt, null);
        assert.equal(
          (await post(row.id, 'reject', { reason: 'Fuera de la sucursal' }))
            .status,
          200,
        );
        assert.deepEqual(
          await prisma.visit.findUnique({ where: { id: row.id } }),
          after,
        );
        assert.equal(
          (await post(row.id, 'reject', { reason: 'Otro motivo' })).status,
          409,
        );
        assert.equal((await post(row.id, 'verify')).status, 409);
      },
    );
    await t.test(
      'confirm vs reject race commits only one decision',
      async () => {
        const row = await visit();
        const replies = await Promise.all([
          post(row.id, 'verify'),
          post(row.id, 'reject', { reason: 'No corresponde' }),
        ]);
        assert.deepEqual(
          replies.map((result) => result.status).sort(),
          [200, 409],
        );
        const actual = await prisma.visit.findUnique({ where: { id: row.id } });
        assert.ok(['VERIFIED', 'REJECTED'].includes(actual.status));
      },
    );
    await t.test(
      'CANCELLED is not eligible for either transition',
      async () => {
        const row = await visit(l1.id, 'CANCELLED');
        assert.equal((await post(row.id, 'verify')).status, 409);
        assert.equal(
          (await post(row.id, 'reject', { reason: 'Test' })).status,
          409,
        );
      },
    );
    await t.test(
      'revocation in progress is rechecked after authorization lock',
      async () => {
        const row = await visit(),
          db = developmentClient();
        await db.connect();
        try {
          await db.query('BEGIN');
          await db.query(
            "UPDATE public.merchant_memberships SET status='SUSPENDED' WHERE id=$1",
            [membership.id],
          );
          const pending = post(row.id, 'verify');
          const {
            rows: [{ pid }],
          } = await db.query('SELECT pg_backend_pid() AS pid');
          let waiting = false;
          const deadline = Date.now() + 8000;
          while (!waiting && Date.now() < deadline) {
            const result = await db.query(
              'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting',
              [pid],
            );
            waiting = result.rows[0].waiting;
            if (!waiting) await delay(50);
          }
          await db.query('COMMIT');
          assert.equal((await pending).status, 404);
          assert.equal(
            waiting,
            true,
            'The HTTP request actually waited for the membership lock',
          );
          assert.equal(
            (await prisma.visit.findUnique({ where: { id: row.id } })).status,
            'PENDING',
          );
        } finally {
          await db.query('ROLLBACK');
          await db.end();
          await setMember({ status: 'ACTIVE' });
        }
      },
    );
    await t.test(
      'pagination, status and location filters remain isolated',
      async () => {
        let cursor;
        const seen = [];
        do {
          const result = await http(
            'GET',
            `/merchant/visits?locationId=${l1.id}&status=VERIFIED&limit=2` +
              (cursor ? `&cursor=${cursor}` : ''),
          );
          assert.equal(result.status, 200);
          assert.ok(
            result.data.items.every(
              (row) => row.status === 'VERIFIED' && row.location.id === l1.id,
            ),
          );
          seen.push(...result.data.items.map((row) => row.id));
          cursor = result.data.nextCursor;
        } while (cursor);
        assert.equal(new Set(seen).size, seen.length);
        assert.ok(seen.includes(qr.id));
        for (const query of [
          'status=bad',
          'limit=0',
          'limit=101',
          'limit=1&limit=2',
          'locationId=bad',
          'cursor=bad',
        ])
          assert.equal(
            (await http('GET', `/merchant/visits?${query}`)).status,
            400,
          );
        assert.equal((await post('bad', 'verify')).status, 400);
      },
    );
    await t.test(
      'a merchant can review another customer without impersonation (rollback-only profile)',
      async () => {
        const rollback = new Error('rollback test');
        await assert.rejects(
          prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`SET CONSTRAINTS public.users_auth_user_fkey DEFERRED`;
              const customer = await tx.user.create({
                data: {
                  id: randomUUID(),
                  displayName: 'Other customer',
                  locale: 'es-AR',
                  timeZone: 'UTC',
                  status: 'ACTIVE',
                },
              });
              const row = await tx.visit.create({
                data: {
                  userId: customer.id,
                  locationId: l1.id,
                  source: 'IMPORT',
                  status: 'PENDING',
                  checkedInAt: new Date(),
                  idempotencyKey: randomUUID(),
                },
              });
              // Reuse the real transaction for the service, without opening a nested transaction.
              const adapter = { $transaction: (operation) => operation(tx) };
              const service = new MerchantVisitsService(
                adapter,
                new MerchantAuthorizationService(),
                  new RewardEvaluationService(),
              );
              const result = await service.verify(profile.id, row.id, {});
              assert.equal(result.status, 'VERIFIED');
              assert.equal(result.user.displayName, 'Other customer');
              throw rollback;
            },
            { timeout: 15000 },
          ),
          (error) => error === rollback,
        );
      },
    );
  } finally {
    try {
      if (membership)
        await prisma.$transaction(async (tx) => {
          await tx.merchantMembershipLocation.deleteMany({
            where: { membershipId: membership.id },
          });
          await tx.merchantMembership.delete({ where: { id: membership.id } });
        });
      if (f) await f.cleanup();
      if (g) await g.cleanup();
    } finally {
      await app.close();
    }
  }
});
