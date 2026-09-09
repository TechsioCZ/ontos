import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { lt } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Layer } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { PartyDatabase } from '../db/client.ts';
import { gatewayAssertionRedemptions } from '../db/engagement-schema.ts';
import type { PartyDatabaseExecutor } from '../db/types.ts';

export { PartyDatabaseLive as GatewayAssertionRedemptionDatabaseLive } from '../db/client.ts';

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
  executor: PartyDatabaseExecutor,
  input: GatewayAssertionRedemptionInput,
  expiredBefore: Date,
  expiresAt: Date,
) =>
  executor.transaction(
    Effect.fn('GatewayAssertionRedemptionRuntime.redeemAssertion')(function* redeemAssertionEffect(transaction) {
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

export const makeGatewayAssertionRedemption = (executor: PartyDatabaseExecutor): GatewayAssertionRedemption => ({
  consume: Effect.fn('PartyRegistryGatewayAssertionRedemption.consume')(function* consumeGatewayAssertionEffect(
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
      // oxlint-disable-next-line effect-native/no-local-defect-seam -- Native SQL settlement dies with SqlError; this owner narrows only that expected persistence failure and preserves other defects. remove-when: the rule recognizes native SQL settlement narrowing.
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(unavailableError(defect)) : Effect.die(defect))),
      Effect.timeoutOrElse({
        duration: REDEMPTION_TIMEOUT,
        orElse: () => Effect.fail(unavailableError()),
      }),
    );
    if (inserted.length !== 1) {
      return yield* replayError();
    }
  }),
});

export const GatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  PartyDatabase.pipe(Effect.map(({ executor }) => makeGatewayAssertionRedemption(executor))),
);
