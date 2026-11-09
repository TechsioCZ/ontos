import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  configureDatabasePool,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Clock, DateTime, Effect, Layer, Redacted } from 'effect';

import { gatewayAssertionRedemptions } from '../db/schema.ts';

const relations = defineRelations({ gatewayAssertionRedemptions });
const unavailable = (cause?: unknown) => {
  const error = new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};
const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });

export const gatewayAssertionRedemptionPgClient = Effect.gen(function* makeRedemptionClient() {
  const config = yield* DatabaseConfig;
  const pool = yield* configureDatabasePool(Redacted.make(config.connectionString)).pipe(Effect.mapError(unavailable));
  return yield* PgClient.make(pool).pipe(Effect.mapError(unavailable));
});

const makeGatewayAssertionRedemption = Effect.gen(function* makeGatewayAssertionRedemption() {
  const database = yield* makeWithDefaults({ relations });
  return {
    consume: Effect.fn('SymmyGatewayAssertionRedemption.consume')(function* consume(
      input: GatewayAssertionRedemptionInput,
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (
        input.audience !== 'symmy-integration' ||
        input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)
      ) {
        return yield* replay();
      }
      const consumed = yield* database
        .insert(gatewayAssertionRedemptions)
        .values({
          audience: input.audience,
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000)),
          issuer: input.issuer,
          jti: input.jti,
        })
        .onConflictDoNothing()
        .returning({ jti: gatewayAssertionRedemptions.jti })
        .pipe(
          Effect.mapError(unavailable),
          Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(unavailable()) }),
        );
      if (consumed.length !== 1) {
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
