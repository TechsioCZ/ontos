import { configureDatabasePool, GatewayAssertionReplayError, loadDatabaseConnectionPair } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { NodeCrypto } from '@effect/platform-node';
import { defineRelations, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Clock, Crypto, Effect, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { gatewayAssertionRedemptions } from '../../src/database/schema.ts';

it.live('atomically redeems real native Privacy ingress assertions and preserves durable replay evidence', () =>
  Effect.scoped(
    Effect.gen(function* nativeRedemption() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const pool = yield* configureDatabasePool(Redacted.make(connections.runtime.connectionString));
      const client = yield* PgClient.make(pool);
      const relations = defineRelations({ gatewayAssertionRedemptions });
      const executor = yield* makeWithDefaults({ relations }).pipe(Effect.provideService(PgClient.PgClient, client));
      const redeem = makeGatewayAssertionRedemption(executor);
      const crypto = yield* Crypto.Crypto;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const input = {
        audience: 'privacy',
        expiresAtEpochSeconds: now + 120,
        issuer: 'https://internal-privacy-native.test',
        jti: yield* crypto.randomUUIDv4(),
      };
      const attempts = yield* Effect.all(
        [redeem.consume(input).pipe(Effect.result), redeem.consume(input).pipe(Effect.result)],
        { concurrency: 2 },
      );
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
      const rejected = attempts.filter(Result.isFailure);
      expect(rejected).toHaveLength(1);
      for (const result of rejected) {
        expect(Schema.is(GatewayAssertionReplayError)(result.failure)).toBe(true);
      }
      const freshClient = yield* PgClient.make(pool);
      const freshExecutor = yield* makeWithDefaults({ relations }).pipe(
        Effect.provideService(PgClient.PgClient, freshClient),
      );
      expect(
        Schema.is(GatewayAssertionReplayError)(
          yield* Effect.flip(makeGatewayAssertionRedemption(freshExecutor).consume(input)),
        ),
      ).toBe(true);
      expect(
        Schema.is(GatewayAssertionReplayError)(
          yield* Effect.flip(
            redeem.consume({ ...input, expiresAtEpochSeconds: now - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 1 }),
          ),
        ),
      ).toBe(true);
      const rows = yield* executor
        .select()
        .from(gatewayAssertionRedemptions)
        .where(eq(gatewayAssertionRedemptions.jti, input.jti));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expiresAt.getTime()).toBe(input.expiresAtEpochSeconds * 1000);
      expect(
        Schema.is(GatewayAssertionReplayError)(
          yield* Effect.flip(redeem.consume({ ...input, audience: 'party-registry' })),
        ),
      ).toBe(true);
      yield* redeem.consume({ ...input, issuer: 'https://internal-second-privacy-native.test' });
    }),
  ).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(Reactivity.layer)),
);
