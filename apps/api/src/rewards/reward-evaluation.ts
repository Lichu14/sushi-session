import type {
  CouponStatus,
  Reward,
  RewardRule,
} from '../generated/prisma/client.js';

export const DAY_MS = 86_400_000;
export type CountedVisit = {
  id: string;
  locationId: string;
  checkedInAt: Date;
};

export function activeAt(
  definition: Pick<RewardRule, 'status' | 'startsAt' | 'endsAt'>,
  now: Date,
) {
  return (
    definition.status === 'ACTIVE' &&
    (!definition.startsAt || definition.startsAt <= now) &&
    (!definition.endsAt || now < definition.endsAt)
  );
}

// UTC elapsed days/hours; inclusive history window, inclusive minimum spacing.
// Callers supply only the user's VERIFIED visits in the reward's location scope.
export function countVisits(
  visits: CountedVisit[],
  rule: Pick<RewardRule, 'windowDays' | 'minVisitSpacingHours'>,
  now: Date,
) {
  const start =
    rule.windowDays === null
      ? -Infinity
      : now.getTime() - rule.windowDays * DAY_MS;
  const ordered = visits
    .filter((v) => v.checkedInAt.getTime() >= start && v.checkedInAt <= now)
    .sort(
      (a, b) =>
        a.checkedInAt.getTime() - b.checkedInAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const counted: CountedVisit[] = [];
  for (const visit of ordered) {
    const previous = counted.at(-1);
    if (
      !previous ||
      visit.checkedInAt.getTime() - previous.checkedInAt.getTime() >=
        rule.minVisitSpacingHours * 3_600_000
    )
      counted.push(visit);
  }
  return counted;
}

export function eligibilitySnapshot(
  rule: RewardRule,
  reward: Reward,
  locationIds: string[],
  userId: string,
  visitId: string,
  now: Date,
  visits: CountedVisit[],
) {
  return {
    schemaVersion: 1,
    source: 'RULE',
    userId,
    rewardRuleId: rule.id,
    rewardId: reward.id,
    evaluatedAt: now.toISOString(),
    triggeringVisitId: visitId,
    eligible: true,
    rule: {
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      windowDays: rule.windowDays,
      minVisitSpacingHours: rule.minVisitSpacingHours,
      maxAwardsPerUser: rule.maxAwardsPerUser,
      startsAt: rule.startsAt?.toISOString() ?? null,
      endsAt: rule.endsAt?.toISOString() ?? null,
    },
    scope: {
      restaurantId: reward.restaurantId,
      locationIds: [...locationIds].sort(),
    },
    rewardWindow: {
      startsAt: reward.startsAt?.toISOString() ?? null,
      endsAt: reward.endsAt?.toISOString() ?? null,
    },
    count: visits.length,
    countedVisits: visits.map((v) => ({
      id: v.id,
      locationId: v.locationId,
      checkedInAt: v.checkedInAt.toISOString(),
    })),
  };
}

export function effectiveCouponStatus(
  status: CouponStatus,
  expiresAt: Date | null,
  now: Date,
): CouponStatus {
  return status === 'ISSUED' && expiresAt && expiresAt <= now
    ? 'EXPIRED'
    : status;
}
