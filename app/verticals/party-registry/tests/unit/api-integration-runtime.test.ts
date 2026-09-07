// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { Context, Effect, Layer, Schema } from 'effect';

import { makePartyRegistryApiRuntime, partyRegistryFoundationLive } from '../../api/index.ts';
import { partyRegistryApi, partyRegistryReadinessSchema } from '../../shared/api.ts';
import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { AresSubjectService } from '../../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectServiceContract } from '../../src/integrations/ares/ares-subject.service.ts';
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

test('builds every declared handler through the injectable runtime without production dependencies', async () => {
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('The route-coverage fixture never resolves a commit'),
    runAction: () => Effect.die('The route-coverage fixture never executes an Action'),
  };
  const readRuntime: ReadRuntimeService = {
    runRead: () => Effect.die('The route-coverage fixture never executes a Read'),
  };
  const aresSubjectService: AresSubjectServiceContract = {
    subject: () => Effect.die('The route-coverage fixture never calls ARES'),
  };
  const searchProjectionGateway: PartySearchProjectionGatewayService = {
    searchCounterparties: () =>
      Effect.die('The route-coverage fixture never searches Counterparties'),
    searchParties: () => Effect.die('The route-coverage fixture never searches Parties'),
  };
  const runtime = makePartyRegistryApiRuntime(
    Layer.succeed(ReadRuntime, readRuntime),
    Layer.succeed(AresSubjectService, aresSubjectService),
    Layer.succeed(PartySearchProjectionGateway, searchProjectionGateway),
    Layer.succeed(ActionRuntime, actionRuntime),
  ).createHandler();
  try {
    const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
      Object.values(group.endpoints),
    );
    const routeResults = await Promise.all(
      endpoints.map(async (endpoint) => {
        const hasPayload = endpoint.method !== 'GET' && endpoint.method !== 'HEAD';
        const request = hasPayload
          ? new Request(`http://localhost${endpoint.path}`, {
              body: '{}',
              headers: { 'content-type': 'application/json' },
              method: endpoint.method,
            })
          : new Request(`http://localhost${endpoint.path}`, { method: endpoint.method });
        const response = await runtime.handler(request);
        return { endpoint, response };
      }),
    );
    for (const { endpoint, response } of routeResults) {
      assert.notEqual(
        response.status,
        404,
        `${endpoint.method} ${endpoint.path} must have a composed handler`,
      );
    }
  } finally {
    await runtime.dispose();
  }
});
