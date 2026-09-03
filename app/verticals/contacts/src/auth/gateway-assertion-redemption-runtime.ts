/* eslint-disable promise/prefer-await-to-then -- The owner-local Drizzle transaction must atomically clean and insert. */
import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  loadDatabaseConfig,
} from '@app/core-runtime';
import type {
  GatewayAssertionRedemption,
  GatewayAssertionRedemptionInput,
} from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { lt } from 'drizzle-orm';
import { Clock, DateTime, Effect, Layer } from 'effect';
import { ContactsDatabase, ContactsDatabaseLive } from '../db/client.ts';
import { gatewayAssertionRedemptions } from '../db/schema.ts';
import type { ContactsDatabaseExecutor } from '../db/types.ts';

const replayError = () =>
  new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
const unavailableError = () =>
  new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });

export const makeGatewayAssertionRedemption = (
  executor: ContactsDatabaseExecutor,
): GatewayAssertionRedemption => ({
  consume: (input: GatewayAssertionRedemptionInput) =>
    Effect.gen(function* consumeGatewayAssertionEffect() {
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const expiredBefore = DateTime.toDateUtc(
        DateTime.makeUnsafe(nowEpochMs - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000),
      );
      const expiresAt = DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000));
      yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof GatewayAssertionReplayError ? error : unavailableError(),
        try: () =>
          executor.transaction((transaction) =>
            transaction
              .delete(gatewayAssertionRedemptions)
              .where(lt(gatewayAssertionRedemptions.expiresAt, expiredBefore))
              .then(() =>
                transaction
                  .insert(gatewayAssertionRedemptions)
                  .values({
                    audience: input.audience,
                    expiresAt,
                    issuer: input.issuer,
                    jti: input.jti,
                  })
                  .onConflictDoNothing()
                  .returning({ jti: gatewayAssertionRedemptions.jti }),
              )
              .then((inserted) => {
                if (inserted.length !== 1) {
                  throw replayError();
                }
              }),
          ),
      });
    }),
});

const contactsDatabaseLive = ContactsDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
  Layer.orDie,
);

export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  ContactsDatabase.pipe(Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor))),
).pipe(Layer.provide(contactsDatabaseLive));
