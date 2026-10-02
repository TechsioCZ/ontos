import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  configureDatabasePool,
} from '@app/core-runtime';
import type {
  DatabasePoolDeadlines,
  GatewayAssertionRedemption,
  GatewayAssertionRedemptionInput,
} from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { defineRelations, lt } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Clock, Context, DateTime, Duration, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { gatewayAssertionRedemptions } from '../database/schema.ts';

const pricingGatewayAssertionRedemptionRelations = defineRelations({ gatewayAssertionRedemptions });

export type PricingGatewayAssertionRedemptionDatabaseExecutor = EffectPgDatabase<
  typeof pricingGatewayAssertionRedemptionRelations
>;

class PricingGatewayAssertionRedemptionDatabase extends Context.Service<
  PricingGatewayAssertionRedemptionDatabase,
  { readonly executor: PricingGatewayAssertionRedemptionDatabaseExecutor }
>()('@app/pricing/auth/gateway-assertion-redemption-runtime/PricingGatewayAssertionRedemptionDatabase') {}

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
  executor: PricingGatewayAssertionRedemptionDatabaseExecutor,
  input: GatewayAssertionRedemptionInput,
  expiredBefore: Date,
  expiresAt: Date,
) =>
  executor.transaction(
    Effect.fn('PricingGatewayAssertionRedemptionRuntime.redeemAssertion')(function* redeemAssertionEffect(transaction) {
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
    }),
  );

export const makeGatewayAssertionRedemption = (
  executor: PricingGatewayAssertionRedemptionDatabaseExecutor,
): GatewayAssertionRedemption => ({
  consume: Effect.fn('PricingGatewayAssertionRedemption.consume')(function* consumeGatewayAssertionEffect(
    input: GatewayAssertionRedemptionInput,
  ) {
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
      Effect.mapError(unavailableError),
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(unavailableError(defect)) : Effect.die(defect))),
      Effect.timeoutOrElse({
        duration: REDEMPTION_TIMEOUT,
        orElse: () => Effect.fail(unavailableError()),
      }),
    );
    if (inserted.length !== 1) {
      return yield* replayError();
    }
    return yield* Effect.void;
  }),
});

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

const makeGatewayAssertionRedemptionDatabase = Effect.fn('PricingGatewayAssertionRedemptionDatabase.make')(
  function* makeGatewayAssertionRedemptionDatabaseEffect(
    configuration: ContextServiceContract<typeof DatabaseConfig> & {
      readonly maxConnections?: number;
      readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
    },
  ): Effect.fn.Return<
    ContextServiceContract<typeof PricingGatewayAssertionRedemptionDatabase>,
    GatewayAssertionRedemptionUnavailableError,
    Scope.Scope
  > {
    const poolConfiguration = yield* configureDatabasePool(
      Redacted.make(configuration.connectionString),
      configuration.poolDeadlines,
    ).pipe(Effect.mapError((error) => unavailableError(error)));
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ ...poolConfiguration, maxConnections: configuration.maxConnections }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(unavailableError),
    );
    return {
      executor: yield* makeWithDefaults({ relations: pricingGatewayAssertionRedemptionRelations }).pipe(
        Effect.provideService(PgClient.PgClient, client),
      ),
    };
  },
);

export const GatewayAssertionRedemptionDatabaseLive = Layer.effect(
  PricingGatewayAssertionRedemptionDatabase,
  Effect.gen(function* makeGatewayAssertionRedemptionDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeGatewayAssertionRedemptionDatabase(configuration);
  }),
);

export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  PricingGatewayAssertionRedemptionDatabase.pipe(
    Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor)),
  ),
);
