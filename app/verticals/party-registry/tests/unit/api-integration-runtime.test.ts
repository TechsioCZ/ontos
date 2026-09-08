import { expect, it } from '@app/effect-rstest';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { Effect, Context, Layer, Schema } from 'effect';

import { partyRegistryFoundationLive } from '../../api/index.ts';
import { partyRegistryApi, partyRegistryReadinessSchema } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

it.effect(
  'serves readiness and rejects the removed placeholder write without business dependencies',
  () =>
    Effect.gen(function* apiIntegrationRuntimeCase1() {
      const readinessApi = HttpApi.make('PartyRegistryApi').add(partyRegistryApi.groups.foundation);
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(readinessApi).pipe(
              Layer.provide(partyRegistryFoundationLive),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const response = yield* Effect.promise(() =>
        server.handler(new Request('http://localhost/party-registry/readiness'), Context.empty()),
      );
      expect(response.status).toBe(200);
      const readiness = yield* Schema.decodeUnknownEffect(partyRegistryReadinessSchema)(
        yield* Effect.promise(() => response.json()),
      );
      expect(readiness.marker).toEqual(ultramodernApiMarker);
      expect(readiness.status).toBe('ready');

      const removedWrite = yield* Effect.promise(() =>
        server.handler(
          new Request('http://localhost/party-registry', {
            body: '{"name":"Must not create an item"}',
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
          Context.empty(),
        ),
      );
      expect(removedWrite.status).toBe(404);
    }),
);
