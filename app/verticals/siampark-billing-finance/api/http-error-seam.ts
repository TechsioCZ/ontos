import { GatewayAssertionRedemptionUnavailableError } from '@app/core-runtime';
import { Effect } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

// The HTTP admission seam converts only native SQL settlement defects. Every other defect
// retains its original Cause for the framework's outer instrumentation boundary.
export const settleFinanceRedemption = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.catchDefect((defect) =>
      isSqlError(defect)
        ? Effect.fail(
            Object.defineProperty(
              new GatewayAssertionRedemptionUnavailableError({
                reason: 'Bearer assertion redemption is temporarily unavailable',
              }),
              'cause',
              { value: defect },
            ),
          )
        : Effect.die(defect),
    ),
  );
