// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { Context, Layer, Schema } from 'effect';

import { partyRegistryFoundationLive } from '../../api/index.ts';
import { partyRegistryApi, partyRegistryReadinessSchema } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

test('serves readiness and rejects the removed placeholder write without business dependencies', async () => {
  const readinessApi = HttpApi.make('PartyRegistryApi').add(partyRegistryApi.groups.foundation);
  const server = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(readinessApi).pipe(
      Layer.provide(partyRegistryFoundationLive),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  try {
    const response = await server.handler(
      new Request('http://localhost/party-registry/readiness'),
      Context.empty(),
    );
    assert.equal(response.status, 200);
    const readiness = Schema.decodeUnknownSync(partyRegistryReadinessSchema)(await response.json());
    assert.deepEqual(readiness.marker, ultramodernApiMarker);
    assert.equal(readiness.status, 'ready');

    const removedWrite = await server.handler(
      new Request('http://localhost/party-registry', {
        body: JSON.stringify({ name: 'Must not create an item' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      Context.empty(),
    );
    assert.equal(removedWrite.status, 404);
  } finally {
    await server.dispose();
  }
});
