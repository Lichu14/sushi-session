import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  activeAt,
  countVisits,
  DAY_MS,
  effectiveCouponStatus,
} from '../dist/rewards/reward-evaluation.js';
import { RewardEvaluationService } from '../dist/rewards/reward-evaluation.service.js';
import { MerchantVisitsService } from '../dist/merchant/merchant-visits.service.js';
import { CouponsService } from '../dist/rewards/coupons.service.js';

const now = new Date('2026-10-02T12:00:00.000Z');
const visit = (hours, id = randomUUID(), locationId = randomUUID()) => ({
  id,
  locationId,
  checkedInAt: new Date(+now + hours * 3600000),
});
test('window includes both UTC bounds, excludes future visits and orders UUID ties', () => {
  const a = visit(-24, '00000000-0000-4000-8000-000000000001');
  const b = visit(-24, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(
    countVisits(
      [visit(1), b, visit(-24.01), visit(0), a],
      { windowDays: 1, minVisitSpacingHours: 0 },
      now,
    )
      .map((v) => v.id)
      .slice(0, 2),
    [a.id, b.id],
  );
  assert.equal(
    countVisits([a, visit(0)], { windowDays: 1, minVisitSpacingHours: 0 }, now)
      .length,
    2,
  );
});
test('spacing is greedy across branches from last counted visit, not last candidate', () => {
  const rows = [-12, -10, -8, -4, 0].map((h) => visit(h));
  assert.deepEqual(
    countVisits(rows, { windowDays: null, minVisitSpacingHours: 4 }, now),
    [rows[0], rows[2], rows[3], rows[4]],
  );
  assert.equal(
    countVisits(
      [visit(-1000)],
      { windowDays: null, minVisitSpacingHours: 0 },
      now,
    ).length,
    1,
  );
});
test('active interval is start-inclusive/end-exclusive; NULL endpoints are open', () => {
  assert.equal(
    activeAt({ status: 'ACTIVE', startsAt: now, endsAt: null }, now),
    true,
  );
  for (const status of ['DRAFT', 'PAUSED', 'ARCHIVED'])
    assert.equal(
      activeAt({ status, startsAt: null, endsAt: null }, now),
      false,
    );
  assert.equal(
    activeAt({ status: 'ACTIVE', startsAt: null, endsAt: now }, now),
    false,
  );
  assert.equal(
    activeAt(
      { status: 'ACTIVE', startsAt: new Date(+now + 1), endsAt: null },
      now,
    ),
    false,
  );
});
test('effective expiry is read-only, inclusive at expiry, and preserves revoked/redeemed', () => {
  assert.equal(effectiveCouponStatus('ISSUED', now, now), 'EXPIRED');
  assert.equal(effectiveCouponStatus('ISSUED', null, now), 'ISSUED');
  assert.equal(
    effectiveCouponStatus('ISSUED', new Date(+now + 1), now),
    'ISSUED',
  );
  for (const state of ['REVOKED', 'REDEEMED', 'EXPIRED'])
    assert.equal(effectiveCouponStatus(state, now, now), state);
});

function evaluationFixture() {
  const recipient = randomUUID(),
    locationId = randomUUID(),
    restaurantId = randomUUID();
  const trigger = { id: randomUUID(), userId: recipient, locationId };
  const reward = {
    id: randomUUID(),
    restaurantId,
    status: 'ACTIVE',
    startsAt: null,
    endsAt: null,
    validDaysAfterIssue: 7,
    locations: [],
  };
  const rule = {
    id: randomUUID(),
    rewardId: reward.id,
    reward,
    status: 'ACTIVE',
    startsAt: null,
    endsAt: null,
    metric: 'VISIT_COUNT',
    operator: 'GTE',
    threshold: 2,
    windowDays: 30,
    minVisitSpacingHours: 4,
    maxAwardsPerUser: 1,
  };
  const state = {
    rows: [visit(-8, undefined, locationId), visit(0, trigger.id, locationId)],
    created: [],
    query: null,
    existing: null,
  };
  const tx = {
    $queryRaw: async (strings) =>
      strings[0].includes('clock_timestamp') ? [{ now }] : [],
    restaurantLocation: { findUniqueOrThrow: async () => ({ restaurantId }) },
    rewardRule: { findMany: async () => [rule] },
    coupon: {
      findUnique: async () => state.existing,
      create: async ({ data }) => {
        state.created.push(data);
      },
    },
    visit: {
      findMany: async (args) => {
        state.query = args;
        return state.rows;
      },
    },
  };
  return { recipient, trigger, reward, rule, state, tx };
}
test('evaluator emits FREE_ITEM eligibility for recipient with canonical key and frozen decision', async () => {
  const f = evaluationFixture();
  await new RewardEvaluationService().evaluate(f.tx, f.trigger);
  const c = f.state.created[0];
  assert.equal(c.userId, f.recipient);
  assert.equal(c.issuanceKey, `rule:${f.rule.id}:user:${f.recipient}`);
  assert.equal(/^[A-Za-z0-9_-]{32}$/.test(c.publicCode), true);
  assert.equal(c.expiresAt - c.issuedAt, 7 * DAY_MS);
  assert.equal(c.eligibilitySnapshot.schemaVersion, 1);
  assert.equal(c.eligibilitySnapshot.triggeringVisitId, f.trigger.id);
  assert.equal(c.eligibilitySnapshot.count, 2);
  assert.equal(f.state.query.where.status, 'VERIFIED');
  assert.equal(f.state.query.where.userId, f.recipient);
  assert.equal(
    f.state.query.where.location.restaurantId,
    f.reward.restaurantId,
  );
  assert.equal('session' in f.state.query.where, false);
});
for (const [name, change] of [
  [
    'threshold not met',
    (f) => {
      f.rule.threshold = 3;
    },
  ],
  [
    'inactive rule',
    (f) => {
      f.rule.status = 'PAUSED';
    },
  ],
  [
    'inactive reward',
    (f) => {
      f.reward.status = 'ARCHIVED';
    },
  ],
  [
    'rule ended',
    (f) => {
      f.rule.endsAt = now;
    },
  ],
  [
    'reward starts later',
    (f) => {
      f.reward.startsAt = new Date(+now + 1);
    },
  ],
  [
    'trigger outside selected scope',
    (f) => {
      f.reward.locations = [{ locationId: randomUUID() }];
    },
  ],
  [
    'any previous issuance, even revoked',
    (f) => {
      f.state.existing = { id: randomUUID(), status: 'REVOKED' };
    },
  ],
])
  test(`no issuance: ${name}`, async () => {
    const f = evaluationFixture();
    change(f);
    await new RewardEvaluationService().evaluate(f.tx, f.trigger);
    assert.equal(f.state.created.length, 0);
  });
test('selected locations filter and no expiry are passed explicitly', async () => {
  const f = evaluationFixture();
  f.reward.locations = [{ locationId: f.trigger.locationId }];
  f.reward.validDaysAfterIssue = null;
  await new RewardEvaluationService().evaluate(f.tx, f.trigger);
  assert.deepEqual(f.state.query.where.locationId.in, [f.trigger.locationId]);
  assert.equal(f.state.created[0].expiresAt, null);
});
test('merchant retry preserves verifiedAt and does not reevaluate; failure rolls back transition', async () => {
  const employee = randomUUID(),
    recipient = randomUUID(),
    id = randomUUID();
  let row = {
    id,
    userId: recipient,
    locationId: randomUUID(),
    status: 'PENDING',
    verifiedAt: null,
  };
  let calls = 0,
    fail = false;
  const tx = {
    $queryRaw: async (strings) =>
      strings[0].includes('clock_timestamp') ? [{ now }] : [],
    visit: {
      findUnique: async () => ({ ...row }),
      findUniqueOrThrow: async () => ({ ...row }),
      update: async ({ data }) => (row = { ...row, ...data }),
    },
  };
  const prisma = {
    $transaction: async (fn) => {
      const before = { ...row };
      try {
        return await fn(tx);
      } catch (e) {
        row = before;
        throw e;
      }
    },
  };
  const service = new MerchantVisitsService(
    prisma,
    { lockReviewAccess: async () => {} },
    {
      evaluate: async (received, current) => {
        calls++;
        assert.equal(received, tx);
        assert.equal(current.userId, recipient);
        assert.notEqual(current.userId, employee);
        if (fail) throw new Error('injected issuance failure');
      },
    },
  );
  fail = true;
  await assert.rejects(service.verify(employee, id, {}), { status: 503 });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.verifiedAt, null);
  fail = false;
  await service.verify(employee, id, {});
  const timestamp = row.verifiedAt;
  await service.verify(employee, id, {});
  assert.equal(calls, 2);
  assert.equal(row.verifiedAt, timestamp);
});
test('coupon query validates own cursor and never accepts caller-supplied recipient', async () => {
  const user = randomUUID();
  let queries = 0;
  const service = new CouponsService({
    coupon: {
      findFirst: async ({ where }) => {
        queries++;
        assert.equal(where.userId, user);
        return null;
      },
    },
  });
  await assert.rejects(
    async () => service.list(user, { userId: randomUUID() }),
    { status: 400 },
  );
  await assert.rejects(service.list(user, { cursor: randomUUID() }), {
    status: 404,
  });
  assert.equal(queries, 1);
});
