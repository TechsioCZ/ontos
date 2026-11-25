import { readFileSync } from 'node:fs';

import { makeActiveApplicationCompositionLayer } from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from '@effect/platform-node/Undici';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { symmyOwnerReleaseFetchLive } from '../../api/symmy/owner-release-transport.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const response = {
  allowedOwnerOperations: [{
    entrypointKey: 'party.registry.create-party',
    moduleId: 'party.registry',
    schemaVersion: '1',
  }],
  issuerId: 'offline-source',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  mappingVersion: 'mapping-1',
  routeId: '70000000-0000-4000-8000-000000000001',
  routeRevision: 'route-1',
  sourceMappingVersion: 'mapping-1',
  sourceNamespace: 'offline-customers',
  sourceRouteId: '80000000-0000-4000-8000-000000000001',
  sourceRouteRevision: 'route-1',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

it.effect('requalifies uncommitted intake through the native approved owner relay, never global Fetch', () =>
  Effect.gen(function* delegatedRouteFetch() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({
        appId: 'symmy-integration',
        buildMarker: 'delegated-route-test',
        moduleId: 'integration.symmy',
      }),
    ]);
    const owner = snapshot.composition.modules[0];
    if (owner === undefined) return yield* Effect.die('Missing fixture owner');
    const previousDispatcher = getGlobalDispatcher();
    const previousFetch = globalThis.fetch;
    const mock = new MockAgent();
    mock.disableNetConnect();
    const ownerOrigin = new URL(owner.backend.baseUrl).origin;
    mock.get(ownerOrigin).intercept({
      method: 'POST',
      path: '/symmy-integration-api/reads/symmy-route-context',
      headers: { 'x-ontos-composition-revision': snapshot.composition.revision },
    }).reply(200, response, { headers: { 'content-type': 'application/json' } });
    let globalCalls = 0;
    globalThis.fetch = async () => {
      globalCalls++;
      throw new Error('Global Fetch must not resolve the private owner-relay origin');
    };
    setGlobalDispatcher(mock);
    try {
      const request = executeSymmyRouteContextWithAuthorization(
        { routeKey: 'customersBatch' },
        'Bearer offline-test-assertion',
        'offline-route-requalification',
        {
          baseUrl: new URL(
            'https://symmy-owner-relay.invalid/module-api/symmy-integration/delegated-route-test/symmy-integration-api',
          ),
          compositionRevision: snapshot.composition.revision,
        },
      );
      // Exact old handler wiring: generated clients fall back to global Fetch and fail before any owner call.
      expect(yield* Effect.flip(request)).toBeDefined();
      expect(globalCalls).toBe(1);
      const result = yield* request.pipe(
        Effect.provide(symmyOwnerReleaseFetchLive.pipe(
          Layer.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))),
        )),
      );
      expect(result).toEqual(response);
      expect(globalCalls).toBe(1);
      mock.assertNoPendingInterceptors();
    } finally {
      globalThis.fetch = previousFetch;
      setGlobalDispatcher(previousDispatcher);
      yield* Effect.promise(() => mock.close());
    }
  }),
);

it('provides that finite relay to the actual delegated gateway handler group as well as public ingress', () => {
  const source = readFileSync(new URL('../../api/index.ts', import.meta.url), 'utf8');
  expect(source).toMatch(
    /gatewayContextGroupLive\.pipe\(\s*Layer\.provide\(symmyOwnerReleaseFetchLive\.pipe\(Layer\.provide\(shellReadAuthorityLayer\)\)\)/u,
  );
});
