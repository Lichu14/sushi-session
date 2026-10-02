import { Injectable, ConflictException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import {
  activeAt,
  countVisits,
  DAY_MS,
  eligibilitySnapshot,
} from './reward-evaluation.js';

@Injectable()
export class RewardEvaluationService {
  // Caller holds the recipient User lock BEFORE changing Visit, in this same RC transaction.
  // No independent transaction, external calls, notification or batch issuance.
  async evaluate(
    tx: Prisma.TransactionClient,
    visit: { id: string; userId: string; locationId: string },
  ) {
    const location = await tx.restaurantLocation.findUniqueOrThrow({
      where: { id: visit.locationId },
      select: { restaurantId: true },
    });
    // Lock owners before rules, in UUID order. Scope edits also write/lock Reward.
    await tx.$queryRaw`SELECT id FROM public.rewards WHERE restaurant_id = ${location.restaurantId}::uuid ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT rr.id FROM public.reward_rules rr JOIN public.rewards r ON r.id = rr.reward_id
      WHERE r.restaurant_id = ${location.restaurantId}::uuid ORDER BY rr.id FOR UPDATE OF rr`;
    const [clock] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    const now = clock.now;
    const rules = await tx.rewardRule.findMany({
      where: { reward: { restaurantId: location.restaurantId } },
      include: { reward: { include: { locations: true } } },
      orderBy: { id: 'asc' },
    });
    for (const rule of rules) {
      const reward = rule.reward;
      const locations = reward.locations.map((l) => l.locationId);
      if (
        rule.metric !== 'VISIT_COUNT' ||
        rule.operator !== 'GTE' ||
        rule.maxAwardsPerUser !== 1 ||
        !activeAt(rule, now) ||
        !activeAt(reward, now) ||
        (locations.length && !locations.includes(visit.locationId))
      )
        continue;
      const issuanceKey = `rule:${rule.id}:user:${visit.userId}`;
      // Includes expired/revoked coupons. The unique constraint remains authoritative.
      if (
        await tx.coupon.findUnique({
          where: { issuanceKey },
          select: { id: true },
        })
      )
        continue;
      const candidates = await tx.visit.findMany({
        where: {
          userId: visit.userId,
          status: 'VERIFIED',
          location: { restaurantId: reward.restaurantId },
          ...(locations.length ? { locationId: { in: locations } } : {}),
          checkedInAt: {
            lte: now,
            ...(rule.windowDays === null
              ? {}
              : { gte: new Date(now.getTime() - rule.windowDays * DAY_MS) }),
          },
        },
        select: { id: true, locationId: true, checkedInAt: true },
        orderBy: [{ checkedInAt: 'asc' }, { id: 'asc' }],
      });
      const counted = countVisits(candidates, rule, now);
      if (counted.length < rule.threshold) continue;
      // 24 random bytes = 192 bits, encoded in exactly 32 URL-safe characters.
      const publicCode = randomBytes(24).toString('base64url');
      // A collision fails/rolls back the full transaction; never swallow insertion failures.
      if (publicCode.length !== 32)
        throw new ConflictException('No se pudo emitir el cupón.');
      await tx.coupon.create({
        data: {
          userId: visit.userId,
          source: 'RULE',
          status: 'ISSUED',
          publicCode,
          issuanceKey,
          issuedAt: now,
          expiresAt:
            reward.validDaysAfterIssue === null
              ? null
              : new Date(now.getTime() + reward.validDaysAfterIssue * DAY_MS),
          eligibilitySnapshot: eligibilitySnapshot(
            rule,
            reward,
            locations,
            visit.userId,
            visit.id,
            now,
            counted,
          ),
          ruleOrigin: { create: { rewardRuleId: rule.id } },
        },
      });
    }
  }
}
