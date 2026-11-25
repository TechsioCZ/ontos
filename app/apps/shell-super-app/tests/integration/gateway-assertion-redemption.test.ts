import { randomUUID } from 'node:crypto';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { eq, inArray } from 'drizzle-orm';
import { Clock, Duration, Effect, Exit, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAuthDatabase } from '../../api/auth/db/client.ts';
import { gatewayAssertionRedemptions } from '../../api/auth/db/schema.ts';
import { makeShellGatewayAssertionRedemption } from '../../api/auth/gateway-assertion-redemption.service.ts';

/*
 * The Shell host receives a delegated assertion for the Core operations it hosts (#1443). Its jti is consumed once,
 * durably, across separate instances and concurrent claims, exactly like a vertical receiver's, in the Shell's own
 * private table.
 */

const issuer = 'https://redemption.example.test';
const audience = 'shell-super-app';

it.live('consumes a delegated assertion once across separate instances and concurrent claims', () =>
  Effect.scoped(
    Effect.gen(function* durableRedemption() {
      const connections = yield* loadDatabaseConnectionPair();
      const config = connections.runtime;
      const first = yield* makeAuthDatabase(config);
      const second = yield* makeAuthDatabase(config);
      const jti = randomUUID();
      yield* Effect.addFinalizer(() =>
        first.executor
          .delete(gatewayAssertionRedemptions)
          .where(eq(gatewayAssertionRedemptions.jti, jti))
          .pipe(Effect.orDie),
      );
      const now = yield* Clock.currentTimeMillis;
      const input = {
        audience,
        expiresAtEpochSeconds: Math.floor(now / 1000) + Duration.toSeconds(Duration.minutes(5)),
        issuer,
        jti,
      };
      const claims = yield* Effect.all(
        [
          Effect.exit(makeShellGatewayAssertionRedemption(first.executor).consume(input)),
          Effect.exit(makeShellGatewayAssertionRedemption(second.executor).consume(input)),
        ],
        { concurrency: 2 },
      );
      expect(claims.filter(Exit.isSuccess)).toHaveLength(1);
      const refused = claims.filter(Exit.isFailure);
      expect(refused).toHaveLength(1);
      // A later redemption from any instance is the same refusal, and nothing but the identity was stored.
      const later = yield* Effect.flip(makeShellGatewayAssertionRedemption(second.executor).consume(input));
      expect(Predicate.isTagged(later, 'GatewayAssertionReplayError')).toBe(true);
      const rows = yield* second.executor
        .select()
        .from(gatewayAssertionRedemptions)
        .where(eq(gatewayAssertionRedemptions.jti, jti));
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(['audience', 'expiresAt', 'issuer', 'jti', 'redeemedAt']);
      // The same jti for another audience is another identity: a vertical's assertion is not the Shell's.
      yield* makeShellGatewayAssertionRedemption(first.executor).consume({ ...input, audience: 'catalog' });
      yield* first.executor.delete(gatewayAssertionRedemptions).where(inArray(gatewayAssertionRedemptions.jti, [jti]));
    }),
  ),
);

it.live('refuses an expired assertion and cleans only fully expired evidence', () =>
  Effect.scoped(
    Effect.gen(function* expiry() {
      const connections = yield* loadDatabaseConnectionPair();
      const database = yield* makeAuthDatabase(connections.runtime);
      const staleJti = randomUUID();
      const liveJti = randomUUID();
      const forgottenJti = randomUUID();
      const inFlightJti = randomUUID();
      const freshJti = randomUUID();
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(gatewayAssertionRedemptions)
          .where(inArray(gatewayAssertionRedemptions.jti, [staleJti, liveJti, forgottenJti, freshJti]))
          .pipe(Effect.orDie),
      );
      const redemption = makeShellGatewayAssertionRedemption(database.executor);
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      // Expired beyond the skew window: refused outright.
      const expired = yield* Effect.flip(
        redemption.consume({
          audience,
          expiresAtEpochSeconds: now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 1,
          issuer,
          jti: staleJti,
        }),
      );
      expect(Predicate.isTagged(expired, 'GatewayAssertionReplayError')).toBe(true);
      // Within the skew window it is still consumable once, and then retained.
      yield* redemption.consume({ audience, expiresAtEpochSeconds: now - 1, issuer, jti: liveJti });
      const again = yield* Effect.flip(
        redemption.consume({ audience, expiresAtEpochSeconds: now - 1, issuer, jti: liveJti }),
      );
      expect(Predicate.isTagged(again, 'GatewayAssertionReplayError')).toBe(true);
      // Evidence that expired beyond the skew window is removed by the next redemption; the still-retained row is not.
      const longGone = new Date((now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 60) * 1000);
      yield* database.executor
        .insert(gatewayAssertionRedemptions)
        .values({ audience, expiresAt: longGone, issuer, jti: forgottenJti });
      // A row just past the skew window is kept for as long as a redemption that started before expiry may still run
      // (the redemption timeout), so cleanup can never delete the evidence an in-flight replay would be compared with.
      const justPast = new Date((now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 2) * 1000);
      yield* database.executor
        .insert(gatewayAssertionRedemptions)
        .values({ audience, expiresAt: justPast, issuer, jti: inFlightJti });
      yield* redemption.consume({ audience, expiresAtEpochSeconds: now + 300, issuer, jti: freshJti });
      const remaining = yield* database.executor
        .select({ jti: gatewayAssertionRedemptions.jti })
        .from(gatewayAssertionRedemptions)
        .where(inArray(gatewayAssertionRedemptions.jti, [liveJti, forgottenJti, freshJti, inFlightJti]));
      expect(remaining.map((row) => row.jti).toSorted()).toEqual([liveJti, freshJti, inFlightJti].toSorted());
    }),
  ),
);
