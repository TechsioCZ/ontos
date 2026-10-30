import {
  recoverSqlTransactionError,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  configureDatabasePool,
  openDatabaseClient,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { defineRelations, lt } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Clock, Context, DateTime, Duration, Effect, Layer, Redacted } from 'effect';

import { gatewayAssertionRedemptions } from '../database/schema.ts';

const commerceCustomerContextGatewayAssertionRedemptionRelations = defineRelations({ gatewayAssertionRedemptions });

export type CommerceCustomerContextGatewayAssertionRedemptionDatabaseExecutor = EffectPgDatabase<
  typeof commerceCustomerContextGatewayAssertionRedemptionRelations
>;

class CommerceCustomerContextGatewayAssertionRedemptionDatabase extends Context.Service<
  CommerceCustomerContextGatewayAssertionRedemptionDatabase,
  { readonly executor: CommerceCustomerContextGatewayAssertionRedemptionDatabaseExecutor }
>()(
  '@app/commerce-customer-context/auth/gateway-assertion-redemption-runtime/CommerceCustomerContextGatewayAssertionRedemptionDatabase',
) {}

const replayError = () =>
  new GatewayAssertionReplayError({
    reason: 'The Bearer assertion is no longer usable',
  });

const unavailableError = (cause?: unknown) => {
  const error = new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};

const REDEMPTION_TIMEOUT = Duration.seconds(5);

const redeemAssertion = (
  executor: CommerceCustomerContextGatewayAssertionRedemptionDatabaseExecutor,
  input: GatewayAssertionRedemptionInput,
  expiredBefore: Date,
  expiresAt: Date,
) =>
  executor.transaction(
    Effect.fn('CommerceCustomerContextGatewayAssertionRedemptionRuntime.redeemAssertion')(
      function* redeemAssertionEffect(transaction) {
        yield* transaction
          .delete(gatewayAssertionRedemptions)
          .where(lt(gatewayAssertionRedemptions.expiresAt, expiredBefore));
        return yield* transaction
          .insert(gatewayAssertionRedemptions)
          .values({
            audience: input.audience,
            expiresAt,
            issuer: input.issuer,
            jti: input.jti,
          })
          .onConflictDoNothing()
          .returning({ jti: gatewayAssertionRedemptions.jti });
      },
    ),
  );

export const makeGatewayAssertionRedemption = (
  executor: CommerceCustomerContextGatewayAssertionRedemptionDatabaseExecutor,
): GatewayAssertionRedemption => ({
  consume: Effect.fn('CommerceCustomerContextGatewayAssertionRedemption.consume')(
    function* consumeGatewayAssertionEffect(input: GatewayAssertionRedemptionInput) {
      const nowEpochMs = yield* Clock.currentTimeMillis;
      // Verification can finish after its captured clock passes the assertion's skew window.
      // Reject before cleanup can delete this assertion's existing replay evidence.
      if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(nowEpochMs / 1000)) {
        return yield* replayError();
      }
      const expiredBefore = DateTime.toDateUtc(
        DateTime.makeUnsafe(nowEpochMs - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000),
      );
      const expiresAt = DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000));
      const inserted = yield* redeemAssertion(executor, input, expiredBefore, expiresAt).pipe(
        recoverSqlTransactionError,
        Effect.mapError(unavailableError),
        Effect.timeoutOrElse({
          duration: REDEMPTION_TIMEOUT,
          orElse: () => Effect.fail(unavailableError()),
        }),
      );
      if (inserted.length !== 1) {
        return yield* replayError();
      }
      return yield* Effect.void;
    },
  ),
});

/** Pool acquisition remains scoped and its dependencies are composed by api/index.ts. */
export const gatewayAssertionRedemptionPgClient = Effect.gen(function* makeRedemptionPgClient() {
  const configuration = yield* DatabaseConfig;
  const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
    Effect.mapError(unavailableError),
  );
  return yield* PgClient.make(poolConfiguration).pipe(Effect.mapError(unavailableError));
});

export const GatewayAssertionRedemptionDatabaseLive = Layer.effect(
  CommerceCustomerContextGatewayAssertionRedemptionDatabase,
  makeWithDefaults({ relations: commerceCustomerContextGatewayAssertionRedemptionRelations }).pipe(
    Effect.map((executor) => ({ executor })),
  ),
);

export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  CommerceCustomerContextGatewayAssertionRedemptionDatabase.pipe(
    Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor)),
  ),
);
