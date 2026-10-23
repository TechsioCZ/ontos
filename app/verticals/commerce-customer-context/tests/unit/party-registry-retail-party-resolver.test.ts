import { randomUUID } from 'node:crypto';
import { ActionPermissionCheckError } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { GatewayContextApi } from '@app/shared-contracts';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { PartyDetailApi } from '@app/party-registry/api';
import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import type { PartyDetailResponse } from '@app/party-registry/api/client';
import {
  makePartyRegistryRetailPartyResolver,
  PartyRegistryRetailPartyResolverFactory,
  partyRegistryRetailPartyResolverFactoryLive,
  preparedRetailPartyResolution,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const partyId = '30000000-0000-4000-8000-000000000003';
const scope = {
  legalEntityId: '40000000-0000-4000-8000-000000000004',
  principalId: '50000000-0000-4000-8000-000000000005',
  requestCorrelation: 'retail-owner-correlation',
  tenantId,
} as const;
const request = {
  actionInvocationId: '60000000-0000-4000-8000-000000000006',
  compositionRevision: 'a'.repeat(64),
  partyResourceId: partyId,
  tenantId,
} as const;
const partyRef = (resourceId: string, refTenantId = tenantId) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId: refTenantId,
});

const response = (overrides: Partial<PartyDetailResponse> = {}) =>
  Schema.decodeUnknownSync(PartyDetailResponseSchema)({
    currentFactAssertions: [],
    factHistory: null,
    party: {
      archivedAt: null,
      createdAt: '2026-09-09T09:00:00.000Z',
      displayName: 'Retail Owner',
      partyRef: partyRef(partyId),
      partyType: 'PERSON',
      revision: 7,
      updatedAt: '2026-09-09T09:00:00.000Z',
    },
    resolution: {
      aliasChain: [],
      canonicalPartyRef: partyRef(partyId),
      kind: 'DIRECT',
      requestedPartyRef: partyRef(partyId),
    },
    ...overrides,
  });

it.effect('accepts only the exact current canonical Party and returns owner revision evidence', () =>
  makePartyRegistryRetailPartyResolver(scope, () => Effect.succeed(response()))(request).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({
          outcome: 'CURRENT_PARTY_RESOLVED',
          partyResourceId: partyId,
          partyResourceRevision: '7',
        });
      }),
    ),
  ),
);

it.effect('rejects aliases, archived Parties, and cross-Tenant owner payloads without mutation', () =>
  Effect.gen(function* adversarialOwnerPayloads() {
    const alias = yield* makePartyRegistryRetailPartyResolver(scope, () =>
      Effect.succeed(
        response({
          resolution: {
            aliasChain: [partyRef('party-alias')],
            canonicalPartyRef: partyRef(partyId),
            kind: 'ALIAS',
            requestedPartyRef: partyRef('party-alias'),
          },
        }),
      ),
    )(request);
    expect(alias).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });

    const archivedResponse = response();
    const archived = yield* makePartyRegistryRetailPartyResolver(scope, () =>
      Effect.succeed({
        ...archivedResponse,
        party: {
          ...archivedResponse.party,
          archivedAt: Option.some(DateTime.makeUnsafe('2026-09-09T10:00:00.000Z')),
        },
      }),
    )(request);
    expect(archived).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });

    const crossTenantResponse = response();
    const crossTenant = yield* makePartyRegistryRetailPartyResolver(scope, () =>
      Effect.succeed({
        ...crossTenantResponse,
        party: { ...crossTenantResponse.party, partyRef: partyRef(partyId, otherTenantId) },
        resolution: {
          aliasChain: [],
          canonicalPartyRef: partyRef(partyId, otherTenantId),
          kind: 'DIRECT' as const,
          requestedPartyRef: partyRef(partyId, otherTenantId),
        },
      }),
    )(request);
    expect(crossTenant).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });
  }),
);

it.effect('fails closed when the owner operation is unavailable or the request scope is forged', () =>
  Effect.gen(function* unavailableOwner() {
    let calls = 0;
    // @ts-expect-error -- This failure-injection double deliberately uses a generic Error so the adapter's transport-failure mapping is exercised.
    const resolver = makePartyRegistryRetailPartyResolver(scope, () => {
      calls += 1;
      return Effect.fail(new Error('owner unavailable'));
    });
    const unavailable = yield* Effect.flip(resolver(request));
    expect(Schema.is(ProfilePersistenceDependencyFailure)(unavailable)).toBe(true);
    expect(unavailable.reason).toContain('Party Detail operation is unavailable');

    const forged = yield* Effect.flip(resolver({ ...request, tenantId: otherTenantId }));
    expect(Predicate.isTagged(forged, 'ProfilePersistenceDependencyFailure')).toBe(true);
    expect(forged.reason).toBe('Retail Party resolution scope is not trusted');
    expect(calls).toBe(1);
  }),
);

it.effect('installs the owner adapter as a production-injectable factory', () =>
  Effect.gen(function* verifyLayer() {
    const factory = yield* PartyRegistryRetailPartyResolverFactory;
    expect(Predicate.isFunction(factory.make)).toBe(true);
  }).pipe(Effect.provide(partyRegistryRetailPartyResolverFactoryLive)),
);

interface OwnerHttpRequest {
  readonly body: string;
  readonly headers: Headers;
  readonly path: string;
}

/** Native HttpApi server/clients over the supported in-memory transport; no DOM or socket server. */
const serveNativePartyContract = (compositionRevision: string) =>
  Effect.gen(function* nativePartyContract() {
    const requests: OwnerHttpRequest[] = [];
    const api = GatewayContextApi.addHttpApi(PartyDetailApi.prefix('/party-owner'));
    const issue = Effect.sync(() => ({
      apiBaseUrl: '/party-owner',
      compositionRevision,
      expiresAt: 1_800_000_300,
      token: [
        Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'contract-test', typ: 'JWT' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({
            aud: 'party-registry',
            compositionRevision,
            exp: 1_800_000_300,
            iat: 1_800_000_000,
            iss: 'contract-test-shell',
            jti: randomUUID(),
            principal: {
              authBindingId: '70000000-0000-4000-8000-000000000007',
              authContextRef: 'api-key:contract-test-commerce',
              authMethod: 'api_key',
              legalEntityId: scope.legalEntityId,
              principalId: scope.principalId,
              tenantId,
            },
            sub: scope.principalId,
            targetBuildMarker: 'contract-test-party',
            ver: 1,
          }),
        ).toString('base64url'),
        'contract-test-signature',
      ].join('.'),
    }));
    const gatewayHandlers = HttpApiBuilder.group(api, 'gatewayContext', (handlers) =>
      handlers
        .handle('issueGatewayContext', () => issue)
        .handle('readWithApiKeyGatewayContext', () => Effect.succeed(null))
        .handle('issueApiKeyGatewayContext', ({ payload, request: incoming }) => {
          requests.push({ body: JSON.stringify(payload), headers: new Headers(incoming.headers), path: incoming.url });
          return issue;
        }),
    );
    const partyHandlers = HttpApiBuilder.group(api, 'partyDetail', (handlers) =>
      handlers.handle('execute', ({ payload, request: incoming }) => {
        requests.push({ body: JSON.stringify(payload), headers: new Headers(incoming.headers), path: incoming.url });
        return Effect.succeed(response());
      }),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(Layer.mergeAll(gatewayHandlers, partyHandlers)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (webHandler) => Effect.promise(() => webHandler.dispose()),
    );
    const nativeFetch: typeof fetch = (input, init) => server.handler(new Request(input, init), Context.empty());
    return {
      layer: Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'contract-test-commerce-key',
            ONTOS_SHELL_GATEWAY_BASE_URL: 'https://native-party-contract.test',
          }),
        ),
        Layer.succeed(FetchHttpClient.Fetch, nativeFetch),
      ),
      requests,
    };
  });

const nativePreflight = {
  actionInvocationId: request.actionInvocationId,
  actionKey: 'commerce.customer-context.ensure-retail-customer-profile',
  correlationId: scope.requestCorrelation,
  payload: {
    effectiveAt: '2026-10-23T12:00:00.000Z',
    subject: {
      kind: 'RETAIL',
      partyRef: partyRef(partyId),
      sellingLegalEntityRef: {
        moduleId: 'core.identity',
        resourceId: scope.legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    },
    trigger: 'AUTHORIZED_ONBOARDING',
  },
  principal: {
    authBindingId: '70000000-0000-4000-8000-000000000007',
    authContextRef: 'api-key:contract-test-commerce',
    authMethod: 'api_key' as const,
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId,
  },
  scope: {
    authBindingId: '70000000-0000-4000-8000-000000000007',
    authContextRef: 'api-key:contract-test-commerce',
    authMethod: 'api_key' as const,
    correlationId: scope.requestCorrelation,
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId,
  },
};

it.effect('prepares real server Party HTTP in Node, then consumes once without HTTP inside the Action', () =>
  Effect.gen(function* nativeServerPreflight() {
    expect(globalThis).not.toHaveProperty('document');
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const server = yield* serveNativePartyContract(snapshot.composition.revision);
    const execution = yield* preparedRetailPartyResolution.pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    );
    const ready = yield* execution.preflight.prepare(nativePreflight).pipe(Effect.provide(server.layer));
    expect(ready).toEqual({ outcome: 'not_applicable' });
    expect(server.requests).toHaveLength(2);
    const [issuance, owner] = server.requests;
    expect(issuance?.path).toBe('/auth/api-key/gateway-context');
    expect(JSON.parse(issuance?.body ?? '{}')).toEqual({
      audience: 'party-registry',
      compositionRevision: snapshot.composition.revision,
      legalEntityId: scope.legalEntityId,
    });
    expect(owner?.path).toBe('/party-owner/reads/party-detail');
    expect(owner?.headers.get('x-ontos-composition-revision')).toBe(snapshot.composition.revision);
    expect(owner?.headers.get('x-correlation-id')).toBe(scope.requestCorrelation);
    expect(owner?.headers.get('authorization')).toMatch(/^Bearer /u);
    expect(owner?.headers.get('x-api-key')).toBeNull();
    expect(JSON.parse(owner?.body ?? '{}')).toEqual({ partyRef: partyRef(partyId) });
    const resolve = execution.factory.make(scope);
    const exactRequest = { ...request, compositionRevision: snapshot.composition.revision };
    expect(yield* resolve(exactRequest)).toEqual({
      outcome: 'CURRENT_PARTY_RESOLVED',
      partyResourceId: partyId,
      partyResourceRevision: '7',
    });
    expect(Schema.is(ProfilePersistenceDependencyFailure)(yield* Effect.flip(resolve(exactRequest)))).toBe(true);
    expect(server.requests).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect('binds prepared owner evidence to invocation, revision, Party, Tenant, company and principal', () =>
  Effect.gen(function* isolatedPreparedOwnerEvidence() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const server = yield* serveNativePartyContract(snapshot.composition.revision);
    const exactRequest = { ...request, compositionRevision: snapshot.composition.revision };
    for (const mismatch of [
      { request: { ...exactRequest, actionInvocationId: randomUUID() }, scope },
      { request: { ...exactRequest, compositionRevision: 'b'.repeat(64) }, scope },
      { request: { ...exactRequest, partyResourceId: randomUUID() }, scope },
      { request: { ...exactRequest, tenantId: otherTenantId }, scope },
      { request: exactRequest, scope: { ...scope, legalEntityId: randomUUID() } },
      { request: exactRequest, scope: { ...scope, principalId: randomUUID() } },
      { request: exactRequest, scope: { ...scope, requestCorrelation: 'another-request' } },
    ]) {
      const execution = yield* preparedRetailPartyResolution.pipe(
        Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      );
      yield* execution.preflight.prepare(nativePreflight).pipe(Effect.provide(server.layer));
      expect(
        Schema.is(ProfilePersistenceDependencyFailure)(
          yield* Effect.flip(execution.factory.make(mismatch.scope)(mismatch.request)),
        ),
      ).toBe(true);
      expect(
        Schema.is(ProfilePersistenceDependencyFailure)(yield* Effect.flip(execution.factory.make(scope)(exactRequest))),
      ).toBe(true);
    }
    const ownerRequests = server.requests.filter(({ path }) => path === '/party-owner/reads/party-detail');
    expect(ownerRequests).toHaveLength(7);
    expect(new Set(ownerRequests.map(({ headers }) => headers.get('authorization'))).size).toBe(7);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect('does no owner I/O for unrelated, malformed or forged preflight input', () =>
  Effect.gen(function* failClosedBeforeOwnerIo() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const server = yield* serveNativePartyContract(snapshot.composition.revision);
    const execution = yield* preparedRetailPartyResolution.pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    );
    expect(
      yield* execution.preflight.prepare({ ...nativePreflight, actionKey: 'commerce.customer-context.other-action' }),
    ).toEqual({ outcome: 'not_applicable' });
    for (const forged of [
      { ...nativePreflight, scope: { ...nativePreflight.scope, legalEntityId: randomUUID() } },
      { ...nativePreflight, scope: { ...nativePreflight.scope, tenantId: otherTenantId } },
      { ...nativePreflight, scope: { ...nativePreflight.scope, principalId: randomUUID() } },
      { ...nativePreflight, correlationId: 'another-request' },
    ]) {
      expect(yield* execution.preflight.prepare(forged)).toEqual({ outcome: 'denied' });
    }
    const malformed = yield* Effect.flip(execution.preflight.prepare({ ...nativePreflight, payload: {} }));
    expect(Schema.is(ActionPermissionCheckError)(malformed)).toBe(true);
    expect(server.requests).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect('clears unconsumed prepared evidence when the owning invocation scope closes', () =>
  Effect.gen(function* cleanupPreparedOwnerEvidence() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const server = yield* serveNativePartyContract(snapshot.composition.revision);
    const execution = yield* Effect.scoped(
      Effect.gen(function* completedInvocation() {
        const prepared = yield* preparedRetailPartyResolution.pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        );
        yield* prepared.preflight.prepare(nativePreflight).pipe(Effect.provide(server.layer));
        return prepared;
      }),
    );
    const failure = yield* Effect.flip(
      execution.factory.make(scope)({ ...request, compositionRevision: snapshot.composition.revision }),
    );
    expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
    expect(server.requests).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect('production fallback never performs owner HTTP inside persistence without prepared evidence', () =>
  Effect.gen(function* failClosedWithoutPreflight() {
    const factory = yield* PartyRegistryRetailPartyResolverFactory;
    const failure = yield* Effect.flip(factory.make(scope)(request));
    expect(failure.reason).toBe('No matching invocation-scoped Retail Party resolution is prepared');
  }).pipe(Effect.provide(partyRegistryRetailPartyResolverFactoryLive)),
);
