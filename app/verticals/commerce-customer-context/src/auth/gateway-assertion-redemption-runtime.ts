import {
  DatabaseConfig,
  configureDatabasePool,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { lt } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Clock, DateTime, Effect, Layer, Redacted } from 'effect';

import {
  gatewayAssertionRedemptionRelations,
  gatewayAssertionRedemptions,
} from '../database/gateway-assertion-schema.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new GatewayAssertionRedemptionUnavailableError({
      reason: 'Bearer assertion redemption is temporarily unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });

// Security infrastructure runs before business scope installation. The pool is used only for
// replay evidence, never for Commerce data or a business handler's persistence services.
export const GatewayAssertionRedemptionDatabaseLive = PgClient.layerFrom(
  Effect.gen(function* makeRedemptionPool() {
    const config = yield* DatabaseConfig;
    const pool = yield* configureDatabasePool(Redacted.make(config.connectionString)).pipe(
      Effect.mapError(unavailable),
    );
    return yield* PgClient.make(pool).pipe(Effect.mapError(unavailable));
  }),
);

/** One-time redemption of a Shell-issued gateway assertion, keyed by (issuer, audience, jti). */
export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  Effect.gen(function* makeRedemption() {
    const executor = yield* makeWithDefaults({ relations: gatewayAssertionRedemptionRelations });
    return {
      consume: Effect.fn('commerce-customer-context.redeemAssertion')(function* consume(
        input: GatewayAssertionRedemptionInput,
      ) {
        const now = yield* Clock.currentTimeMillis;
        // Verification can finish after its captured clock passes the assertion's skew window.
        // Reject before cleanup can delete this assertion's existing replay evidence.
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)) {
          return yield* replay();
        }
        const inserted = yield* executor
          .transaction(
            Effect.fn('commerce-customer-context.redemptionTransaction')(function* redeem(transaction) {
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
            Effect.mapError(unavailable),
            Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(unavailable()) }),
          );
        if (inserted.length !== 1) {
          return yield* replay();
        }
        return yield* Effect.void;
      }),
    };
  }),
);
