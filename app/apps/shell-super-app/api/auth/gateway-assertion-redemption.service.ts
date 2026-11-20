import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  recoverSqlTransactionError,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { sql } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Layer } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { gatewayAssertionRedemptions } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';

const REDEMPTION_TIMEOUT = Duration.seconds(5);
/** Expired evidence removed with each redemption, so the table stays bounded without a separate sweeper. */
const CLEANUP_BATCH = 256;

const replayError = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
const unavailableError = (cause?: unknown) => {
  const error = new GatewayAssertionRedemptionUnavailableError({
    reason: 'Bearer assertion redemption is unavailable',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
};

/**
 * The single-use redemption of a delegated assertion the Shell host itself receives (the Core operations it hosts for
 * a module, #1443). The `(issuer, audience, jti)` identity is consumed before the operation runs; a second redemption,
 * an expired assertion and a store that cannot answer are each a refusal, never a pass. Authentication mechanics only:
 * no token, principal, tenant or business payload is stored.
 */
export const makeShellGatewayAssertionRedemption = (
  executor: Pick<AuthDatabaseExecutor, 'execute' | 'insert'>,
): GatewayAssertionRedemption => ({
  consume: Effect.fn('ShellGatewayAssertionRedemption.consume')(function* consume(
    input: GatewayAssertionRedemptionInput,
  ) {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    // Verification can finish after its captured clock passes the assertion's skew window. Reject before cleanup can
    // delete this assertion's existing replay evidence.
    if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= Math.floor(nowEpochMs / 1000)) {
      return yield* replayError();
    }
    const expiredBefore = DateTime.toDateUtc(
      DateTime.makeUnsafe(nowEpochMs - Duration.toMillis(Duration.seconds(GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS))),
    );
    const expiresAt = DateTime.toDateUtc(DateTime.makeUnsafe(input.expiresAtEpochSeconds * 1000));
    yield* executor
      .execute(
        sql`delete from ${gatewayAssertionRedemptions}
          where (issuer, audience, jti) in (
            select issuer, audience, jti from ${gatewayAssertionRedemptions}
            where expires_at < ${expiredBefore} order by expires_at limit ${CLEANUP_BATCH}
          )`,
      )
      .pipe(recoverSqlTransactionError, Effect.mapError(unavailableError));
    const inserted = yield* executor
      .insert(gatewayAssertionRedemptions)
      .values({ audience: input.audience, expiresAt, issuer: input.issuer, jti: input.jti })
      .onConflictDoNothing()
      .returning({ jti: gatewayAssertionRedemptions.jti })
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError(unavailableError),
        Effect.timeoutOrElse({ duration: REDEMPTION_TIMEOUT, orElse: () => Effect.fail(unavailableError()) }),
      );
    if (inserted.length !== 1) {
      return yield* replayError();
    }
    return yield* Effect.void;
  }),
});

export const ShellGatewayAssertionRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  AuthDatabase.pipe(Effect.map(({ executor }) => makeShellGatewayAssertionRedemption(executor))),
);
