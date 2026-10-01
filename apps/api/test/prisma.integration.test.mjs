import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { developmentConnection } from '../scripts/development-database.mjs';

test('NestJS: generated Prisma models and HTTP health (development only)', async (t) => {
  developmentConnection();
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  const prisma = app.get(PrismaService);
  try {
    const port = app.get(ConfigService).get('PORT');
    await app.listen(port, '127.0.0.1');
    await t.test('GET /health stays HTTP 200 with status ok', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
    });
    await t.test('Prisma reads/writes all five mapped models and relations, then rolls back', async () => {
      const userId = randomUUID();
      const slug = randomUUID();
      const rollback = new Error('Intentional fixture rollback');
      await assert.rejects(prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET CONSTRAINTS public.users_auth_user_fkey DEFERRED`;
        await tx.user.create({ data: {
          id: userId, displayName: 'Integration fixture', locale: 'es-AR',
          timeZone: 'America/Argentina/Buenos_Aires', status: 'ACTIVE',
        }});
        const restaurant = await tx.restaurant.create({ data: {
          name: 'Integration fixture', slug, status: 'ACTIVE',
          locations: { create: {
            name: 'Fixture location', slug: 'fixture', addressLine1: 'Fixture',
            city: 'City', region: 'Region', countryCode: 'AR',
            latitude: '-34.603722', longitude: '-58.381592',
            timeZone: 'America/Argentina/Buenos_Aires', status: 'ACTIVE',
          }},
        }, include: { locations: true }});
        assert.match(restaurant.id, /^[0-9a-f-]{36}$/);
        assert.equal(restaurant.locations[0].latitude.toString(), '-34.603722');
        const membership = await tx.merchantMembership.create({ data: {
          userId, restaurantId: restaurant.id, role: 'OWNER', status: 'ACTIVE',
          scopeType: 'SELECTED_LOCATIONS', invitedAt: new Date(), acceptedAt: new Date(),
          locations: { create: { locationId: restaurant.locations[0].id } },
        }, include: { user: true, restaurant: true, locations: { include: { location: true } } }});
        assert.equal(membership.user.id, userId);
        assert.equal(membership.restaurant.id, restaurant.id);
        assert.equal(membership.locations[0].location.restaurantId, restaurant.id);
        assert.equal(membership.invitedByUserId, null);
        assert.ok(membership.createdAt instanceof Date);
        assert.ok(await tx.merchantMembershipLocation.findUnique({ where: {
          membershipId_locationId: { membershipId: membership.id, locationId: restaurant.locations[0].id },
        }}));
        await tx.$executeRaw`SET CONSTRAINTS public.merchant_memberships_scope, public.merchant_membership_locations_scope IMMEDIATE`;
        throw rollback;
      }, { timeout: 20_000 }), (error) => error === rollback);
      assert.equal(await prisma.user.count({ where: { id: userId } }), 0);
      assert.equal(await prisma.restaurant.count({ where: { slug } }), 0);
    });
  } finally {
    await app.close();
  }
});
