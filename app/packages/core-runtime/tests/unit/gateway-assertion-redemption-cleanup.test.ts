import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { Clock, Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { startGatewayAssertionRedemptionCleanup } from '../../src/auth/gateway-assertion-redemption-cleanup.ts';
import { GatewayAssertionRedemptionUnavailableError } from '../../src/auth/gateway-assertion-redemption-unavailable-error.ts';

it.effect('prunes once per minute with the full skew window and stops with the owner scope', () =>
  Effect.gen(function* scopedPeriodicCleanup() {
    const clock = yield* TestClock.make();
    const start = 1_700_000_000_000;
    yield* clock.setTime(start);
    const cutoffs: number[] = [];
    yield* Effect.scoped(
      Effect.gen(function* runOwner() {
        yield* startGatewayAssertionRedemptionCleanup('test-owner', (cutoff) =>
          Effect.sync(() => {
            cutoffs.push(cutoff.getTime());
          }),
        );
        expect(cutoffs).toEqual([]);
        yield* clock.adjust('59999 millis');
        expect(cutoffs).toEqual([]);
        yield* clock.adjust('1 milli');
        expect(cutoffs).toEqual([start + 60_000 - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000]);
        yield* clock.adjust('1 minute');
        expect(cutoffs).toEqual([
          start + 60_000 - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000,
          start + 120_000 - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000,
        ]);
      }).pipe(Effect.provideService(Clock.Clock, clock)),
    );
    yield* clock.adjust('5 minutes');
    expect(cutoffs).toHaveLength(2);
  }),
);

it.effect('retains evidence after cleanup failure and retries on the next interval', () =>
  Effect.scoped(
    Effect.gen(function* retryOwnerCleanup() {
      const clock = yield* TestClock.make();
      let attempts = 0;
      yield* startGatewayAssertionRedemptionCleanup('test-owner', () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(new GatewayAssertionRedemptionUnavailableError({ reason: 'fixture unavailable' }))
            : Effect.void;
        }),
      ).pipe(Effect.provideService(Clock.Clock, clock));
      yield* clock.adjust('1 minute');
      expect(attempts).toBe(1);
      yield* clock.adjust('1 minute');
      expect(attempts).toBe(2);
    }),
  ),
);

it.effect('bounds a stalled cleanup and never overlaps its next attempt', () =>
  Effect.scoped(
    Effect.gen(function* boundOwnerCleanup() {
      const clock = yield* TestClock.make();
      let active = 0;
      let attempts = 0;
      yield* startGatewayAssertionRedemptionCleanup('test-owner', () =>
        Effect.gen(function* stalledPrune() {
          attempts += 1;
          active += 1;
          return yield* Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active -= 1;
              }),
            ),
          );
        }),
      ).pipe(Effect.provideService(Clock.Clock, clock));
      yield* clock.adjust('1 minute');
      expect(attempts).toBe(1);
      expect(active).toBe(1);
      yield* clock.adjust('5 seconds');
      expect(active).toBe(0);
      yield* clock.adjust('1 minute');
      expect(attempts).toBe(2);
      expect(active).toBe(1);
    }),
  ),
);
