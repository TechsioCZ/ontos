import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import type {
  GatewayAssertionRedemption,
  GatewayAssertionRedemptionInput,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import { recoverSqlTransactionError } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { lt } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Layer } from 'effect';
import { TaxDatabase } from '../database/client.ts';
import { gatewayAssertionRedemptions } from '../database/schema.ts';

const redemptionTimeout = Duration.seconds(5);
const clockSkewMillis = Duration.toMillis(Duration.seconds(GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS));

const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
const unavailable = (cause?: unknown) => {
  const error = new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};

const makeGatewayAssertionRedemption = Effect.gen(function* makeRedemption() {
  const { executor } = yield* TaxDatabase;
  return {
    consume: Effect.fn('TaxGatewayAssertionRedemption.consume')(function* consume(
      input: GatewayAssertionRedemptionInput,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const expiresAtMillis = Duration.toMillis(Duration.seconds(input.expiresAtEpochSeconds));
      const acceptanceDeadline = expiresAtMillis + clockSkewMillis;
      if (input.audience !== 'tax' || acceptanceDeadline <= now) {
        return yield* replay();
      }
      // Retain each nonce past the longest redemption that could have started before expiry.
      const expiredBefore = DateTime.toDateUtc(
        DateTime.makeUnsafe(now - clockSkewMillis - Duration.toMillis(redemptionTimeout)),
      );
      const expiresAt = DateTime.toDateUtc(DateTime.makeUnsafe(expiresAtMillis));
      const consumed = yield* executor
        .transaction(
          Effect.fn('TaxGatewayAssertionRedemption.redeem')(function* redeem(transaction) {
            yield* transaction
              .delete(gatewayAssertionRedemptions)
              .where(lt(gatewayAssertionRedemptions.expiresAt, expiredBefore));
            return yield* transaction
              .insert(gatewayAssertionRedemptions)
              .values({ audience: input.audience, expiresAt, issuer: input.issuer, jti: input.jti })
              .onConflictDoNothing()
              .returning({ jti: gatewayAssertionRedemptions.jti });
          }),
        )
        .pipe(
          recoverSqlTransactionError,
          Effect.mapError(unavailable),
          Effect.timeoutOrElse({ duration: redemptionTimeout, orElse: () => Effect.fail(unavailable()) }),
        );
      const redeemedAt = yield* Clock.currentTimeMillis;
      if (consumed.length !== 1 || acceptanceDeadline <= redeemedAt) {
        return yield* replay();
      }
      return yield* Effect.void;
    }),
  } satisfies GatewayAssertionRedemption;
});

export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  makeGatewayAssertionRedemption,
);
