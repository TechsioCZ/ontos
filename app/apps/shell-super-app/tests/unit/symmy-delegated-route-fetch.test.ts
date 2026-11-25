import { readFileSync } from 'node:fs';

import { makeActiveApplicationCompositionLayer } from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from '@effect/platform-node/Undici';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { symmyOwnerReleaseFetchLive } from '../../api/symmy/owner-release-transport.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const response = {
  allowedOwnerOperations: [
    {
      entrypointKey: 'party.registry.create-party',
      moduleId: 'party.registry',
      schemaVersion: '1',
    },
  ],
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

it.effect(
  'requalifies uncommitted intake through the native approved owner relay, never the unconfigured client transport',
  () =>
    Effect.gen(function* delegatedRouteFetch() {
      const snapshot = yield* makeCompositionSnapshot([
        makeModuleContractFixture({
          appId: 'symmy-integration',
          buildMarker: 'delegated-route-test',
          moduleId: 'integration.symmy',
        }),
      ]);
      const [owner] = snapshot.composition.modules;
      if (owner === undefined) {
        return yield* Effect.die('Missing fixture owner');
      }
      const previousDispatcher = getGlobalDispatcher();
      const mock = new MockAgent();
      mock.disableNetConnect();
      const ownerOrigin = new URL(owner.backend.baseUrl).origin;
      mock
        .get(ownerOrigin)
        .intercept({
          headers: { 'x-ontos-composition-revision': snapshot.composition.revision },
          method: 'POST',
          path: '/symmy-integration-api/reads/symmy-route-context',
        })
        .reply(200, response, { headers: { 'content-type': 'application/json' } });
      let unconfiguredCalls = 0;
      const unconfiguredFetch: typeof fetch = async () => {
        unconfiguredCalls += 1;
        throw new Error('Unconfigured Fetch must not resolve the private owner-relay origin');
      };
      const globalFetch = rs.spyOn(globalThis, 'fetch');
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
        // Without the owner relay, the client transport fails before any approved owner call.
        expect(
          yield* request.pipe(Effect.provideService(FetchHttpClient.Fetch, unconfiguredFetch), Effect.flip),
        ).toBeDefined();
        expect(unconfiguredCalls).toBe(1);
        const result = yield* request.pipe(
          Effect.provide(
            symmyOwnerReleaseFetchLive.pipe(
              Layer.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))),
            ),
          ),
        );
        expect(result).toEqual(response);
        expect(globalFetch).not.toHaveBeenCalled();
        expect(unconfiguredCalls).toBe(1);
        mock.assertNoPendingInterceptors();
        return yield* Effect.void;
      } finally {
        globalFetch.mockRestore();
        setGlobalDispatcher(previousDispatcher);
        yield* Effect.promise(() => mock.close());
      }
    }),
);

it('provides that finite relay to the actual delegated gateway handler group as well as public ingress', () => {
  const source = readFileSync(new URL('../../api/index.ts', import.meta.url), 'utf-8');
  expect(source).toMatch(
    /gatewayContextGroupLive\.pipe\(\s*Layer\.provide\(symmyOwnerReleaseFetchLive\.pipe\(Layer\.provide\(shellReadAuthorityLayer\)\)\)/u,
  );
});
