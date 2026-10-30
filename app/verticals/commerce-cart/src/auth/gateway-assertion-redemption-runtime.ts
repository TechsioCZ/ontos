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
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Clock, Context, DateTime, Duration, Effect, Layer, Redacted } from 'effect';
import { gatewayAssertionRedemptions } from '../database/schema.ts';

const cartGatewayAssertionRedemptionRelations = defineRelations({ gatewayAssertionRedemptions });
export type CartGatewayAssertionRedemptionDatabaseExecutor = EffectPgDatabase<
  typeof cartGatewayAssertionRedemptionRelations
>;
class CartGatewayAssertionRedemptionDatabase extends Context.Service<
  CartGatewayAssertionRedemptionDatabase,
  { readonly executor: CartGatewayAssertionRedemptionDatabaseExecutor }
>()('@app/commerce-cart/auth/gateway-assertion-redemption-runtime/CartGatewayAssertionRedemptionDatabase') {}

const replayError = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
const unavailableError = (cause?: unknown) => {
  const error = new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
};

/** Separate pre-scope ingress storage. No canonical Cart transaction or RLS context is fabricated. */
const makeGatewayAssertionRedemption = (
  executor: CartGatewayAssertionRedemptionDatabaseExecutor,
): GatewayAssertionRedemption => ({
  consume: Effect.fn('CartGatewayAssertionRedemption.consume')(function* consumeCartGatewayAssertionEffect(
    input: GatewayAssertionRedemptionInput,
  ) {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    if (
      input.audience !== 'commerce-cart' ||
      input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(nowEpochMs / 1000)
    ) {
      return yield* replayError();
    }
    // One unique insert is the durable atomic consume. Evidence is conservatively
    // retained; no cleanup race can re-enable an old JTI, even at expiry boundaries.
    const inserted = yield* executor
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
        Effect.mapError(unavailableError),
        Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.fail(unavailableError()) }),
      );
    if (inserted.length !== 1) {
      return yield* replayError();
    }
    return yield* Effect.void;
  }),
});

/** Pool acquisition is scoped; default owner API composition supplies configuration. */
export const gatewayAssertionRedemptionPgClient = Effect.gen(function* makeCartRedemptionPgClientEffect() {
  const configuration = yield* DatabaseConfig;
  const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
    Effect.mapError(unavailableError),
  );
  return yield* PgClient.make(poolConfiguration).pipe(Effect.mapError(unavailableError));
});
export const GatewayAssertionRedemptionDatabaseLive = Layer.effect(
  CartGatewayAssertionRedemptionDatabase,
  makeWithDefaults({ relations: cartGatewayAssertionRedemptionRelations }).pipe(
    Effect.map((executor) => ({ executor })),
  ),
);
export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  CartGatewayAssertionRedemptionDatabase.pipe(Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor))),
);
