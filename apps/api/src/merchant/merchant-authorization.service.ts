import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type MerchantRole } from '../generated/prisma/client.js';

export const MERCHANT_READ_ROLES: MerchantRole[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'STAFF',
  'ANALYST',
];
export const MERCHANT_REVIEW_ROLES: MerchantRole[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'STAFF',
];

@Injectable()
export class MerchantAuthorizationService {
  // Every business query includes this predicate. Client IDs only narrow it.
  locationWhere(
    userId: string,
    review = false,
  ): Prisma.RestaurantLocationWhereInput {
    const membership = {
      userId,
      status: 'ACTIVE' as const,
      role: { in: review ? MERCHANT_REVIEW_ROLES : MERCHANT_READ_ROLES },
    };
    return {
      status: 'ACTIVE',
      restaurant: { status: 'ACTIVE' },
      OR: [
        {
          restaurant: {
            memberships: {
              some: { ...membership, scopeType: 'ALL_LOCATIONS' },
            },
          },
        },
        {
          membershipLocations: {
            some: {
              membership: { ...membership, scopeType: 'SELECTED_LOCATIONS' },
            },
          },
        },
      ],
    };
  }

  async requireMembership(tx: Prisma.TransactionClient, userId: string) {
    const membership = await tx.merchantMembership.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        role: { in: MERCHANT_READ_ROLES },
        restaurant: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership)
      throw new ForbiddenException('No tenés una membresía comercial activa.');
  }

  async lockReviewAccess(
    tx: Prisma.TransactionClient,
    userId: string,
    locationId: string,
  ) {
    // Scope edits update/lock the membership (phase 1 triggers). Holding SHARE
    // prevents revocation, role/scope changes and bridge edits until this commit.
    await tx.$queryRaw`SELECT m.id FROM public.merchant_memberships m
      JOIN public.restaurant_locations l ON l.restaurant_id = m.restaurant_id
      WHERE m.user_id = ${userId}::uuid AND l.id = ${locationId}::uuid FOR SHARE OF m`;
    await tx.$queryRaw`SELECT l.id FROM public.restaurant_locations l
      JOIN public.restaurants r ON r.id = l.restaurant_id
      WHERE l.id = ${locationId}::uuid FOR SHARE OF r, l`;
    const readable = await tx.restaurantLocation.findFirst({
      where: { id: locationId, ...this.locationWhere(userId) },
      select: { id: true },
    });
    if (!readable)
      throw new NotFoundException(
        'No se encontró la visita dentro de tu alcance.',
      );
    const writable = await tx.restaurantLocation.findFirst({
      where: { id: locationId, ...this.locationWhere(userId, true) },
      select: { id: true },
    });
    if (!writable)
      throw new ForbiddenException(
        'Tu rol permite únicamente consultar visitas.',
      );
  }
}
