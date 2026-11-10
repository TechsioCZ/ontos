import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemption } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { recoverSqlTransactionError } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { lt } from 'drizzle-orm';
import { Clock, DateTime, Effect, Layer } from 'effect';
import { PromotionDatabase } from '../database/client.ts';
import { gatewayAssertionRedemptions } from '../services/persistence-schema.service.ts';

const unavailable = <Cause>(cause?: Cause) =>
  Object.defineProperty(
    new GatewayAssertionRedemptionUnavailableError({ reason: 'Bearer assertion redemption is unavailable' }),
    'cause',
    { enumerable: false, value: cause },
  );
const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });

// This pool is authentication infrastructure. Business operations use Core-scoped services.
export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  Effect.gen(function* makePromotionRedemption() {
    const { executor } = yield* PromotionDatabase;
    return {
      consume: Effect.fn('PromotionGatewayAssertionRedemption.consume')(function* consume(input) {
        const now = yield* Clock.currentTimeMillis;
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)) {
          return yield* replay();
        }
        const inserted = yield* executor
          .transaction(
            Effect.fn(function* redeem(transaction) {
              yield* transaction
                .delete(gatewayAssertionRedemptions)
                .where(
                  lt(
                    gatewayAssertionRedemptions.expiresAt,
                    DateTime.toDateUtc(DateTime.makeUnsafe(now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000)),
                  ),
                );
              return yield* transaction
                .insert(gatewayAssertionRedemptions)
                .values({
                  audience: input.audience,
                  expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000)),
                  issuer: input.issuer,
                  jti: input.jti,
                })
                .onConflictDoNothing()
                .returning({ jti: gatewayAssertionRedemptions.jti });
            }),
          )
          .pipe(
            recoverSqlTransactionError,
            Effect.mapError(unavailable),
            Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(unavailable()) }),
          );
        if (inserted.length !== 1) {
          return yield* replay();
        }
        return yield* Effect.void;
      }),
    } satisfies GatewayAssertionRedemption;
  }),
);
