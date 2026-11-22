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
  readonly allowedOwnerOperations?: typeof response.allowedOwnerOperations;
  readonly catalog?: ShellInstalledCatalog;
  /** The owner answers a route enrolled for no company. */
  readonly companyless?: boolean;
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
    const { legalEntityId: _company, ...companylessRoute } = response;
    const ownerResponse = {
      ...(options.companyless === true ? companylessRoute : response),
      allowedOwnerOperations: options.allowedOwnerOperations ?? response.allowedOwnerOperations,
      tenantId: options.responseTenant ?? response.tenantId,
    };
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
      audiences: new Map([
        ['commerce-customer-context', 'native-route-build'],
        ['symmy-integration', 'native-route-build'],
        ['inventory', 'native-route-build'],
      ]),
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

it.effect('signs on the customer groups admission route only its enrolled Commerce definition read', () =>
  Effect.gen(function* admissionDefinitionRead() {
    const moduleId = 'commerce.customer-context';
    const definitionRead = 'commerce.customer-context.api.customer-group-definition-source';
    const otherRead = 'commerce.customer-context.api.customer-profile-source-page';
    const groupCreate = 'commerce.customer-context.create-customer-group';
    const commerce = makeModuleContractFixture({ appId: 'commerce-customer-context', moduleId });
    // The catalog publishes the group create as a write and the definition read with the access under test.
    const publish = (definitionAccess: 'historical_read' | 'read') =>
      Effect.gen(function* publishedCommerce() {
        const snapshot = yield* makeCompositionSnapshot([
          {
            ...commerce,
            manifest: {
              ...commerce.manifest,
              publicSurface: {
                ...commerce.manifest.publicSurface,
                actions: [
                  {
                    accessWorkload: {
                      reason: 'Exact source group write',
                      workloads: ['commerce.customer-context.source-write'],
                    },
                    actionKey: groupCreate,
                    auditProfile: 'standard',
                    entrypoint: defineTenantModuleEntrypoint({
                      access: 'write',
                      authorization: { kind: 'protected' },
                      entrypointKey: groupCreate,
                      moduleKey: moduleId,
                      role: 'action',
                    }),
                    idempotency: 'required',
                    legalEntityScope: 'required',
                    owningModuleId: moduleId,
                    schemaVersion: '1',
                  },
                ],
                api: [
                  { key: 'commerce.customer-context.api.reads', operationKeys: ['read0.execute', 'read1.execute'] },
                ],
                operationContracts: [
                  { access: definitionAccess, entrypointKey: definitionRead },
                  { access: 'read' as const, entrypointKey: otherRead },
                ].map(({ access, entrypointKey }, index) => ({
                  apiKey: 'commerce.customer-context.api.reads',
                  entrypoint: defineTenantModuleEntrypoint({
                    access,
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
        return { ...catalog, composition: snapshot.composition };
      });
    const enrolled = (entrypointKeys: readonly string[]) =>
      entrypointKeys.map((entrypointKey) => ({ entrypointKey, moduleId, schemaVersion: '1' }));
    const issue = (input: {
      readonly catalog: ShellInstalledCatalog;
      readonly company?: string;
      readonly companyless?: boolean;
      readonly entrypointKeys: readonly string[];
      readonly routeKey: 'customerGroupsBatch' | 'customersBatch';
    }) =>
      Effect.gen(function* issueCommerceRead() {
        const current = yield* fixture({
          allowedOwnerOperations: enrolled(input.entrypointKeys),
          catalog: input.catalog,
          companyless: input.companyless === true,
        });
        const assertion = yield* Effect.gen(function* admissionRoute() {
          const proof = yield* acquireSymmyRouteScopeProof({
            ...request,
            compositionRevision: input.catalog.composition.revision,
            routeRequest: { routeKey: input.routeKey },
            sourcePurpose: 'admit',
          });
          const target = { audience: 'commerce-customer-context', principal };
          return yield* issueSymmyRouteScopeAssertion(
            proof,
            input.companyless === true ? target : { ...target, legalEntityId: input.company ?? legalEntityId },
          );
        }).pipe(Effect.provide(current.layer));
        return yield* Effect.promise(() =>
          jwtVerify(assertion.token, current.publicKey, {
            algorithms: ['EdDSA'],
            audience: 'commerce-customer-context',
            currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
            issuer: 'https://shell.test',
          }),
        );
      });
    const catalog = yield* publish('read');
    const groupRoute = [groupCreate, 'commerce.customer-context.update-customer-group', definitionRead, otherRead];
    // Two enrollment items name the definition read; the assertion names it once.
    const signed = yield* issue({
      catalog,
      entrypointKeys: [...groupRoute, definitionRead],
      routeKey: 'customerGroupsBatch',
    });
    expect(signed.payload['routeScope']).toMatchObject({
      legalEntityId,
      operations: [{ entrypointKey: definitionRead, schemaVersion: '1' }],
      principalId: principal.principalId,
      routeKey: 'customerGroupsBatch',
      tenantId: principal.tenantId,
    });
    // Another admission route; the group route without the definition read, though it enrolls a published write;
    // another company on the group route; a group route enrolled for no company, whose assertion would carry no route
    // scope; and a definition read published only for historical reads.
    for (const refusedInput of [
      { catalog, entrypointKeys: groupRoute, routeKey: 'customersBatch' },
      {
        catalog,
        entrypointKeys: groupRoute.filter((entrypointKey) => entrypointKey !== definitionRead),
        routeKey: 'customerGroupsBatch',
      },
      {
        catalog,
        company: '90000000-0000-4000-8000-000000000001',
        entrypointKeys: groupRoute,
        routeKey: 'customerGroupsBatch',
      },
      { catalog, companyless: true, entrypointKeys: groupRoute, routeKey: 'customerGroupsBatch' },
      { catalog: yield* publish('historical_read'), entrypointKeys: groupRoute, routeKey: 'customerGroupsBatch' },
    ] as const) {
      const refused = yield* Effect.flip(issue(refusedInput));
      expect(refused).toMatchObject({ code: 'forbidden' });
    }
  }),
);

it.effect(
  'admits only the enrolled current Inventory position read and projects its authority to Tenant, even from a company route',
  () =>
    Effect.gen(function* inventoryReadProjection() {
      const moduleId = 'commerce.inventory';
      const entrypointKey = 'commerce.inventory.api.source-stock-position-resolution';
      const base = makeModuleContractFixture({ appId: 'inventory', moduleId });
      const snapshot = yield* makeCompositionSnapshot([
        {
          ...base,
          manifest: {
            ...base.manifest,
            publicSurface: {
              ...base.manifest.publicSurface,
              api: [{ key: 'commerce.inventory.api.reads', operationKeys: ['position.execute'] }],
              operationContracts: [
                {
                  apiKey: 'commerce.inventory.api.reads',
                  entrypoint: defineTenantModuleEntrypoint({
                    access: 'read',
                    authorization: { kind: 'protected' },
                    entrypointKey,
                    moduleKey: moduleId,
                    role: 'api',
                  }),
                  operationKey: 'position.execute',
                  schemaVersion: '1',
                },
              ],
            },
          },
        },
      ]);
      const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
      const installed = { ...catalog, composition: snapshot.composition };
      yield* Effect.forEach(
        [true, false],
        (companyless) =>
          Effect.gen(function* tenantAndCompany() {
            const current = yield* fixture({
              allowedOwnerOperations: [{ entrypointKey, moduleId, schemaVersion: '1' }],
              catalog: installed,
              companyless,
            });
            const projected = yield* Effect.gen(function* projectRead() {
              const proof = yield* acquireSymmyRouteScopeProof({
                ...request,
                compositionRevision: snapshot.composition.revision,
                routeRequest: { routeKey: 'inventoryStockBatch' },
                sourcePurpose: 'admit',
              });
              return yield* projectSymmyRouteScopePrincipal(proof, { audience: 'inventory', principal });
            }).pipe(Effect.provide(current.layer));
            expect(projected.legalEntityId).toBeUndefined();
            expect(projected.tenantId).toBe(principal.tenantId);
          }),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        ['customersBatch', 'inventoryStockBatch'] as const,
        (routeKey) =>
          Effect.gen(function* deniedRead() {
            const current = yield* fixture({
              allowedOwnerOperations: [
                {
                  entrypointKey: 'commerce.inventory.api.inventory-source-import-receipt',
                  moduleId,
                  schemaVersion: '1',
                },
              ],
              catalog: installed,
              companyless: true,
            });
            const failure = yield* Effect.gen(function* readWithoutEnrollment() {
              const proof = yield* acquireSymmyRouteScopeProof({
                ...request,
                compositionRevision: snapshot.composition.revision,
                routeRequest: { routeKey },
                sourcePurpose: 'admit',
              });
              return yield* projectSymmyRouteScopePrincipal(proof, { audience: 'inventory', principal });
            }).pipe(Effect.provide(current.layer), Effect.flip);
            expect(failure).toMatchObject({ code: 'forbidden' });
          }),
        { concurrency: 1 },
      );
    }),
);
