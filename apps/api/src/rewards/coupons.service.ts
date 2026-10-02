import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { databaseOperation } from '../visits/database-operation.js';
import { historyInput } from '../visits/inputs.js';
import { effectiveCouponStatus } from './reward-evaluation.js';

const select = {
  id: true,
  publicCode: true,
  status: true,
  issuedAt: true,
  expiresAt: true,
  ruleOrigin: {
    select: {
      rule: {
        select: {
          reward: {
            select: {
              id: true,
              name: true,
              description: true,
              rewardType: true,
              value: true,
              currency: true,
              itemReference: true,
              termsText: true,
              restaurant: { select: { id: true, name: true } },
              locations: {
                select: { location: { select: { id: true, name: true } } },
                orderBy: { locationId: 'asc' },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CouponSelect;

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, query: unknown) {
    const { limit, cursor } = historyInput(query);
    return databaseOperation(async () => {
      const anchor = cursor
        ? await this.prisma.coupon.findFirst({
            where: { id: cursor, userId },
            select: { id: true, issuedAt: true },
          })
        : null;
      if (cursor && !anchor)
        throw new NotFoundException(
          'El cursor no pertenece a tu historial de cupones.',
        );
      const [clock] = await this.prisma.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      const rows = await this.prisma.coupon.findMany({
        where: {
          userId,
          ...(anchor
            ? {
                OR: [
                  { issuedAt: { lt: anchor.issuedAt } },
                  { issuedAt: anchor.issuedAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        select,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit).map((row) => {
        if (!row.ruleOrigin) throw new Error('Missing coupon origin');
        const reward = row.ruleOrigin.rule.reward;
        return {
          id: row.id,
          publicCode: row.publicCode,
          status: effectiveCouponStatus(row.status, row.expiresAt, clock.now),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          reward: {
            id: reward.id,
            name: reward.name,
            description: reward.description,
            type: reward.rewardType,
            value: reward.value?.toFixed(2) ?? null,
            currency: reward.currency,
            itemReference: reward.itemReference,
            termsText: reward.termsText,
          },
          restaurant: reward.restaurant,
          scope: {
            type: reward.locations.length
              ? 'SELECTED_LOCATIONS'
              : 'ALL_LOCATIONS',
            locations: reward.locations.map((l) => l.location),
          },
        };
      });
      return {
        items,
        nextCursor: rows.length > limit ? items.at(-1)!.id : null,
      };
    });
  }
}
