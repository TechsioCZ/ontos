import {
  recoverSqlTransactionError,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  configureDatabasePool,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { defineRelations, lt } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Clock, Context, DateTime, Duration, Effect, Layer, Redacted } from 'effect';
import { inventoryGatewayAssertionRedemptions as gatewayAssertionRedemptions } from '../persistence/gateway-assertion-redemption-table.ts';

const relations = defineRelations({ gatewayAssertionRedemptions });
export type InventoryRedemptionExecutor = EffectPgDatabase<typeof relations>;
class InventoryRedemptionDatabase extends Context.Service<
  InventoryRedemptionDatabase,
  { readonly executor: InventoryRedemptionExecutor }
>()('@app/inventory/auth/gateway-assertion-redemption-runtime/InventoryRedemptionDatabase') {}
const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new GatewayAssertionRedemptionUnavailableError({ reason: 'Bearer assertion redemption is unavailable' }),
    'cause',
    { value: Redacted.make(cause) },
  );
/** Signature/audience verification precedes this atomic owner-local replay gate. */
export const makeGatewayAssertionRedemption = (executor: InventoryRedemptionExecutor): GatewayAssertionRedemption => ({
  consume: Effect.fn('InventoryGatewayAssertionRedemption.consume')(function* consume(
    input: GatewayAssertionRedemptionInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (
      input.audience !== 'inventory' ||
      input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)
    ) {
      return yield* replay();
    }
    const expiredBefore = DateTime.toDateUtc(DateTime.makeUnsafe(now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000));
    const expiresAt = DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000));
    const inserted = yield* executor
      .transaction(
        Effect.fn('InventoryGatewayAssertionRedemption.redeem')(function* redeem(transaction) {
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
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError(unavailable),
        Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.fail(unavailable()) }),
      );
    if (inserted.length !== 1) {
      return yield* replay();
    }
    return yield* Effect.void;
  }),
});
export const gatewayAssertionRedemptionPgClient = Effect.gen(function* client() {
  const configuration = yield* DatabaseConfig;
  const pool = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
    Effect.mapError(unavailable),
  );
  return yield* PgClient.make(pool).pipe(Effect.mapError(unavailable));
});
export const GatewayAssertionRedemptionDatabaseLive = Layer.effect(
  InventoryRedemptionDatabase,
  makeWithDefaults({ relations }).pipe(Effect.map((executor) => ({ executor }))),
);
export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  InventoryRedemptionDatabase.pipe(Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor))),
);
