import {
  buildApplicationCompositionCatalog,
  defineTenantModuleEntrypoint,
  LegalEntityContext,
} from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { DateTime, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose';

import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import {
  acquireSymmyRouteScopeProof,
  issueSymmyRouteScopeAssertion,
  projectSymmyRouteScopePrincipal,
  readSymmyRouteScope,
} from '../../api/auth/gateway-symmy-route-scope.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import type { ShellInstalledCatalog } from '../../api/modules/installed-module-catalog.ts';
import {
  ShellInstalledModuleCatalog,
  InstalledModuleCatalogUnavailableError,
} from '../../api/modules/installed-module-catalog.ts';

const compositionRevision = 'a'.repeat(64);
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-api-key:native-route-key',
  authenticationNamespaceId: 'test.integration.better-auth.v1',
  authMethod: 'api_key' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const response = {
  allowedOwnerOperations: [
    { entrypointKey: 'party.registry.api.source-profile-export', moduleId: 'party.registry', schemaVersion: '1' },
  ],
  issuerId: 'route-test',
  legalEntityId,
  mappingVersion: 'mapping-1',
  routeId: '70000000-0000-4000-8000-000000000001',
  routeRevision: 'route-1',
  sourceMappingVersion: 'source-mapping-1',
  sourceNamespace: 'native-route-test',
  sourceRouteId: '80000000-0000-4000-8000-000000000001',
  sourceRouteRevision: 'source-1',
  tenantId: principal.tenantId,
};
const request = {
  compositionRevision,
  principal,
  requestCorrelation: 'route-proof-transport-test',
  routeRequest: { routeKey: 'adminCustomers' as const },
  sourcePurpose: 'read' as const,
};

const fixture = Effect.fn('RouteScopeTest.fixture')(function* fixture(options: {
  readonly activeBinding?: boolean;
  readonly catalog?: ShellInstalledCatalog;
  readonly replayIdempotencyDigest?: string;
  readonly responseTenant?: string;
}) {
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const jwk = yield* Effect.promise(() => exportJWK(privateKey));
  const calls: { readonly authorization: string | null; readonly body: string; readonly url: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    calls.push({
      authorization: incoming.headers.get('authorization'),
      body: await incoming.text(),
      url: incoming.url,
    });
    const ownerResponse = { ...response, tenantId: options.responseTenant ?? response.tenantId };
    if (options.replayIdempotencyDigest !== undefined) {
      Object.assign(ownerResponse, {
        allowedOwnerOperations: [],
        replayIdempotencyDigest: options.replayIdempotencyDigest,
      });
    }
    return Response.json(ownerResponse);
  };
  const connection = testSqlConnection((statement, parameters) =>
    Effect.succeed(
      statement.includes('from core.principals p') &&
        options.activeBinding !== false &&
        parameters.includes(principal.authBindingId) &&
        parameters.includes('native-route-key') &&
        parameters.includes(principal.authenticationNamespaceId)
        ? [{ principal_id: principal.principalId }]
        : [],
    ),
  );
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
  );
  const issuer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(1_700_000_000),
    generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
    loadAdmission: Effect.succeed({
      audiences: new Map([['symmy-integration', 'native-route-build']]),
      revision: options.catalog?.composition.revision ?? compositionRevision,
    }),
    loadConfig: Effect.succeed({
      issuer: 'https://shell.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: jwk.d ?? '',
        kid: 'route-test',
        kty: 'OKP',
        use: 'sig',
        x: jwk.x ?? '',
      },
    }),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  const company = Layer.succeed(LegalEntityContext, {
    listActiveForTenant: () => Effect.succeed([{ legalEntityId, legalName: 'Route company' }]),
    validateSelection: (tenant, companyId) => {
      expect(tenant).toBe(principal.tenantId);
      expect(companyId).toBe(legalEntityId);
      return Effect.succeed({ legalEntityId, legalName: 'Route company' });
    },
  });
  const catalog = Layer.succeed(ShellInstalledModuleCatalog, {
    load:
      options.catalog === undefined
        ? Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'Projection must reject before catalog' }))
        : Effect.succeed(options.catalog),
  });
  return {
    calls,
    layer: Layer.mergeAll(database, issuer, company, catalog, Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
    publicKey,
  };
});

it.effect('obtains route scope from the protected generated owner Read and refuses reflective or copied proofs', () =>
  Effect.gen(function* actualRouteRead() {
    const current = yield* fixture({});
    yield* Effect.gen(function* inspectRouteProof() {
      const proof = yield* acquireSymmyRouteScopeProof(request);
      const route = yield* readSymmyRouteScope(proof);
      expect(route.legalEntityId).toBe(legalEntityId);
      Object.defineProperty(route, 'legalEntityId', { value: '90000000-0000-4000-8000-000000000001' });
      expect((yield* readSymmyRouteScope(proof)).legalEntityId).toBe(legalEntityId);
      const reflected = Reflect.construct(proof.constructor, [{}, { routeJson: JSON.stringify(response) }]);
      const reflectedFailure = yield* Effect.flip(readSymmyRouteScope(reflected));
      expect(reflectedFailure.code).toBe('forbidden');
      const copied = Object.assign(Object.create(Object.getPrototypeOf(proof)), proof);
      const copiedFailure = yield* Effect.flip(readSymmyRouteScope(copied));
      expect(copiedFailure.code).toBe('forbidden');
      const wrongCompany = yield* Effect.flip(
        projectSymmyRouteScopePrincipal(proof, {
          audience: 'party-registry',
          legalEntityId: '90000000-0000-4000-8000-000000000001',
          principal,
        }),
      );
      expect(wrongCompany.code).toBe('forbidden');
    }).pipe(Effect.provide(current.layer));
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]?.url).toBe(
      'https://symmy-owner-relay.invalid/module-api/symmy-integration/native-route-build/symmy-integration-api/reads/symmy-route-context',
    );
    expect(JSON.parse(current.calls[0]?.body ?? '{}')).toEqual({ routeKey: 'adminCustomers' });
    const authorization = current.calls[0]?.authorization ?? '';
    expect(decodeJwt(authorization.slice('Bearer '.length)).aud).toBe('symmy-integration');
  }),
);

it.effect('rejects a different tenant returned by the owner and a revoked authentication binding', () =>
  Effect.gen(function* tenantAndBindingControls() {
    const wrongTenant = yield* fixture({ responseTenant: '90000000-0000-4000-8000-000000000001' });
    const tenantFailure = yield* acquireSymmyRouteScopeProof(request).pipe(
      Effect.flip,
      Effect.provide(wrongTenant.layer),
    );
    expect(tenantFailure.code).toBe('forbidden');
    const revoked = yield* fixture({ activeBinding: false });
    const bindingFailure = yield* acquireSymmyRouteScopeProof(request).pipe(Effect.flip, Effect.provide(revoked.layer));
    expect(bindingFailure.code).toBe('forbidden');
    expect(revoked.calls).toHaveLength(0);
  }),
);

it.effect('refuses an admit-purpose claim for a read route before requesting owner authority', () =>
  Effect.gen(function* sourcePurposeControl() {
    const current = yield* fixture({});
    const failure = yield* acquireSymmyRouteScopeProof({ ...request, sourcePurpose: 'admit' }).pipe(
      Effect.flip,
      Effect.provide(current.layer),
    );
    expect(failure.code).toBe('forbidden');
    expect(current.calls).toHaveLength(0);
  }),
);

it.effect('refuses route metadata that names an owner operation absent from the published read contract', () =>
  Effect.gen(function* publishedReadControl() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'party-registry', moduleId: 'party.registry' }),
    ]);
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const current = yield* fixture({ catalog: { ...catalog, composition: snapshot.composition } });
    const failure = yield* Effect.gen(function* exactPublishedRead() {
      const proof = yield* acquireSymmyRouteScopeProof({
        ...request,
        compositionRevision: snapshot.composition.revision,
      });
      return yield* Effect.flip(
        projectSymmyRouteScopePrincipal(proof, {
          audience: 'party-registry',
          legalEntityId,
          principal,
        }),
      );
    }).pipe(Effect.provide(current.layer));
    expect(failure.code).toBe('forbidden');
    expect(current.calls).toHaveLength(1);
  }),
);

it.effect('signs only exact admission Actions and the approved v1 sync lookup for an admit-purpose route', () =>
  Effect.gen(function* signedSyncAdmissionRoute() {
    const moduleId = 'integration.symmy';
    const fixtureContract = makeModuleContractFixture({
      appId: 'symmy-integration',
      buildMarker: 'native-route-build',
      moduleId,
    });
    const admissionKeys = ['integration.symmy.admit-symmy-job', 'integration.symmy.admit-symmy-sync'];
    const readKeys = [
      'integration.symmy.api.symmy-sync-admission',
      'integration.symmy.api.symmy-route-context',
      'integration.symmy.api.unrelated-read',
    ];
    const snapshot = yield* makeCompositionSnapshot([
      {
        ...fixtureContract,
        manifest: {
          ...fixtureContract.manifest,
          publicSurface: {
            ...fixtureContract.manifest.publicSurface,
            actions: admissionKeys.map((actionKey) => ({
              accessWorkload: { reason: 'Exact integration admission', workloads: ['integration.symmy-admit'] },
              actionKey,
              auditProfile: 'standard',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: actionKey,
                moduleKey: moduleId,
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: moduleId,
              schemaVersion: '1',
            })),
            api: [
              {
                key: 'integration.symmy.api.route-reads',
                operationKeys: readKeys.map((_, index) => `read${index}.execute`),
              },
            ],
            operationContracts: readKeys.map((entrypointKey, index) => ({
              apiKey: 'integration.symmy.api.route-reads',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey,
                moduleKey: moduleId,
                role: 'api',
              }),
              operationKey: `read${index}.execute`,
              schemaVersion: '1',
            })),
          },
        },
      },
    ]);
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const current = yield* fixture({ catalog: { ...catalog, composition: snapshot.composition } });
    const assertion = yield* Effect.gen(function* issueExactAdmissionLookup() {
      const proof = yield* acquireSymmyRouteScopeProof({
        ...request,
        compositionRevision: snapshot.composition.revision,
        routeRequest: { routeKey: 'customersBatch' },
        sourcePurpose: 'admit',
      });
      return yield* issueSymmyRouteScopeAssertion(proof, { audience: 'symmy-integration', legalEntityId, principal });
    }).pipe(Effect.provide(current.layer));
    const verified = yield* Effect.promise(() =>
      jwtVerify(assertion.token, current.publicKey, {
        algorithms: ['EdDSA'],
        audience: 'symmy-integration',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
        issuer: 'https://shell.test',
      }),
    );
    expect(verified.payload['routeScope']).toEqual({
      legalEntityId,
      mappingVersion: response.mappingVersion,
      operations: [
        ...admissionKeys.map((entrypointKey) => ({ entrypointKey, schemaVersion: '1' })),
        { entrypointKey: 'integration.symmy.api.symmy-sync-admission', schemaVersion: '1' },
      ],
      principalId: principal.principalId,
      routeId: response.routeId,
      routeKey: 'customersBatch',
      routeRevision: response.routeRevision,
      sourceMappingVersion: response.sourceMappingVersion,
      sourceRouteId: response.sourceRouteId,
      sourceRouteRevision: response.sourceRouteRevision,
      tenantId: principal.tenantId,
    });
    const replayIdempotencyDigest = 'c'.repeat(64);
    const retained = yield* fixture({
      catalog: { ...catalog, composition: snapshot.composition },
      replayIdempotencyDigest,
    });
    const cases = [
      {
        operations: [
          { entrypointKey: 'integration.symmy.admit-symmy-sync', schemaVersion: '1' },
          { entrypointKey: 'integration.symmy.api.symmy-sync-admission', schemaVersion: '1' },
        ],
        routeKey: 'inventoryStockBatch',
      },
      {
        operations: [{ entrypointKey: 'integration.symmy.admit-symmy-job', schemaVersion: '1' }],
        routeKey: 'customersBatch',
      },
    ] as const;
    for (const { operations, routeKey } of cases) {
      const replay = yield* Effect.gen(function* issueRetainedAdmissionLookup() {
        const proof = yield* acquireSymmyRouteScopeProof({
          ...request,
          compositionRevision: snapshot.composition.revision,
          routeRequest: { replayIdempotencyKey: 'retained-receipt-key', routeKey },
          sourcePurpose: 'admit',
        });
        return yield* issueSymmyRouteScopeAssertion(proof, { audience: 'symmy-integration', legalEntityId, principal });
      }).pipe(Effect.provide(retained.layer));
      const retainedToken = yield* Effect.promise(() =>
        jwtVerify(replay.token, retained.publicKey, {
          algorithms: ['EdDSA'],
          audience: 'symmy-integration',
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
          issuer: 'https://shell.test',
        }),
      );
      expect(retainedToken.payload['routeScope']).toMatchObject({ operations, replayIdempotencyDigest, routeKey });
    }
  }),
);
