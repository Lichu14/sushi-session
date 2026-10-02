import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { SupabaseJwtService } from '../dist/auth/supabase-jwt.service.js';
import { authFixture } from './helpers/auth-fixture.mjs';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { validateEnvironment } from '../dist/config/environment.js';
import { developmentConnection } from '../scripts/development-database.mjs';
import {
  DEV_QR,
  ownerArgument,
  prepareDevelopmentQr,
  decodeDevelopmentQr,
} from '../scripts/dev-qr-fixture.mjs';

test('dev:qr accepts only an explicit UUID owner argument', () => {
  assert.equal(ownerArgument([]), undefined);
  const id = randomUUID();
  assert.equal(ownerArgument(['--owner-user-id', id.toUpperCase()]), id);
  for (const args of [
    ['--owner-user-id'],
    ['--owner-user-id', 'not-a-uuid'],
    ['--owner', id],
    ['--owner-user-id', id, 'extra'],
  ])
    assert.throws(() => ownerArgument(args));
});

test('development guard refuses production, another project, pool mode and database', () => {
  developmentConnection();
  const saved = { ...process.env };
  try {
    const original = new URL(process.env.DATABASE_URL);
    process.env.NODE_ENV = 'production';
    assert.throws(() => developmentConnection());
    delete process.env.NODE_ENV;
    for (const change of [
      (url) => {
        url.hostname = 'db.other-project.supabase.co';
      },
      (url) => {
        url.port = '6543';
      },
      (url) => {
        url.pathname = '/other';
      },
      (url) => {
        url.username = 'postgres.other-project';
      },
    ]) {
      const url = new URL(original);
      change(url);
      process.env.DATABASE_URL = url.toString();
      assert.throws(() => developmentConnection());
    }
  } finally {
    process.env.DATABASE_URL = saved.DATABASE_URL;
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
  }
});

test('dev:qr real PostgreSQL rotation, PNG contract, membership and rollback', async (t) => {
  developmentConnection();
  const prisma = new PrismaService(
    new ConfigService(validateEnvironment(process.env)),
  );
  const fixture = { ...DEV_QR, restaurantSlug: 'dev-qr-test-' + randomUUID() };
  const rotate = (owner) =>
    prisma.$transaction((tx) => prepareDevelopmentQr(tx, owner, fixture), {
      timeout: 30000,
      maxWait: 15000,
    });
  let first, second, otherLocation, unrelated;
  try {
    await prisma.onModuleInit();
    await t.test(
      'creates active fixture and decodable PNG without implicit membership',
      async () => {
        first = await rotate();
        const decoded = decodeDevelopmentQr(first.png);
        assert.ok(decoded.locationId === first.metadata.locationId);
        assert.ok(
          /^[A-Za-z0-9_-]{43}$/.test(decoded.token),
          'Token contains 256 random bits',
        );
        const row = await prisma.checkInCode.findUnique({
          where: { id: first.metadata.checkInCodeId },
        });
        assert.ok(
          row.tokenHash ===
            createHash('sha256').update(decoded.token).digest('hex'),
          'Only matching hash persisted',
        );
        assert.ok(
          !JSON.stringify(row).includes(decoded.token),
          'Plaintext never in PostgreSQL row',
        );
        assert.equal(row.mode, 'STATIC');
        assert.equal(row.status, 'ACTIVE');
        assert.equal(row.validUntil, null);
        assert.equal(row.maxUses, null);
        assert.equal(row.label, DEV_QR.label);
        assert.equal(row.createdByMembershipId, null);
        assert.equal(
          await prisma.merchantMembership.count({
            where: { restaurantId: first.metadata.restaurantId },
          }),
          0,
        );
        assert.deepEqual(Object.keys(first.metadata).sort(), [
          'checkInCodeId',
          'location',
          'locationId',
          'restaurant',
          'restaurantId',
        ]);
      },
    );
    await t.test(
      'rotation reuses fixture, changes token and revokes only this label/location',
      async () => {
        unrelated = await prisma.checkInCode.create({
          data: {
            locationId: first.metadata.locationId,
            label: 'OTHER_TOOL',
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            mode: 'STATIC',
            status: 'ACTIVE',
            validFrom: new Date(),
          },
        });
        otherLocation = await prisma.restaurantLocation.create({
          data: {
            restaurantId: first.metadata.restaurantId,
            name: 'Other test branch',
            slug: randomUUID(),
            addressLine1: 'Fixture',
            city: 'Fixture',
            region: 'Fixture',
            countryCode: 'AR',
            timeZone: 'UTC',
            status: 'ACTIVE',
          },
        });
        const otherCode = await prisma.checkInCode.create({
          data: {
            locationId: otherLocation.id,
            label: DEV_QR.label,
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            mode: 'STATIC',
            status: 'ACTIVE',
            validFrom: new Date(),
          },
        });
        second = await rotate();
        assert.equal(first.metadata.restaurantId, second.metadata.restaurantId);
        assert.equal(first.metadata.locationId, second.metadata.locationId);
        assert.notEqual(
          first.metadata.checkInCodeId,
          second.metadata.checkInCodeId,
        );
        assert.ok(
          decodeDevelopmentQr(first.png).token !==
            decodeDevelopmentQr(second.png).token,
          'New plaintext token for every run',
        );
        const old = await prisma.checkInCode.findUnique({
          where: { id: first.metadata.checkInCodeId },
        });
        assert.equal(old.status, 'REVOKED');
        assert.ok(old.revokedAt);
        for (const id of [unrelated.id, otherCode.id])
          assert.equal(
            (await prisma.checkInCode.findUnique({ where: { id } })).status,
            'ACTIVE',
          );
      },
    );
    await t.test(
      'parallel rotations leave exactly one active code',
      async () => {
        const pair = await Promise.all([rotate(), rotate()]);
        assert.notEqual(
          pair[0].metadata.checkInCodeId,
          pair[1].metadata.checkInCodeId,
        );
        assert.equal(
          await prisma.checkInCode.count({
            where: {
              locationId: first.metadata.locationId,
              label: DEV_QR.label,
              status: 'ACTIVE',
            },
          }),
          1,
        );
      },
    );
    await t.test(
      'explicit existing user becomes OWNER ACTIVE ALL, with no Auth writes',
      async () => {
        const user = await prisma.user.findFirst({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { id: true },
        });
        assert.ok(user);
        const member = await prisma.$transaction((tx) =>
          tx.merchantMembership.create({
            data: {
              userId: user.id,
              restaurantId: first.metadata.restaurantId,
              role: 'ANALYST',
              status: 'SUSPENDED',
              scopeType: 'SELECTED_LOCATIONS',
              invitedAt: new Date(),
              locations: { create: { locationId: first.metadata.locationId } },
            },
          }),
        );
        const result = await rotate(user.id);
        const updated = await prisma.merchantMembership.findUnique({
          where: { id: member.id },
        });
        assert.equal(updated.role, 'OWNER');
        assert.equal(updated.status, 'ACTIVE');
        assert.equal(updated.scopeType, 'ALL_LOCATIONS');
        assert.ok(updated.acceptedAt);
        assert.equal(
          await prisma.merchantMembershipLocation.count({
            where: { membershipId: member.id },
          }),
          0,
        );
        assert.equal(
          (
            await prisma.checkInCode.findUnique({
              where: { id: result.metadata.checkInCodeId },
            })
          ).createdByMembershipId,
          member.id,
        );
        await rotate();
        assert.equal(
          await prisma.merchantMembership.count({
            where: { restaurantId: first.metadata.restaurantId },
          }),
          1,
        );
      },
    );
    await t.test(
      'unknown owner rolls back without revoking current code',
      async () => {
        const before = await prisma.checkInCode.count({
          where: { locationId: first.metadata.locationId },
        });
        await assert.rejects(rotate(randomUUID()), /existente y activo/);
        assert.equal(
          await prisma.checkInCode.count({
            where: { locationId: first.metadata.locationId },
          }),
          before,
        );
        assert.equal(
          await prisma.checkInCode.count({
            where: {
              locationId: first.metadata.locationId,
              label: DEV_QR.label,
              status: 'ACTIVE',
            },
          }),
          1,
        );
      },
    );
    await t.test(
      'output failure rolls back new code and revocations',
      async () => {
        const before = await prisma.checkInCode.findMany({
          where: { locationId: first.metadata.locationId, label: DEV_QR.label },
          select: { id: true, status: true },
          orderBy: { id: 'asc' },
        });
        const simulated = new Error('Simulated PNG write failure');
        await assert.rejects(
          prisma.$transaction(
            async (tx) => {
              await prepareDevelopmentQr(tx, undefined, fixture);
              throw simulated;
            },
            { timeout: 30000 },
          ),
          (error) => error === simulated,
        );
        const after = await prisma.checkInCode.findMany({
          where: { locationId: first.metadata.locationId, label: DEV_QR.label },
          select: { id: true, status: true },
          orderBy: { id: 'asc' },
        });
        assert.deepEqual(after, before);
      },
    );
    await t.test(
      'decoded PNG completes check-in, session and merchant verification over HTTP',
      async () => {
        const user = await prisma.user.findFirst({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { id: true },
        });
        const ready = await rotate(user.id),
          decoded = decodeDevelopmentQr(ready.png);
        const auth = await authFixture(),
          jwt = await auth.sign({ sub: user.id });
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(SupabaseJwtService)
          .useValue(new SupabaseJwtService(auth.config, auth.authFetch))
          .compile();
        const app = module.createNestApplication({ logger: false });
        try {
          await app.listen(0, '127.0.0.1');
          const base = await app.getUrl();
          const call = async (method, path, body, expected) => {
            const response = await fetch(base + path, {
              method,
              headers: {
                Authorization: `Bearer ${jwt}`,
                'Content-Type': 'application/json',
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: AbortSignal.timeout(15000),
            });
            assert.equal(response.status, expected, 'HTTP status for ' + path);
            return response.json();
          };
          await call(
            'POST',
            '/check-ins',
            { ...decodeDevelopmentQr(first.png), idempotencyKey: randomUUID() },
            400,
          );
          const visit = await call(
            'POST',
            '/check-ins',
            { ...decoded, idempotencyKey: randomUUID() },
            201,
          );
          assert.equal(visit.status, 'PENDING');
          const session = await call(
            'POST',
            `/visits/${visit.id}/session`,
            {},
            201,
          );
          const counted = await call(
            'PATCH',
            `/sessions/${session.id}`,
            { pieceCount: 10, version: session.version },
            200,
          );
          await call(
            'POST',
            `/sessions/${session.id}/complete`,
            { version: counted.version },
            200,
          );
          const before = await prisma.sushiSession.findUnique({
            where: { id: session.id },
          });
          const pending = await call(
            'GET',
            `/merchant/visits?locationId=${decoded.locationId}`,
            undefined,
            200,
          );
          assert.ok(pending.items.some((row) => row.id === visit.id));
          const verified = await call(
            'POST',
            `/merchant/visits/${visit.id}/verify`,
            {},
            200,
          );
          assert.equal(verified.status, 'VERIFIED');
          assert.ok(verified.verifiedAt);
          assert.equal(verified.checkedInAt, visit.checkedInAt);
          assert.equal(
            (
              await prisma.visitCheckInEvidence.findUnique({
                where: { visitId: visit.id },
              })
            ).checkInCodeId,
            ready.metadata.checkInCodeId,
          );
          assert.deepEqual(
            await prisma.sushiSession.findUnique({ where: { id: session.id } }),
            before,
          );
          await rotate();
          assert.equal(
            (await prisma.visit.findUnique({ where: { id: visit.id } })).status,
            'VERIFIED',
          );
          assert.ok(
            await prisma.visitCheckInEvidence.findUnique({
              where: { visitId: visit.id },
            }),
          );
        } finally {
          await app.close();
        }
      },
    );
    await t.test(
      'a conflicting restaurant slug is never silently repurposed',
      async () => {
        await prisma.restaurant.update({
          where: { id: first.metadata.restaurantId },
          data: { name: 'Conflicting fixture name' },
        });
        await assert.rejects(rotate(), /ocupado/);
      },
    );
  } finally {
    try {
      const restaurant = await prisma.restaurant.findUnique({
        where: { slug: fixture.restaurantSlug },
      });
      if (restaurant)
        await prisma.$transaction(
          async (tx) => {
            const locations = await tx.restaurantLocation.findMany({
              where: { restaurantId: restaurant.id },
              select: { id: true },
            });
            const visitIds = (
              await tx.visit.findMany({
                where: { locationId: { in: locations.map((row) => row.id) } },
                select: { id: true },
              })
            ).map((row) => row.id);
            await tx.sushiSession.deleteMany({
              where: { visitId: { in: visitIds } },
            });
            await tx.visitCheckInEvidence.deleteMany({
              where: { visitId: { in: visitIds } },
            });
            await tx.visit.deleteMany({ where: { id: { in: visitIds } } });
            await tx.checkInCode.deleteMany({
              where: { locationId: { in: locations.map((row) => row.id) } },
            });
            await tx.merchantMembershipLocation.deleteMany({
              where: { membership: { restaurantId: restaurant.id } },
            });
            await tx.merchantMembership.deleteMany({
              where: { restaurantId: restaurant.id },
            });
            await tx.restaurantLocation.deleteMany({
              where: { restaurantId: restaurant.id },
            });
            await tx.restaurant.delete({ where: { id: restaurant.id } });
          },
          { timeout: 30000 },
        );
    } finally {
      await prisma.onModuleDestroy();
    }
  }
});
