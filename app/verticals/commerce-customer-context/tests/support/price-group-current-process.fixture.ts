import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  PartyRegistryRetailPartyResolverFactory,
  partyRegistryRetailPartyResolverFactoryLive,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import type { RetailPartyResolutionExecutor } from '../../src/integrations/retail-party-detail-executor.ts';
import { describeReceiver, runReceiver } from './price-group-current-receiver.fixture.ts';
import { failure } from './price-group-temporal-protocol.ts';

/** The owner's Party read, over the receiver's authority-issued Party client, for every Retail resolution. */
const retailResolversOver = (execute: RetailPartyResolutionExecutor) =>
  Layer.effect(
    PartyRegistryRetailPartyResolverFactory,
    Effect.gen(function* readPartyThroughReceiver() {
      const owner = yield* PartyRegistryRetailPartyResolverFactory;
      return { make: (scope: Parameters<typeof owner.make>[0]) => owner.make(scope, execute) };
    }),
  ).pipe(Layer.provide(partyRegistryRetailPartyResolverFactoryLive));

const receiver = Effect.gen(function* priceGroupCurrentMode() {
  const describe = process.argv.includes('--describe-price-group-current');
  const serve = process.argv.includes('--serve-price-group-current');
  if (describe && serve) {
    yield* Effect.sync(() => process.stderr.write('PRICE_GROUP_FIXTURE_MODE_CONFLICT\n'));
    return yield* failure('fixture-mode-conflict');
  }
  if (describe) {
    return yield* describeReceiver.pipe(Effect.mapError(() => failure('fixture-unavailable')));
  }
  if (serve) {
    return yield* Effect.scoped(runReceiver(retailResolversOver)).pipe(
      Effect.mapError(() => failure('fixture-unavailable')),
    );
  }
  return yield* Effect.void;
});
const receiverServices = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
NodeRuntime.runMain(receiver.pipe(Effect.asVoid, Effect.provide(receiverServices)));
