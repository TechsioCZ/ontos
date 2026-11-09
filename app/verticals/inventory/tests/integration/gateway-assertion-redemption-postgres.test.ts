import { configureDatabasePool, GatewayAssertionReplayError, DatabaseConfig } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { defineRelations, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Clock, Context, Crypto, Effect, Layer, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
  gatewayAssertionRedemptionPgClient,
  makeGatewayAssertionRedemption,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { inventoryGatewayAssertionRedemptions as gatewayAssertionRedemptions } from '../../src/database/schema.ts';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

it.live('atomically redeems real native Inventory ingress assertions and preserves durable replay evidence', () =>
  Effect.scoped(
    Effect.gen(function* nativeRedemption() {
      const compositionSnapshot = yield* sourceImportCompositionFixture;
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot,
        mode: 'schema-only',
        purpose: 'implementation-1134-inventory-source-import-receipt',
      });
      const { connections } = isolated;
      const pool = yield* configureDatabasePool(Redacted.make(connections.runtime.connectionString));
      const client = yield* PgClient.make(pool);
      const relations = defineRelations({ gatewayAssertionRedemptions });
      const executor = yield* makeWithDefaults({ relations }).pipe(Effect.provideService(PgClient.PgClient, client));
      const databaseLive = GatewayAssertionRedemptionDatabaseLive.pipe(
        Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
        Layer.provide(Reactivity.layer),
        Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)),
      );
      const services = yield* Layer.build(GatewayAssertionRedemptionLive.pipe(Layer.provide(databaseLive)));
      const redeem = services.pipe(Context.get(GatewayAssertionRedemptionService));
      const crypto = yield* Crypto.Crypto;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const input = {
        audience: 'inventory',
        expiresAtEpochSeconds: now + 120,
        issuer: 'https://internal-inventory-native.test',
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
      yield* redeem.consume({ ...input, issuer: 'https://internal-second-inventory-native.test' });
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(NodeCrypto.layer), Effect.provide(Reactivity.layer)),
);
