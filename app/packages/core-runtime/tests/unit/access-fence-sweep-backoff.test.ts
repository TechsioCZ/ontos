import { Duration } from 'effect';
import { expect, it } from 'effect-rstest';

import { accessFenceSweepBackoff, accessFenceSweepBackoffsAfter } from '../../src/access/lifecycle/fence-sweeper.ts';

/*
 * The sweep's wait for a tenant it could not heal: it doubles from a minute, never beyond five, and one heal of any
 * tenant clears every wait, so tenants that failed while the engine was down are tried again as soon as it is back.
 */
it('doubles a tenant’s wait from one minute up to five, never more', () => {
  expect(Array.from({ length: 6 }, (_, index) => Duration.toMinutes(accessFenceSweepBackoff(index + 1)))).toEqual([
    1, 2, 4, 5, 5, 5,
  ]);
});

it('clears every tenant’s wait once any tenant is healed', () => {
  const failedTwice = accessFenceSweepBackoffsAfter(
    accessFenceSweepBackoffsAfter(new Map(), { healed: false, now: 0, tenantId: 'b' }),
    { healed: false, now: 60_000, tenantId: 'b' },
  );
  expect(failedTwice.get('b')).toEqual({ failures: 2, retryAt: 180_000 });
  expect(accessFenceSweepBackoffsAfter(failedTwice, { healed: true, now: 90_000, tenantId: 'a' }).size).toBe(0);
});
