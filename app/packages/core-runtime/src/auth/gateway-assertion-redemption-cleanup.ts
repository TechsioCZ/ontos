import { Clock, DateTime, Duration, Effect, Option, Schedule } from 'effect';
import type { Scope } from 'effect';

import type { GatewayAssertionRedemptionUnavailableError } from './gateway-assertion-redemption-unavailable-error.ts';

/**
 * Replay evidence is pruned by the owner's scoped runtime, not by authentication requests.
 * Failed cleanup retains evidence and retries next minute; it never authorizes a redemption.
 */
export const startGatewayAssertionRedemptionCleanup = Effect.fn('GatewayAssertionRedemptionCleanup.start')(
  function* startGatewayAssertionRedemptionCleanupEffect(
    owner: string,
    clockSkewSeconds: number,
    prune: (expiredBefore: Date) => Effect.Effect<void, GatewayAssertionRedemptionUnavailableError>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const tick = Effect.gen(function* pruneExpiredGatewayAssertionEvidence() {
      const now = yield* Clock.currentTimeMillis;
      yield* prune(DateTime.toDateUtc(DateTime.makeUnsafe(now - clockSkewSeconds * 1000)));
    }).pipe(
      Effect.timeoutOption(Duration.seconds(5)),
      Effect.flatMap((result) =>
        Option.isNone(result)
          ? Effect.logWarning('Gateway assertion evidence cleanup timed out', { owner })
          : Effect.void,
      ),
      Effect.catchTag('GatewayAssertionRedemptionUnavailableError', (failure) =>
        Effect.logWarning('Gateway assertion evidence cleanup failed', { owner, reason: failure.reason }),
      ),
    );
    // Delay the first cleanup too. Layer acquisition and the first request do no pruning.
    yield* tick.pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    );
  },
);
