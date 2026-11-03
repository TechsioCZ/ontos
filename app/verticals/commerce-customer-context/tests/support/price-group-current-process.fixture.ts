import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  PartyRegistryRetailPartyResolverFactory,
  makePartyRegistryRetailPartyResolver,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { describeReceiver, runReceiver } from './price-group-current-receiver.fixture.ts';
import { failure } from './price-group-temporal-protocol.ts';

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
    return yield* Effect.scoped(
      runReceiver((execute) =>
        Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
          make: ({ scope }) =>
            makePartyRegistryRetailPartyResolver(
              { requestCorrelation: scope.correlationId, tenantId: scope.tenantId },
              execute,
            ),
        }),
      ),
    ).pipe(Effect.mapError(() => failure('fixture-unavailable')));
  }
  return yield* Effect.void;
});
const receiverServices = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
NodeRuntime.runMain(receiver.pipe(Effect.asVoid, Effect.provide(receiverServices)));
