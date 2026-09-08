import { expect, it } from '@app/effect-rstest';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { Effect, Context, Layer, Schema } from 'effect';

import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { PartyDetailAuthenticationProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { AresSubjectService } from '../../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectServiceContract } from '../../src/integrations/ares/ares-subject.service.ts';
import { makePartyRegistryApiRuntime, partyRegistryFoundationLive } from '../../api/index.ts';
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

it.effect(
  'builds every declared handler through the injectable runtime without production dependencies',
  () =>
    Effect.gen(function* verifyRuntimeRouteCoverage() {
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
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makePartyRegistryApiRuntime(
            Layer.succeed(ReadRuntime, readRuntime),
            Layer.succeed(AresSubjectService, aresSubjectService),
            Layer.succeed(PartySearchProjectionGateway, searchProjectionGateway),
            Layer.succeed(ActionRuntime, actionRuntime),
            Layer.succeed(GatewayAssertionRedemptionService, {
              consume: () =>
                Effect.die('Unsigned route-coverage requests must never redeem an assertion'),
            }),
          ).createHandler(),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const readBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        partyRef: {
          moduleId: 'party.registry',
          resourceId: 'a4000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party',
          tenantId: 'a3000000-0000-4000-8000-000000000001',
        },
      });
      const unauthenticatedRead = yield* Effect.promise(() =>
        runtime.handler(
          new Request('http://localhost/reads/party-detail', {
            body: readBody,
            headers: {
              'content-type': 'application/json',
              'x-correlation-id': 'runtime-missing-credentials',
            },
            method: 'POST',
          }),
        ),
      );
      expect(unauthenticatedRead.status).toBe(401);
      expect(unauthenticatedRead.headers.get('www-authenticate')).toBe('Bearer');
      yield* Schema.decodeUnknownEffect(PartyDetailAuthenticationProblemSchema)(
        yield* Effect.promise(() => unauthenticatedRead.json()),
      );

      const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
        Object.values(group.endpoints),
      );
      const routeResults = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          Effect.gen(function* requestDeclaredEndpoint() {
            const hasPayload = endpoint.method !== 'GET' && endpoint.method !== 'HEAD';
            const request = hasPayload
              ? new Request(`http://localhost${endpoint.path}`, {
                  body: '{}',
                  headers: { 'content-type': 'application/json' },
                  method: endpoint.method,
                })
              : new Request(`http://localhost${endpoint.path}`, { method: endpoint.method });
            const response = yield* Effect.promise(() => runtime.handler(request));
            return { endpoint, response };
          }),
        { concurrency: 'unbounded' },
      );
      for (const { endpoint, response } of routeResults) {
        expect(
          response.status,
          `${endpoint.method} ${endpoint.path} must have a composed handler`,
        ).not.toBe(404);
      }
    }),
);
