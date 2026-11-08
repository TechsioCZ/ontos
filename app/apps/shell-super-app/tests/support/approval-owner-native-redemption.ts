import { recoverSqlTransactionError } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Clock, Effect, Layer } from 'effect';

const redemptions = pgTable(
  'native_owner_approval_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
  },
  (table) => [primaryKey({ columns: [table.issuer, table.audience, table.jti] })],
);

/** Only the parent fixture creates this table, inside its already-owned disposable case database. */
export const nativeOwnerApprovalRedemptionSetup = [
  `create table public.native_owner_approval_redemptions
    (audience text not null, expires_at timestamptz not null, issuer text not null, jti uuid not null,
     primary key (issuer,audience,jti))`,
  'grant select, insert on public.native_owner_approval_redemptions to ontos_runtime',
] as const;

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new GatewayAssertionRedemptionUnavailableError({ reason: 'The native owner redemption store is unavailable' }),
    'cause',
    { enumerable: false, value: cause },
  );
const replay = () => new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });

/** Durable receiving-owner redemption. No in-memory replay set or scripted successful consumption. */
export const NativeOwnerApprovalRedemptionLive = Layer.effect(
  GatewayAssertionRedemptionService,
  Effect.gen(function* nativeOwnerApprovalRedemption() {
    const database = yield* CoreDatabase;
    return {
      consume: Effect.fn('OwnerApprovalNative.redeem')(function* redeem(input: GatewayAssertionRedemptionInput) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= now) {
          return yield* replay();
        }
        const inserted = yield* database.executor
          .insert(redemptions)
          .values({
            audience: input.audience,
            expiresAt: new Date(input.expiresAtEpochSeconds * 1000),
            issuer: input.issuer,
            jti: input.jti,
          })
          .onConflictDoNothing()
          .returning({ jti: redemptions.jti })
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
    } satisfies (typeof GatewayAssertionRedemptionService)['Service'];
  }),
);
