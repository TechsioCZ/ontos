import {
  createShellGovernedReadDefinitionsLayer,
  ShellGovernedReads,
  createShellGovernedReadsLayer,
} from '../../api/modules/shell-governed-reads.ts';
import { ShellGovernedReadDefinitions } from '../../api/modules/shell-governed-read-definitions.ts';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
/* @rstest-environment node */

// Server HTTP checks need one native fetch realm; mixed DOM Response/native Headers silently drops headers.
import {
  ContextAccess,
  LegalEntityContext,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  GatewayScopeGrantRegistrar,
  ReadRuntime,
  TenantModuleStateService,
  defineRead,
  defineVerticalRuntimeRegistration,
  defineTenantModuleEntrypoint,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime';
import type { GatewayScopeGrantInput, ReadCoreError, TrustedPrincipalContext } from '@app/core-runtime';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import {
  bindGatewayPrincipalVerifier,
  makeGatewayPrincipalVerifierLayer,
} from '../../../../packages/gateway-principal-verifier/src/server.ts';
import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { HttpApi, HttpApiBuilder, HttpApiGroup } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Effect, Exit, Layer, Redacted, Result, Schema } from 'effect';
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { ShellAuthenticationApi, ShellSearchPayloadSchema } from '../../shared/browser-api.ts';
import { issueShellSearchProviderAssertion, makeShellSearchNoStoreLayer, shellSearchHandler } from '../../api/index.ts';
import { GatewayIssuer, makeGatewayIssuerLayer, ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import { connectionPrincipalContext } from '../../api/mcp/connection.ts';
import { connectionDescription } from './mcp/fixture-vertical.ts';
import { retainedGrant } from './oauth-connections/grant-registry-fixture.ts';
import { toGrantRow } from '../../api/oauth-connections/grant-store.ts';
import { CapturedShellCompositionCatalog } from '../../api/modules/captured-shell-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import {
  ShellResourceServicesFactoryLive,
  ShellSearchProviderResultsSchema,
} from '../../api/modules/shell-resources.ts';
import { makeModuleSearchProviderGateway } from '../../api/modules/shell-search-provider-gateway.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../../api/modules/installed-module-catalog.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search-validation',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const company = { legalEntityId: principal.legalEntityId ?? '', legalName: 'Search company' };
const authenticated: ShellContextResult = {
  availableLegalEntities: [company],
  identity: {
    displayName: 'Search user',
    email: 'search@example.test',
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    ...company,
  },
  principal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=search', 'x-correlation-id': 'search-validation' } };

it('uses the Core 200-character meaningful-query contract without changing resource selectors', () => {
  const payload = { compositionRevision: 'a'.repeat(64), query: 'a'.repeat(200), resourceTypes: [] };
  expect(Schema.is(ShellSearchPayloadSchema)(payload)).toBe(true);
  for (const query of ['', '   ', '\u0301', 'a'.repeat(201)]) {
    expect(Schema.is(ShellSearchPayloadSchema)({ ...payload, query })).toBe(false);
  }
  expect(Schema.decodeUnknownSync(ShellSearchPayloadSchema)({ ...payload, query: '  ADAPTÉRY  ' })).toEqual({
    ...payload,
    query: 'ADAPTÉRY',
  });
});

const failedSearch = Effect.fn('test.failedSearch')(function* failedSearch(failure: ReadCoreError) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  return yield* shellSearchHandler(request, {
    compositionRevision: catalog.composition.revision,
    query: 'Eva',
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AuthenticationService,
          makeAuthenticationServiceDouble({ resolveShellContext: () => Effect.succeed(authenticated) }),
        ),
        Layer.succeed(AccessDecisionGate, makeTestAccessDecision()),
        Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
        Layer.mock(LegalEntityContext, {}),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, { search: () => Effect.fail(failure) }),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/search')),
        ),
      ),
    ),
    Effect.exit,
  );
});

const searchHttpApi = HttpApi.make('searchCacheControlTest').add(
  HttpApiGroup.make('resources').add(ShellAuthenticationApi.groups.resources.endpoints.search),
);

interface SearchHttpCase {
  readonly authenticated: ShellContextResult;
  readonly catalog: ShellInstalledCatalog;
  readonly correlationId: string;
}
const searchHttpResponse = Effect.fn('test.searchHttpResponse')(function* searchHttpResponse(
  search: ShellGovernedReadsService['search'],
  query = 'Eva',
  scenario?: SearchHttpCase,
) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = scenario?.catalog ?? (yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)));
  const handlers = HttpApiBuilder.group(searchHttpApi, 'resources', (builder) =>
    builder.handle('search', ({ payload, request: httpRequest }) => shellSearchHandler(httpRequest, payload)),
  ).pipe(Layer.provide(makeShellSearchNoStoreLayer()));
  const services = Layer.mergeAll(
    Layer.succeed(
      AuthenticationService,
      makeAuthenticationServiceDouble({
        resolveShellContext: () => Effect.succeed(scenario?.authenticated ?? authenticated),
      }),
    ),
    Layer.succeed(AccessDecisionGate, makeTestAccessDecision()),
    Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
    Layer.mock(LegalEntityContext, {}),
    Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
    Layer.mock(ShellGovernedReads, { search }),
  );
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(searchHttpApi).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(services),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (handler) => Effect.promise(() => handler.dispose()),
  );
  const response = yield* Effect.promise(() =>
    server.handler(
      new Request('https://shell.test/shell/search', {
        body: JSON.stringify({ compositionRevision: catalog.composition.revision, query }),
        headers: {
          ...request.headers,
          'content-type': 'application/json',
          'x-correlation-id': scenario?.correlationId ?? request.headers['x-correlation-id'],
        },
        method: 'POST',
      }),
    ),
  );
  return response;
});

it.effect('marks the encoded successful search response no-store', () =>
  Effect.gen(function* successfulSearchIsNotCacheable() {
    const response = yield* searchHttpResponse(() => Effect.succeed({ partial: false, results: [] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }).pipe(Effect.scoped),
);

for (const [status, failure] of [
  [400, new ReadInputValidationError({ code: 'read_input_invalid', reason: 'Invalid selector' })],
  [403, new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Read denied' })],
  [503, new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' })],
] as const) {
  it.effect(`marks the encoded search ${status} problem no-store`, () =>
    Effect.gen(function* failedSearchIsNotCacheable() {
      const response = yield* searchHttpResponse(() => Effect.fail(failure));
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }).pipe(Effect.scoped),
  );
}

it.effect('marks a pre-handler query validation problem no-store without invoking the owner', () =>
  Effect.gen(function* malformedSearchIsNotCacheable() {
    const response = yield* searchHttpResponse(() => Effect.die('Invalid query reached search'), 'a'.repeat(201));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }).pipe(Effect.scoped),
);

it.effect('leaves unrelated response cache policy unchanged', () =>
  Effect.gen(function* unrelatedResponseCacheControl() {
    const routes = HttpRouter.add(
      'POST',
      '/unrelated',
      HttpServerResponse.setHeader(HttpServerResponse.text('control'), 'cache-control', 'private, max-age=7'),
    ).pipe(Layer.provide(makeShellSearchNoStoreLayer()));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(new Request('https://shell.test/unrelated', { method: 'POST' })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=7');
  }).pipe(Effect.scoped),
);

it.effect('maps invalid search selectors to a generic 400 without echoing private validation details', () =>
  Effect.gen(function* invalidSelector() {
    const exit = yield* failedSearch(
      new ReadInputValidationError({ code: 'read_input_invalid', reason: 'SECRET unadmitted resource type' }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const serialized = JSON.stringify(exit);
    expect(serialized).toContain('ShellInvalidRequestProblem');
    expect(serialized).toContain('"status":400');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('ShellInternalProblem');
  }),
);

it.effect('keeps an actual search permission denial forbidden rather than classifying it as invalid input', () =>
  Effect.gen(function* permissionDenied() {
    const exit = yield* failedSearch(
      new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Read denied' }),
    );
    expect(JSON.stringify(exit)).toContain('ShellTargetForbiddenProblem');
    expect(JSON.stringify(exit)).toContain('"status":403');
  }),
);

it.effect('keeps an unavailable search owner retryable rather than reporting invalid input', () =>
  Effect.gen(function* ownerUnavailable() {
    const exit = yield* failedSearch(
      new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' }),
    );
    expect(JSON.stringify(exit)).toContain('ShellCapabilityUnavailableProblem');
    expect(JSON.stringify(exit)).toContain('"status":503');
  }),
);

const signedModule = 'signed.records';
const signedApp = 'signed-records';
const signedType = `${signedModule}.record`;
const signedIssuer = 'https://local-search-issuer.test';
const signedNow = 1_795_000_000;
const signedCorrelation = 'signed-production-search';
const neverPrivateQuery = () => Effect.die('The scripted signing test must not perform private SQL or unexpected I/O');

const oauthSearchPrincipal = (access: 'read' | 'write', agent = false) => {
  const actingPrincipalId = agent ? '00000000-0000-4000-8000-000000000007' : retainedGrant.actingPrincipalId;
  const description = connectionDescription({
    acting: { displayName: 'Verified fixture actor', kind: agent ? 'agent' : 'human', principalId: actingPrincipalId },
    client: {
      clientId: retainedGrant.clientId,
      host: retainedGrant.clientHost,
      kind: retainedGrant.clientKind,
      logoUri: null,
      name: retainedGrant.clientName,
    },
    delegatedBy: agent ? { displayName: 'Verified operator', principalId: retainedGrant.userPrincipalId } : null,
    grantId: retainedGrant.grantId,
    legalEntityId: retainedGrant.legalEntityId,
    modules: [{ label: signedModule, moduleId: signedModule, read: true, write: access === 'write' }],
    profileId: retainedGrant.profileId,
    tenantId: retainedGrant.tenantId,
    writePolicy: access === 'write' ? 'direct' : 'read_only',
  });
  return connectionPrincipalContext({
    description,
    grant: { ...toGrantRow(retainedGrant), actingKind: agent ? 'agent' : 'human', actingPrincipalId },
  });
};
const signedSessionPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  ...principal,
  authContextRef: 'better-auth-session:signed-search-fixture',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
});

const signedContract = () => {
  const base = makeModuleContractFixture({ appId: signedApp, moduleId: signedModule });
  return {
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        resourceTypes: [
          {
            capabilities: {
              graphVisible: false,
              linkable: true,
              mediaAttachable: false,
              searchable: true,
              timelineVisible: false,
            },
            description: 'Fixture current owner record',
            key: signedType,
            label: 'Fixture record',
            owningModuleId: signedModule,
          },
        ],
        search: [
          {
            accessFiltering: 'resource_permission',
            key: `${signedModule}.search`,
            owningModuleId: signedModule,
            resourceType: signedType,
          },
        ],
        shellContributions: {
          ...base.manifest.publicSurface.shellContributions,
          search: [
            {
              accessDeclaration: {
                key: `${signedModule}.records.read`,
                kind: 'read',
                modes: ['run'],
                placement: { group: 'records', level: 'basic' },
                risk: 'routine',
                selectors: [],
              },
              contributionKey: `${signedModule}.search.contribution`,
              entrypoint: {
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey: `${signedModule}.search`,
                moduleKey: signedModule,
                role: 'search',
                scope: 'tenant',
              },
              searchKey: `${signedModule}.search`,
            },
          ],
        },
      },
    },
  };
};
interface SignedCalls {
  issuer: number;
  jtis: number;
  owner: number;
  ownerRead: number;
}

/** Owns local in-memory key material for this Effect scope. No key, JWT or credential is written to evidence.
 * Production projection + real strict issuer + registration port + signature verification + actual receiver and
 * both Core ReadRuntime lifecycles execute. SQL, permissions and module transport remain deterministic fixtures.
 */
const signedSearchFixture = Effect.fn('SearchSigningTest.fixture')(function* signedSearchFixture(
  expected: TrustedPrincipalContext,
) {
  const snapshot = yield* makeCompositionSnapshot([signedContract()]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const jwk = yield* Effect.promise(() => exportJWK(privateKey));
  const configuration: GatewayIssuerConfigValue = {
    issuer: signedIssuer,
    privateJwk: {
      alg: 'EdDSA',
      crv: 'Ed25519',
      d: yield* Effect.fromNullishOr(jwk.d),
      kid: 'owned-local-search-test-key',
      kty: 'OKP',
      use: 'sig',
      x: yield* Effect.fromNullishOr(jwk.x),
    },
  };
  const calls: SignedCalls = { issuer: 0, jtis: 0, owner: 0, ownerRead: 0 };
  const registrations: GatewayScopeGrantInput[] = [];
  const controls = { ownerForbidden: false, ownerVisible: true, revokedModule: false };
  const issuerLayer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(signedNow),
    generateJti: Effect.sync(() => {
      calls.jtis += 1;
      return `60000000-0000-4000-8000-${String(calls.jtis).padStart(12, '0')}`;
    }),
    loadAdmission: Effect.succeed({
      audiences: new Map([[signedApp, `${signedApp}-build`]]),
      revision: catalog.composition.revision,
    }),
    loadConfig: Effect.succeed(configuration),
  }).pipe(
    Layer.provide(
      Layer.succeed(GatewayScopeGrantRegistrar, {
        register: (input) =>
          Effect.sync(() => {
            registrations.push(input);
          }),
      }),
    ),
  );
  const realIssuer = yield* GatewayIssuer.pipe(Effect.provide(issuerLayer));
  const tracedIssuer: (typeof GatewayIssuer)['Service'] = {
    issue: (input) => {
      calls.issuer += 1;
      return realIssuer.issue(input);
    },
    issueDocument: realIssuer.issueDocument,
  };
  const providerIssuer = {
    issueAssertion: (input: Parameters<typeof issueShellSearchProviderAssertion>[0]) =>
      issueShellSearchProviderAssertion(input).pipe(Effect.provideService(GatewayIssuer, tracedIssuer)),
  };
  const receiver = bindGatewayPrincipalVerifier(signedApp, { appId: signedApp, buildMarker: `${signedApp}-build` });
  const receiverLayer = makeGatewayPrincipalVerifierLayer(
    ConfigProvider.fromUnknown({
      ONTOS_GATEWAY_ISSUER: signedIssuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [
          {
            alg: 'EdDSA',
            crv: 'Ed25519',
            kid: configuration.privateJwk.kid,
            kty: 'OKP',
            use: 'sig',
            x: configuration.privateJwk.x,
          },
        ],
      }),
    }),
  );
  const compositionLayer = makeActiveApplicationCompositionLayer(Effect.succeed(snapshot));
  const verify = Effect.fn('SearchSigningTest.verify')(function* verify(authorization: string) {
    const token = authorization.slice('Bearer '.length);
    const verified = yield* Effect.promise(() =>
      jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        audience: signedApp,
        currentDate: new Date((signedNow + 1) * 1000),
        issuer: signedIssuer,
      }),
    );
    const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema, { onExcessProperty: 'error' })(
      verified.payload,
    );
    expect(claims.principal).toEqual(expected);
    expect(claims.sub).toBe(expected.principalId);
    expect(claims.compositionRevision).toBe(catalog.composition.revision);
    expect(claims.targetBuildMarker).toBe(`${signedApp}-build`);
    expect(verified.protectedHeader).toEqual({ alg: 'EdDSA', kid: configuration.privateJwk.kid, typ: 'JWT' });
    expect(claims.principal).not.toHaveProperty('correlationId');
    expect(claims.principal).not.toHaveProperty('traceId');
    expect(claims.principal).not.toHaveProperty('audience');
    const actual = yield* receiver
      .verify(Redacted.make(authorization), { currentTimeSeconds: Effect.succeed(signedNow + 1) })
      .pipe(Effect.provide(receiverLayer), Effect.provide(compositionLayer));
    expect(actual).toEqual(expected);
    return actual;
  });
  let harness = yield* makeReadTestHarness({
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: neverPrivateQuery,
    operationTime: new Date(signedNow * 1000),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope: { ...expected, correlationId: signedCorrelation },
  });
  const visibleRows = yield* Schema.decodeUnknownEffect(ShellSearchProviderResultsSchema)([
    {
      ref: {
        moduleId: signedModule,
        resourceId: 'current-record',
        resourceType: signedType,
        tenantId: expected.tenantId,
      },
      selectedLegalEntityId: expected.legalEntityId,
      title: 'Authorized current owner record',
    },
  ]);
  const ownerRead = defineRead(
    {
      accessDeclaration: {
        key: `${signedModule}.records.read`,
        kind: 'read',
        modes: ['run'],
        placement: { group: 'records', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      accessKind: 'search',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: `${signedModule}.search`,
        moduleKey: signedModule,
        role: 'search',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'signed.records.search.evidence.v1' },
      inputSchema: Schema.Struct({ query: Schema.String }),
      legalEntityScope: 'required',
      owningModuleKey: signedModule,
      policies: [],
      readKey: `${signedModule}.search`,
      resultSchema: ShellSearchProviderResultsSchema,
      schemaVersion: '1',
    },
    () => {
      calls.ownerRead += 1;
      return controls.ownerForbidden
        ? Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'PRIVATE-OWNER-DETAIL' }))
        : Effect.succeed({
            evidence: { resultCount: controls.ownerVisible ? 1 : 0 },
            result: controls.ownerVisible ? visibleRows : [],
          });
    },
    () => Effect.succeed({}),
  );
  const ownerContract = catalog.getByModuleId(signedModule);
  if (ownerContract === undefined) {
    return yield* Effect.die('The declared owner release is missing');
  }
  const ownerRegistration = defineVerticalRuntimeRegistration({
    actions: [],
    manifest: {
      module: ownerContract.manifest.module,
      publicSurface: {
        actions: [],
        api: {},
        operationContracts: [],
        shellContributions: ownerContract.manifest.publicSurface.shellContributions,
      },
    },
    outboxWorkers: [],
    reads: [ownerRead],
  });
  const ownerHarness = yield* makeReadTestHarness({
    access: 'allowed',
    applicationComposition: { load: Effect.succeed(snapshot) },
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: neverPrivateQuery,
    expectedDeployment: ownerContract.deployment,
    operationTime: new Date(signedNow * 1000),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration,
    scope: { ...expected, correlationId: signedCorrelation },
  });
  const gateway = makeModuleSearchProviderGateway((outgoing) =>
    Effect.gen(function* actualSignedOwnerRequest() {
      calls.owner += 1;
      expect(outgoing.headers.get('x-correlation-id')).toBe(signedCorrelation);
      const authorization = outgoing.headers.get('authorization');
      const decoded = yield* verify(yield* Effect.fromNullishOr(authorization).pipe(Effect.orDie)).pipe(Effect.orDie);
      const body = yield* Effect.promise(() => outgoing.json());
      return yield* ownerHarness.runtime
        .runRead({
          input: body,
          principal: decoded,
          registration: ownerRead,
          transport: { correlationId: signedCorrelation },
        })
        .pipe(
          Effect.provide(staffAuthenticationNamespaceRegistryLayer([signedApp]).pipe(Layer.orDie)),
          Effect.match({
            onFailure: (failure) =>
              Response.json(
                { privateOwnerDetail: 'PRIVATE-OWNER-BODY' },
                { status: Schema.is(ReadPermissionDenied)(failure) ? 403 : 503 },
              ),
            onSuccess: (rows) => Response.json(rows),
          }),
        );
    }),
  );
  const nativeAccess = yield* ContextAccess.pipe(Effect.provide(harness.layer));
  const access = {
    ...nativeAccess,
    modules: (input: Parameters<typeof nativeAccess.modules>[0]) =>
      controls.revokedModule
        ? Effect.succeed(input.moduleIds.map((key) => ({ decision: 'denied' as const, key })))
        : nativeAccess.modules(input),
  };
  const states = {
    getTenantModuleStates: (_tenant: string, moduleIds: readonly string[]) =>
      Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' as const }))),
    listActiveTenantModules: neverPrivateQuery,
    listTenantModuleStates: neverPrivateQuery,
  };
  const definitionsLayer = createShellGovernedReadDefinitionsLayer(
    { resource: { detail: neverPrivateQuery, timeline: neverPrivateQuery }, search: gateway },
    providerIssuer,
    () => states,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ReadRuntime, harness.runtime),
        Layer.succeed(
          AccessDecisionGate,
          makeTestAccessDecision({
            answers: {
              [`${signedModule}.records.read`]: {
                get outcome() {
                  return controls.revokedModule ? 'DENIED' : 'ALLOWED';
                },
              },
            },
          }),
        ),
        Layer.succeed(ContextAccess, access),
        Layer.succeed(TenantModuleStateService, states),
        ShellCompositionFactoryLive,
        ShellResourceServicesFactoryLive,
      ),
    ),
  );
  const readRegistrations = yield* ShellGovernedReadDefinitions.pipe(Effect.provide(definitionsLayer));
  harness = yield* makeReadTestHarness({
    access: 'allowed',
    applicationComposition: { load: makeCompositionSnapshot(catalog.contracts) },
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: () => Effect.die('Unexpected Shell owner SQL'),
    expectedDeployment: catalog.composition.shell.deployment,
    operationTime: new Date('2026-11-03T15:00:00Z'),
    ownerAuthorizationDecision: 'allowed',
    scope: { ...expected, correlationId: signedCorrelation },
    shellSystemReads: readRegistrations,
  });
  const layer = createShellGovernedReadsLayer(readRegistrations).pipe(
    Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
  );
  const reads = yield* ShellGovernedReads.pipe(Effect.provide(layer), Effect.orDie);
  const run: ShellGovernedReadsService['search'] = (input) =>
    reads
      .search(input)
      .pipe(
        Effect.provideService(CapturedShellCompositionCatalog, catalog),
        Effect.provide(
          staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId]).pipe(Layer.orDie),
        ),
      );
  const search = (overrides?: Partial<Parameters<ShellGovernedReadsService['search']>[0]>) =>
    run({
      compositionRevision: catalog.composition.revision,
      correlationId: signedCorrelation,
      principal: expected,
      query: 'record',
      ...overrides,
    });
  return { calls, catalog, controls, harness, ownerHarness, providerIssuer, registrations, run, search, verify };
});

for (const [label, expected] of [
  ['OAuth read', oauthSearchPrincipal('read')],
  ['OAuth write', oauthSearchPrincipal('write')],
  ['delegated OAuth agent', oauthSearchPrincipal('write', true)],
  ['session', signedSessionPrincipal],
] as const) {
  it.effect(
    `production projection signs and verifies unchanged ${label} authority through both actual ReadRuntimes`,
    () =>
      Effect.gen(function* signedRoundtrip() {
        const f = yield* signedSearchFixture(expected);
        const result = yield* f.search();
        expect(result.results).toHaveLength(1);
        expect(f.calls).toEqual({ issuer: 1, jtis: 1, owner: 1, ownerRead: 1 });
        expect(f.registrations).toHaveLength(1);
        expect(f.registrations[0]).toMatchObject({
          audience: signedApp,
          expiresAtEpochSeconds: signedNow + 300,
          legalEntityId: expected.legalEntityId,
          principalId: expected.principalId,
          tenantId: expected.tenantId,
        });
        expect(f.harness.snapshot().evidenceWrites).toBe(1);
        expect(f.ownerHarness.snapshot().evidenceWrites).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );
}

it.effect(
  'production projection omits only operational fields and preserves canonical support and storefront fields',
  () =>
    Effect.gen(function* canonicalOptionals() {
      for (const expected of [
        Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          ...signedSessionPrincipal,
          authMethod: 'support_impersonation',
          impersonatedByPrincipalId: '20000000-0000-4000-8000-000000000099',
        }),
        Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          ...signedSessionPrincipal,
          trustedStorefrontId: 'fixture-storefront',
        }),
      ]) {
        const f = yield* signedSearchFixture(expected);
        const context = {
          ...expected,
          audience: 'operational-only',
          correlationId: signedCorrelation,
          traceId: 'operational-trace',
        };
        const authorization = yield* f.providerIssuer.issueAssertion({
          appId: signedApp,
          compositionRevision: f.catalog.composition.revision,
          context,
        });
        expect(yield* f.verify(authorization)).toEqual(expected);
        expect(f.calls.issuer).toBe(1);
        expect(f.registrations).toHaveLength(1);
      }
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);

it.effect(
  'pre-admission missing/empty/narrowed/revoked authority, forged types and wrong tenant/composition issue no assertion and call no owner',
  () =>
    Effect.gen(function* noIssuerBeforeAdmission() {
      const expected = oauthSearchPrincipal('read');
      const { connection: _connection, ...missing } = expected;
      const narrowed = { ...expected, connection: { ...expected.connection, modules: [] } };
      for (const control of [
        { principal: missing },
        { principal: narrowed },
        { principal: { ...expected, tenantId: '00000000-0000-4000-8000-000000000099' } },
        { compositionRevision: 'a'.repeat(64) },
        { resourceTypes: ['unknown.record'] },
        { resourceTypes: ['core.identity.person'] },
      ]) {
        const f = yield* signedSearchFixture(expected);
        expect(Result.isFailure(yield* f.search(control).pipe(Effect.result))).toBe(true);
        expect(f.calls).toEqual({ issuer: 0, jtis: 0, owner: 0, ownerRead: 0 });
        expect(f.registrations).toEqual([]);
      }
      const revoked = yield* signedSearchFixture(expected);
      revoked.controls.revokedModule = true;
      expect(yield* revoked.search()).toEqual({
        partial: false,
        presentation: {
          business: { compositionRevision: revoked.catalog.composition.revision, entries: [], schemaVersion: '1' },
          pages: [],
        },
        results: [],
      });
      expect(revoked.calls).toEqual({ issuer: 0, jtis: 0, owner: 0, ownerRead: 0 });
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);

it.effect('the production projection rejects malformed OAuth authority before the real issuer is called', () =>
  Effect.gen(function* invalidProjectionAuthority() {
    const expected = oauthSearchPrincipal('read');
    const { connection: _connection, ...missing } = expected;
    for (const malformed of [missing, { ...expected, authBindingId: 'malformed-binding' }]) {
      const f = yield* signedSearchFixture(expected);
      const failure = yield* f.providerIssuer
        .issueAssertion({
          appId: signedApp,
          compositionRevision: f.catalog.composition.revision,
          context: { ...malformed, correlationId: signedCorrelation },
        })
        .pipe(Effect.result);
      expect(Result.isFailure(failure)).toBe(true);
      expect(f.calls).toEqual({ issuer: 0, jtis: 0, owner: 0, ownerRead: 0 });
      expect(f.registrations).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);

it.effect(
  'one genuine signed owner entrypoint403 survives fan-out as403 without retry, leaked owner text or a second assertion',
  () =>
    Effect.gen(function* signedOwnerRefusal() {
      const f = yield* signedSearchFixture(oauthSearchPrincipal('read'));
      f.controls.ownerForbidden = true;
      const failure = yield* Effect.flip(f.search());
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(f.calls).toEqual({ issuer: 1, jtis: 1, owner: 1, ownerRead: 1 });
      expect(f.registrations).toHaveLength(1);
      expect(JSON.stringify(failure)).not.toContain('PRIVATE-OWNER');
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);

it.live(
  'actual governed HTTP emits403/no-store after exactly one signed owner refusal without leaking the owner response',
  () =>
    Effect.gen(function* signedHttpRefusal() {
      const f = yield* signedSearchFixture(signedSessionPrincipal);
      f.controls.ownerForbidden = true;
      const response = yield* searchHttpResponse(f.run, 'record', {
        authenticated: { ...authenticated, principal: signedSessionPrincipal },
        catalog: f.catalog,
        correlationId: signedCorrelation,
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('PRIVATE-OWNER');
      expect(body).not.toContain('Bearer');
      expect(f.calls).toEqual({ issuer: 1, jtis: 1, owner: 1, ownerRead: 1 });
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);

it.effect('canonical owner-filtered200 remains a successful signed empty collection', () =>
  Effect.gen(function* signedFilteredCollection() {
    const f = yield* signedSearchFixture(oauthSearchPrincipal('read'));
    f.controls.ownerVisible = false;
    expect(yield* f.search()).toEqual({
      partial: false,
      presentation: {
        business: { compositionRevision: f.catalog.composition.revision, entries: [], schemaVersion: '1' },
        pages: [],
      },
      results: [],
    });
    expect(f.calls).toEqual({ issuer: 1, jtis: 1, owner: 1, ownerRead: 1 });
  }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
);
