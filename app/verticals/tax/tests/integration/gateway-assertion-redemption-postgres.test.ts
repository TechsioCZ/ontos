import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import { NodeCrypto } from '@effect/platform-node';
import { Clock, Context, Crypto, Effect, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { TaxDatabase } from '../../src/database/client.ts';
import { taxRelations } from '../../src/database/schema.ts';

it.layer(NodeCrypto.layer, { excludeTestServices: true })('Tax gateway assertion redemption', (suite) => {
  suite.effect('redeems the same assertion exactly once across concurrent transactions', () =>
    Effect.scoped(
      Effect.gen(function* verifyTaxAssertionRedemption() {
        const { runtime } = yield* testDatabaseClients;
        const executor = yield* makeTestDatabaseFromClient(runtime, taxRelations);
        const services = yield* Layer.build(
          GatewayAssertionRedemptionLive.pipe(Layer.provide(Layer.succeed(TaxDatabase, { executor }))),
        );
        const redemption = Context.get(services, GatewayAssertionRedemptionService);
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const jti = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
        const redeem = redemption.consume({
          audience: 'tax',
          expiresAtEpochSeconds: now + 60,
          issuer: 'tax-redemption-fixture',
          jti,
        });
        const attempts = yield* Effect.all([Effect.result(redeem), Effect.result(redeem)], { concurrency: 2 });
        expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
        expect(
          attempts.filter(Result.isFailure).map(({ failure }) => Schema.is(GatewayAssertionReplayError)(failure)),
        ).toEqual([true]);
        expect(Schema.is(GatewayAssertionReplayError)(yield* Effect.flip(redeem))).toBe(true);
      }),
    ),
  );
});
