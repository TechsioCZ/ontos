import { randomUUID } from 'node:crypto';
import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { eq } from 'drizzle-orm';
import { Clock, DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { AssortmentDatabase } from '../../src/database/client.ts';
import { assortmentRelations, gatewayAssertionRedemptions } from '../../src/database/schema.ts';

it.live('atomically redeems one current assertion and refuses the replay, wrong audience and stale assertions', () =>
  Effect.scoped(
    Effect.gen(function* verifyRedemption() {
      const { runtime } = yield* testDatabaseClients;
      const executor = yield* makeTestDatabaseFromClient(runtime, assortmentRelations);
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const assertion = {
        audience: 'assortment',
        expiresAtEpochSeconds: now + 60,
        issuer: 'assortment-redemption-fixture',
        jti: randomUUID(),
      };
      const consume = (input: typeof assertion) =>
        GatewayAssertionRedemptionService.pipe(
          Effect.flatMap((service) => service.consume(input)),
          Effect.provide(GatewayAssertionRedemptionLive),
          Effect.provideService(AssortmentDatabase, { executor }),
        );
      const attempts = yield* Effect.all(
        [consume(assertion).pipe(Effect.result), consume(assertion).pipe(Effect.result)],
        { concurrency: 'unbounded' },
      );
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
      expect(
        attempts.filter(Result.isFailure).map(({ failure }) => Schema.is(GatewayAssertionReplayError)(failure)),
      ).toEqual([true]);
      const recentlyExpired = {
        ...assertion,
        expiresAtEpochSeconds:
          Math.floor((yield* Clock.currentTimeMillis) / 1000) - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 1,
        jti: randomUUID(),
      };
      yield* executor.insert(gatewayAssertionRedemptions).values({
        audience: recentlyExpired.audience,
        expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(recentlyExpired.expiresAtEpochSeconds * 1000)),
        issuer: recentlyExpired.issuer,
        jti: recentlyExpired.jti,
      });
      yield* consume({ ...assertion, jti: randomUUID() });
      const retained = yield* executor
        .select({ jti: gatewayAssertionRedemptions.jti })
        .from(gatewayAssertionRedemptions)
        .where(eq(gatewayAssertionRedemptions.jti, recentlyExpired.jti));
      expect(retained).toEqual([{ jti: recentlyExpired.jti }]);
      for (const input of [
        assertion,
        { ...assertion, audience: 'foreign-owner', jti: randomUUID() },
        { ...assertion, expiresAtEpochSeconds: now - 120, jti: randomUUID() },
      ]) {
        const failure = yield* consume(input).pipe(Effect.flip);
        expect(Schema.is(GatewayAssertionReplayError)(failure)).toBe(true);
      }
    }),
  ),
);
