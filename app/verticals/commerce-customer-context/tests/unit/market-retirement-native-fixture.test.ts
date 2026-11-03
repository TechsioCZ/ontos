import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, Layer, Order, Redacted } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  MarketRetirementNativeReceiverError,
  makeMarketRetirementNativeReceiver,
} from '../support/market-retirement-native.fixture.ts';

// Receiver lifecycle/configuration controls only. These do not prove native owner authorization,
// Current assessment, durable redemption or reservation; the actual HTTP/PG lifecycle proves those.
const configuration = {
  compositionRevision: 'a'.repeat(64),
  compositionSourceUrl: 'http://127.0.0.1:1/composition',
  issuer: 'http://127.0.0.1:1/',
  publicJwks: 'unused-before-activation',
  runtimeConnectionString: Redacted.make('postgresql://runtime:unused@127.0.0.1:1/ontos_1094_receiver_unit'),
};

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))('CCC native receiver boundaries', (test) => {
  test.effect('returns unavailable until the actual owner runtime is activated', () =>
    Effect.scoped(
      Effect.gen(function* unactivatedReceiver() {
        const receiver = yield* makeMarketRetirementNativeReceiver();
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(receiver.baseUrl);
        expect(response.status).toBe(503);
        expect(EffectArray.sort(Object.keys(receiver), Order.String)).toEqual([
          'activate',
          'baseUrl',
          'close',
          'deployment',
          'migrate',
        ]);
      }),
    ),
  );

  test.effect('rejects malformed immutable composition before constructing the owner runtime', () =>
    Effect.scoped(
      Effect.gen(function* invalidComposition() {
        const receiver = yield* makeMarketRetirementNativeReceiver();
        const failure = yield* receiver
          .activate({ ...configuration, compositionRevision: 'invalid' })
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(MarketRetirementNativeReceiverError);
        expect(failure.stage).toBe('configuration');
      }),
    ),
  );

  test.effect('rejects a foreign migration database before spawning the owned migration runner', () =>
    Effect.scoped(
      Effect.gen(function* foreignDatabase() {
        const receiver = yield* makeMarketRetirementNativeReceiver();
        const failure = yield* receiver
          .migrate({
            adminConnectionString: Redacted.make('postgresql://admin:unused@127.0.0.1:1/customer_live'),
            runtimeConnectionString: Redacted.make('postgresql://runtime:unused@127.0.0.1:1/customer_live'),
          })
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(MarketRetirementNativeReceiverError);
        expect(failure.stage).toBe('configuration');
      }),
    ),
  );

  test.effect('rejects activation after its receiving scope closes', () =>
    Effect.gen(function* closedReceiver() {
      const receiver = yield* Effect.scoped(makeMarketRetirementNativeReceiver());
      const failure = yield* receiver.activate(configuration).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(MarketRetirementNativeReceiverError);
      expect(failure.stage).toBe('closed');
    }),
  );
});
