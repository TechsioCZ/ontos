import { NodeHttpServer } from '@effect/platform-node';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { servePurchaseFixtureHttpServer } from '../support/purchase-fixture-http-server.ts';

it.layer(NodeHttpServer.layerTest, { excludeTestServices: true })('purchase fixture HTTP isolation', (test) => {
  test.effect('routes Catalog and composition requests through one root-owned listener without collisions', () =>
    Effect.gen(function* composedFixtureServer() {
      const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, []);
      let catalogCalls = 0;
      const source = yield* servePurchaseFixtureHttpServer(
        snapshot,
        Effect.gen(function* catalogRequest() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.json;
          expect(body).toEqual({ kind: 'catalog' });
          catalogCalls += 1;
          return HttpServerResponse.text('catalog');
        }),
      );
      if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
        return yield* Effect.die('Fixture server requires a TCP address');
      }
      const sourcePort = source.address.port;
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
        snapshot,
      );
      const sourceResponse = yield* Effect.promise(() => fetch(`http://127.0.0.1:${sourcePort}/active-composition`));
      expect(sourceResponse.status).toBe(200);
      expect(yield* Effect.promise(() => sourceResponse.text())).toBe(document);
      expect(catalogCalls).toBe(0);
      const sourceConfiguration = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${sourcePort}/active-composition`,
        }),
      );
      const compositionLayer = ActiveApplicationCompositionConfigLive.pipe(
        Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
        Layer.provide(sourceConfiguration),
      );
      const compositionContext = yield* Layer.build(compositionLayer);
      const loaded = yield* Context.get(compositionContext, ActiveApplicationCompositionService).load;
      expect(loaded.composition.revision).toBe(snapshot.composition.revision);
      const catalogResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${sourcePort}/reads/current-payment-terms`, {
          body: '{"kind":"catalog"}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(catalogResponse.status).toBe(200);
      expect(yield* Effect.promise(() => catalogResponse.text())).toBe('catalog');
      expect(catalogCalls).toBe(1);
      const missing = yield* Effect.promise(() => fetch(`http://127.0.0.1:${sourcePort}/unknown`));
      expect(missing.status).toBe(404);
      expect(catalogCalls).toBe(1);
      return yield* Effect.void;
    }),
  );
});
