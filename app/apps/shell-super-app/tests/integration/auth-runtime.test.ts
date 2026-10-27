import { SHARED_RUNTIME_IDENTITY } from '../../../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ActiveApplicationCompositionService,
  PrincipalResolver,
  PrincipalResolverUnavailableError,
  ContextAccess,
  GatewayScopeGrantRegistrarLive,
  LegalEntityContext,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
  loadDatabaseConnectionPair,
  makePrincipalResolver,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';

import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import { AuthenticationNamespaceRegistrationSchema } from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import { renderActionPrincipalServer } from '../../../../scripts/scaffolding/microvertical-action-boundary/scaffold.mts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, BetterAuthNativeAdapterLive, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, apikey, authRelations, session, user } from '../../api/auth/db/schema.ts';
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerLayerOptions } from '../../api/auth/gateway-issuer.ts';
import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive } from '../../api/oauth-connections/grant-store.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { OAuthAuthenticationAuditLive } from '../../../../packages/core-runtime/src/auth/oauth-authentication-audit.ts';
import { OAuthGrantRegistryLive } from '../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { ShellDocumentContextSchema } from '../../shared/api.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

import { makeDatabaseIdentityEnrollmentLive } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

type AuthenticationRuntimeHandler = ReturnType<ReturnType<typeof makeShellAuthenticationApiRuntime>['createHandler']>;
const email = 'better-auth-runtime@example.test';
const password = 'correct-horse-battery-staple';
const tenantId = '30000000-0000-4000-8000-000000000001';
const foreignTenantId = '30000000-0000-4000-8000-000000000002';
const principalId = '40000000-0000-4000-8000-000000000001';
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const fixtureLegalEntityId = '35000000-0000-4000-8000-000000000001';
const fixtureAuthBindingId = '45000000-0000-4000-8000-000000000001';
const staffAuthenticationNamespaceId = 'test.staff.better-auth.v1';
const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
  Schema.decodeUnknownSync(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['billing', 'inventory-stock', 'testing1'],
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    provider: 'better-auth',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user', 'api_key'],
    trustedAttesterPrincipalIds: [],
  }),
]);
const PrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
const IdentityResponseSchema = Schema.Struct({
  identity: Schema.Struct({
    email: Schema.String,
    principalId: PrincipalIdSchema,
  }),
});
const ProblemStatusSchema = Schema.Struct({ status: Schema.Number });
const SessionResponseSchema = Schema.Struct({
  identity: Schema.optional(Schema.Struct({ principalId: Schema.optional(PrincipalIdSchema) })),
});
const RetryableProblemSchema = Schema.Struct({
  retryable: Schema.optional(Schema.Boolean),
});
const TokenResponseSchema = Schema.Struct({ token: Schema.String });
const DefectProblemSchema = Schema.Struct({
  detail: Schema.optional(Schema.String),
});
const legalEntitySelectionOptions = {
  contextAccess: {
    legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
      Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
    resources: () => Effect.succeed([]),
    tenants: ({ tenantIds }: { readonly tenantIds: readonly string[] }) =>
      Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
  },
  legalEntityContext: {
    listActiveForTenant: () =>
      Effect.succeed([
        {
          legalEntityId: fixtureLegalEntityId,
          legalName: 'Fixture legal entity',
        },
      ]),
    validateSelection: (_tenantId: string, legalEntityId: string) =>
      legalEntityId === fixtureLegalEntityId
        ? Effect.succeed({ legalEntityId, legalName: 'Fixture legal entity' })
        : Effect.die('missing fixture legal entity'),
  },
} as const;
const contextAccessLayer = Layer.mergeAll(
  Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
  Layer.succeed(ContextAccess, legalEntitySelectionOptions.contextAccess),
);
const authenticationContextLayer = Layer.mergeAll(
  contextAccessLayer,
  Layer.succeed(LegalEntityContext, legalEntitySelectionOptions.legalEntityContext),
);
const cookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.map((header) => header.split(';')[0]).join('; ');
const headerValue = (headers: Headers, name: string): string => headers.get(name) ?? '';
const optionalText = (value: string | undefined): string => value ?? '';
/** A revoked or missing binding must fail closed on the next session resolution. */
const assertSessionForbidden = Effect.fnUntraced(function* assertSessionForbidden(
  resolution: Effect.Effect<unknown, unknown>,
) {
  const failure = yield* Effect.flip(resolution);
  expect(Predicate.isTagged(failure, 'OntosIdentityForbiddenError')).toBe(true);
});
/** Verify the issued assertion while retaining each caller's principal expectations. */
const verifiedGatewayAssertion = Effect.fnUntraced(function* verifiedGatewayAssertion(
  assertionResponse: Response,
  publicKey: Parameters<typeof jwtVerify>[1],
  expectedCompositionRevision: string,
) {
  const assertion = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(
    yield* Effect.tryPromise(() => assertionResponse.json()),
  );
  const verified = yield* Effect.tryPromise(() =>
    jwtVerify(assertion.token, publicKey, {
      algorithms: ['EdDSA'],
      audience: 'inventory-stock',
      currentDate: new Date(1_700_000_001_000),
      issuer: 'https://shell.example.test',
    }),
  );
  expect(verified.payload['compositionRevision']).toBe(expectedCompositionRevision);
  expect(verified.payload['targetBuildMarker']).toBe('integration-build');
  return {
    principal: yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(verified.payload['principal']),
    token: assertion.token,
  };
});
const assertOptionalField = <Value extends object, Key extends keyof Value>(
  value: Value | null | undefined,
  key: Key,
  expected: string | null,
): void => {
  expect(value?.[key]).toBe(expected);
};

const installedContracts = (moduleIds: readonly string[]) =>
  moduleIds.map((moduleId, index) => ({
    deployment: {
      appId: index === 0 ? 'inventory-stock' : moduleId.replaceAll('.', '-'),
      buildMarker: 'integration-build',
    },
    manifest: {
      activation: {
        defaultState: 'inactive',
        preservesHistoryWhenInactive: true,
        scope: 'tenant',
        supportedStates: ['inactive', 'active', 'read_only'],
      },
      module: {
        description: 'Integration module.',
        displayName: moduleId,
        id: moduleId,
        implementedAs: 'ultramodern_microvertical',
        kind: 'business_module',
      },
      publicSurface: {
        actions: [],
        api: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: [],
        search: [],
        shellContributions: {
          mediaAttachments: [],
          navigation: [],
          pages: [],
          publicComponents: [],
          reports: [],
          resourceDetails: [],
          search: [],
          timelines: [],
        },
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: '2',
  }));

const installedSnapshot = (moduleIds: readonly string[]) => makeCompositionSnapshot(installedContracts(moduleIds));
const installedCatalog = (moduleIds: readonly string[]) =>
  makeInstalledModuleCatalogLoader(installedSnapshot(moduleIds));
const installedAdmission = (moduleIds: readonly string[]): GatewayIssuerLayerOptions['loadAdmission'] =>
  installedCatalog(moduleIds).pipe(
    Effect.map(({ composition }) => ({
      audiences: new Map(composition.modules.map(({ deployment }) => [deployment.appId, deployment.buildMarker])),
      revision: composition.revision,
    })),
  );

const installedPageCatalog = () =>
  makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([
      {
        deployment: {
          appId: 'inventory-stock',
          buildMarker: 'integration-build',
        },
        manifest: {
          activation: {
            defaultState: 'inactive',
            preservesHistoryWhenInactive: true,
            scope: 'tenant',
            supportedStates: ['inactive', 'active', 'read_only'],
          },
          module: {
            description: 'Integration module.',
            displayName: 'Integration module',
            id: 'testing.pages',
            implementedAs: 'ultramodern_microvertical',
            kind: 'business_module',
          },
          publicSurface: {
            actions: [],
            api: [],
            components: [
              {
                expose: './PageHome',
                key: 'testing.pages.page-home',
                mfBoundaryId: 'verticalInventoryStock',
              },
              {
                expose: './PageCustomers',
                key: 'testing.pages.page-customers',
                mfBoundaryId: 'verticalInventoryStock',
              },
            ],
            events: [],
            reports: [],
            resourceTypes: [],
            search: [],
            shellContributions: {
              mediaAttachments: [],
              navigation: [
                {
                  contributionKey: 'testing.pages.navigation.home',
                  entrypoint: {
                    access: 'read',
                    authorization: { kind: 'authenticated_principal' },
                    entrypointKey: 'testing.pages.page.home',
                    moduleKey: 'testing.pages',
                    role: 'page',
                    scope: 'tenant',
                  },
                  groupKey: 'shell.navigation.modules',
                  icon: 'icon-[mdi--view-grid-outline]',
                  label: { cs: 'Domů', en: 'Home' },
                  order: 100,
                  pageKey: 'testing.pages.page.home',
                },
              ],
              pages: [
                {
                  componentKey: 'testing.pages.page-home',
                  contributionKey: 'testing.pages.page.home',
                  entrypoint: {
                    access: 'read',
                    authorization: { kind: 'authenticated_principal' },
                    entrypointKey: 'testing.pages.page.home',
                    moduleKey: 'testing.pages',
                    role: 'page',
                    scope: 'tenant',
                  },
                  expose: './PageHome',
                  routePath: '/inventory-stock',
                },
                {
                  componentKey: 'testing.pages.page-customers',
                  contributionKey: 'testing.pages.page.customers',
                  entrypoint: {
                    access: 'read',
                    authorization: { kind: 'authenticated_principal' },
                    entrypointKey: 'testing.pages.page.customers',
                    moduleKey: 'testing.pages',
                    role: 'page',
                    scope: 'tenant',
                  },
                  expose: './PageCustomers',
                  routePath: '/inventory-stock/customers',
                },
              ],
              publicComponents: [],
              reports: [],
              resourceDetails: [],
              search: [],
              timelines: [],
            },
          },
        },
        runtime: { outboxSubscriptions: [] },
        schemaVersion: '2',
      },
    ]),
  );
it.live(
  'creates, resolves, persists, revokes, and signs out a Better Auth session',
  Effect.fnUntraced(function* runIntegration1() {
    // Production also requires secure cookies when its local/public origin is HTTP.
    const configuration = { ...(yield* loadAuthConfig({ envPath: '/dev/null' })), secureCookies: true };
    const coreClient = yield* makeTestPgClient(configuration.connectionString);
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const authPersistence = yield* makeAuthDatabase({
      connectionString: configuration.connectionString,
      expectedRole: SHARED_RUNTIME_IDENTITY.role,
    });
    const authDatabase = authPersistence.executor;
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: staffAuthenticationNamespaceId },
    );
    const betterAuthRuntime = Layer.succeedContext(yield* Layer.build(BetterAuthRuntimeLive));
    const oauthAuthenticationLayer = Layer.mergeAll(
      betterAuthRuntime,
      BetterAuthNativeAdapterLive,
      OAuthAuthenticationAuditLive,
      OAuthEndpointGuardDataLive,
      OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
    ).pipe(
      Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor: coreDatabase }),
          Layer.succeed(AuthDatabase, authPersistence),
        ),
      ),
    );
    const authenticationFramework = BetterAuthFrameworkLive({ allowFixtureSignUp: true }).pipe(
      Layer.provideMerge(oauthAuthenticationLayer),
    );
    const authenticationGuards = OAuthEndpointGuardsLive.pipe(Layer.provideMerge(authenticationFramework));
    const authentication = yield* makeAuthenticationService().pipe(
      Effect.provide(authenticationGuards),
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    const authenticationLayer = Layer.succeed(AuthenticationService, authentication);
    const moduleStateLayer = Layer.succeed(
      TenantModuleStateService,
      makeTenantModuleStateService({ executor: coreDatabase }),
    );
    const handlers: AuthenticationRuntimeHandler[] = [];
    const generatedFixtureRoot = yield* Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), 'ontos-auth-runtime-')));
    const cleanup = Effect.fnUntraced(function* runIntegration2() {
      yield* purgeFixtureRows([
        coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
      ]);
      const existingUsers = yield* authDatabase.select({ id: user.id }).from(user).where(eq(user.email, email));
      yield* Effect.all(
        existingUsers.map(
          Effect.fnUntraced(function* runIntegration3(existingUser) {
            yield* purgeFixtureRows([
              coreDatabase
                .delete(principalAuthBindings)
                .where(eq(principalAuthBindings.providerSubjectId, existingUser.id)),
              authDatabase.delete(session).where(eq(session.userId, existingUser.id)),
              authDatabase.delete(account).where(eq(account.userId, existingUser.id)),
              authDatabase.delete(user).where(eq(user.id, existingUser.id)),
            ]);
          }),
        ),
      );
      yield* purgeFixtureRows([
        coreDatabase.delete(principalAuthBindings).where(eq(principalAuthBindings.principalId, principalId)),
        coreDatabase.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
        coreDatabase.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, foreignTenantId)),
        coreDatabase.delete(principals).where(eq(principals.principalId, principalId)),
        coreDatabase.delete(legalEntities).where(eq(legalEntities.legalEntityId, fixtureLegalEntityId)),
        coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId)),
        coreDatabase.delete(tenants).where(eq(tenants.tenantId, foreignTenantId)),
      ]);
    });
    yield* Effect.acquireRelease(
      Effect.void,
      Effect.fnUntraced(function* integrationEffect4() {
        yield* Effect.all(
          handlers.map(
            Effect.fnUntraced(function* runIntegration5({ dispose }) {
              return yield* Effect.tryPromise(() => dispose());
            }),
          ),
        );
        yield* Effect.tryPromise(() => rm(generatedFixtureRoot, { force: true, recursive: true }));
        yield* cleanup();
      }, Effect.orDie),
    );
    yield* cleanup();
    const betterAuthUserId = yield* authentication.createFixtureUser(email, 'Runtime fixture', password);
    yield* coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Authentication runtime tenant',
      slug: 'authentication-runtime-tenant',
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Foreign authentication runtime tenant',
      slug: 'foreign-authentication-runtime-tenant',
      status: 'active',
      tenantId: foreignTenantId,
    });
    yield* coreDatabase.insert(principals).values({
      displayName: 'Runtime fixture',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(legalEntities).values({
      legalEntityId: fixtureLegalEntityId,
      legalName: 'Fixture legal entity',
      registrationCountry: 'CZ',
      registrationNumber: 'AUTH-RUNTIME-1',
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principalAuthBindings).values({
      authenticationNamespaceId: staffAuthenticationNamespaceId,
      principalAuthBindingId: fixtureAuthBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    yield* coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'testing.one', state: 'active', tenantId },
      { moduleKey: 'testing.pages', state: 'active', tenantId },
      { moduleKey: 'stale-non-installed', state: 'active', tenantId },
      { moduleKey: 'inactive-installed', state: 'suspended', tenantId },
      { moduleKey: 'testing.one', state: 'active', tenantId: foreignTenantId },
    ]);
    const testRevision = (yield* installedSnapshot(['testing.one'])).composition.revision;
    const requestHeaders = new Headers({
      origin: configuration.baseUrl,
    });
    const invalid = yield* Effect.flip(authentication.signIn(email, 'wrong-password', requestHeaders));
    expect(Predicate.isTagged(invalid, 'InvalidCredentialsError')).toBe(true);
    const anonymousRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    );
    const unavailableHandler = anonymousRuntime.createHandler();
    handlers.push(unavailableHandler);
    const anonymousGatewayResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: {
            'content-type': 'application/json',
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(anonymousGatewayResponse.status).toBe(401);
    expect(headerValue(anonymousGatewayResponse.headers, 'www-authenticate')).toMatch(/^Bearer/u);
    const anonymousModulesResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: { origin: configuration.baseUrl },
        }),
      ),
    );
    expect(anonymousModulesResponse.status).toBe(401);
    expect(headerValue(anonymousModulesResponse.headers, 'www-authenticate')).toMatch(/^Bearer/u);
    const anonymousPageResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/shell/module-target`, {
          body: JSON.stringify({
            compositionRevision: testRevision,
            entrypointKey: 'testing.pages.page.customers',
            moduleId: 'testing.pages',
          }),
          headers: {
            'content-type': 'application/json',
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(anonymousPageResponse.status).toBe(401);
    expect(headerValue(anonymousPageResponse.headers, 'www-authenticate')).toMatch(/^Bearer/u);
    const invalidSignInResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/sign-in`, {
          body: JSON.stringify({ email, password: 'wrong-password' }),
          headers: {
            'content-type': 'application/json',
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(invalidSignInResponse.status).toBe(401);
    expect(headerValue(invalidSignInResponse.headers, 'content-type')).toMatch(/^application\/problem\+json/u);
    const invalidSignInProblem = Schema.decodeUnknownSync(ProblemStatusSchema)(
      yield* Effect.tryPromise(() => invalidSignInResponse.json()),
    );
    expect(invalidSignInProblem.status).toBe(401);
    const signInResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/sign-in`, {
          body: JSON.stringify({ email, password }),
          headers: {
            'content-type': 'application/json',
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(signInResponse.status).toBe(200);
    const signedIn = Schema.decodeUnknownSync(IdentityResponseSchema)(
      yield* Effect.tryPromise(() => signInResponse.json()),
    );
    const signedInCookies = signInResponse.headers.getSetCookie();
    expect(signedIn.identity.email).toBe(email);
    expect(signedIn.identity.principalId).toBe(principalId);
    expect(signedInCookies.length > 0).toBe(true);
    const authenticatedHeaders = new Headers({
      cookie: cookieHeader(signedInCookies),
      origin: configuration.baseUrl,
    });
    const apiKeys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
    );
    const issuedKey = yield* apiKeys.issue(authenticatedHeaders, {
      issuerPrincipalId: principalId,
      lifecycleOperationId: globalThis.crypto.randomUUID(),
      name: 'secure-session-issuance',
      tenantId,
    });
    yield* Effect.addFinalizer(() =>
      authDatabase.delete(apikey).where(eq(apikey.id, issuedKey.providerKeyId)).pipe(Effect.orDie),
    );
    expect(signedInCookies.some((cookie) => cookie.startsWith('__Secure-better-auth.session_token='))).toBe(true);
    expect((yield* apiKeys.verify(Redacted.value(issuedKey.secret))).providerKeyId).toBe(issuedKey.providerKeyId);
    yield* apiKeys.setEnabled(issuedKey.providerKeyId, false);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(apiKeys.verify(Redacted.value(issuedKey.secret))),
        'ApiKeyCredentialInvalidError',
      ),
    ).toBe(true);
    const approvedPageCatalog = yield* installedPageCatalog();
    const exactPageRequest = (entrypointKey = 'testing.pages.page.customers') =>
      new Request(`${configuration.baseUrl}/shell/module-target`, {
        body: JSON.stringify({
          compositionRevision: approvedPageCatalog.composition.revision,
          entrypointKey,
          moduleId: 'testing.pages',
        }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: headerValue(authenticatedHeaders, 'cookie'),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      });
    const current = yield* authentication
      .currentSession(authenticatedHeaders)
      .pipe(Effect.provide(authenticationContextLayer));
    assertOptionalField(current.identity, 'tenantId', tenantId);
    expect(current.identity).not.toBe(undefined);
    let moduleResourcePermissionCalls = 0;
    let providerCalls = 0;
    let authenticationContextCalls = 0;
    const observedAuthenticationLayer = Layer.succeed(AuthenticationService, {
      ...authentication,
      resolveShellContext: (headers) => {
        authenticationContextCalls += 1;
        return authentication.resolveShellContext(headers);
      },
    });
    const observedContextAccessLayer = Layer.mergeAll(
      Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
      Layer.succeed(ContextAccess, {
        ...legalEntitySelectionOptions.contextAccess,
        modules: (input) => {
          moduleResourcePermissionCalls += 1;
          return legalEntitySelectionOptions.contextAccess.modules(input);
        },
        resources: () => {
          moduleResourcePermissionCalls += 1;
          return legalEntitySelectionOptions.contextAccess.resources();
        },
      }),
    );
    const unavailableObservedProvider = () => {
      providerCalls += 1;
      return Effect.fail(new ShellProviderUnavailableError());
    };
    const pageRuntime = makeShellAuthenticationApiRuntime(
      observedAuthenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000009'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      Effect.succeed(approvedPageCatalog),
      false,
      observedContextAccessLayer,
      {
        resource: { detail: unavailableObservedProvider, timeline: unavailableObservedProvider },
        search: { search: unavailableObservedProvider },
      },
    ).createHandler();
    handlers.push(pageRuntime);
    const exactPageResponse = yield* Effect.tryPromise(() => pageRuntime.handler(exactPageRequest()));
    expect(exactPageResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => exactPageResponse.json())).toEqual({
      appId: 'inventory-stock',
      componentKey: 'testing.pages.page-customers',
      compositionRevision: approvedPageCatalog.composition.revision,
      entrypointKey: 'testing.pages.page.customers',
      federation: {
        expose: './PageCustomers',
        manifest:
          approvedPageCatalog.composition.modules[0]?.federation.execution === 'browser'
            ? approvedPageCatalog.composition.modules[0].federation.manifest
            : undefined,
        remoteName: 'verticalInventoryStock',
      },
      moduleId: 'testing.pages',
      routeParameters: {},
      writable: true,
    });
    const permissionCallsBeforeStaleRequests = moduleResourcePermissionCalls;
    const staleRevision = 'f'.repeat(64);
    const staleRef = {
      compositionRevision: staleRevision,
      moduleId: 'testing.pages',
      resourceId: fixtureLegalEntityId,
      resourceType: 'testing.pages.customer',
    };
    const staleRequests = [
      new Request(`${configuration.baseUrl}/shell/composition?compositionRevision=${staleRevision}`, {
        headers: authenticatedHeaders,
      }),
      ...[
        {
          path: '/shell/module-target',
          payload: { compositionRevision: staleRevision, moduleId: 'testing.pages' },
        },
        { path: '/shell/search', payload: { compositionRevision: staleRevision, query: 'customer' } },
        { path: '/shell/resource', payload: staleRef },
        { path: '/shell/resource/media-attachment', payload: staleRef },
      ].map(
        ({ path: requestPath, payload }) =>
          new Request(`${configuration.baseUrl}${requestPath}`, {
            body: JSON.stringify(payload),
            headers: new Headers({
              'content-type': 'application/json',
              cookie: headerValue(authenticatedHeaders, 'cookie'),
              origin: configuration.baseUrl,
            }),
            method: 'POST',
          }),
      ),
    ];
    for (const staleRequest of staleRequests) {
      const staleResponse = yield* Effect.tryPromise(() => pageRuntime.handler(staleRequest));
      expect(staleResponse.status).toBe(409);
      expect(
        Schema.decodeUnknownSync(ProblemStatusSchema)(yield* Effect.tryPromise(() => staleResponse.json())).status,
      ).toBe(409);
    }
    expect(moduleResourcePermissionCalls).toBe(permissionCallsBeforeStaleRequests);
    expect(providerCalls).toBe(0);
    const contextCallsBeforeStaleGatewayRequests = authenticationContextCalls;
    for (const gatewayPath of ['/auth/gateway-context', '/auth/api-key/gateway-context']) {
      const staleGatewayResponse = yield* Effect.tryPromise(() =>
        pageRuntime.handler(
          new Request(`${configuration.baseUrl}${gatewayPath}`, {
            body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: staleRevision }),
            headers: new Headers({
              'content-type': 'application/json',
              cookie: headerValue(authenticatedHeaders, 'cookie'),
              origin: configuration.baseUrl,
              'x-api-key': 'must-not-be-verified-for-an-obsolete-release',
            }),
            method: 'POST',
          }),
        ),
      );
      expect(staleGatewayResponse.status).toBe(409);
      expect(yield* Effect.tryPromise(() => staleGatewayResponse.json())).toMatchObject({
        reloadRequired: true,
        status: 409,
      });
    }
    expect(authenticationContextCalls).toBe(contextCallsBeforeStaleGatewayRequests);
    expect(moduleResourcePermissionCalls).toBe(permissionCallsBeforeStaleRequests);
    expect(providerCalls).toBe(0);
    const missingPageResponse = yield* Effect.tryPromise(() =>
      pageRuntime.handler(exactPageRequest('testing.pages.page.missing')),
    );
    expect(missingPageResponse.status).toBe(404);
    const authenticatedContext = yield* authentication
      .resolveShellContext(authenticatedHeaders)
      .pipe(Effect.provide(authenticationContextLayer));
    expect(authenticatedContext.state).toBe('authenticated');
    if (authenticatedContext.state !== 'authenticated') {
      throw new Error('The exact-page boundary fixture must resolve an authenticated context');
    }
    const selectionRequiredRuntime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, {
        ...authentication,
        resolveShellContext: () =>
          Effect.succeed({
            availableLegalEntities: authenticatedContext.availableLegalEntities,
            identity: {
              displayName: authenticatedContext.identity.displayName,
              email: authenticatedContext.identity.email,
              principalId: authenticatedContext.identity.principalId,
              tenantId: authenticatedContext.identity.tenantId,
            },
            principal: authenticatedContext.principal,
            setCookieHeaders: [],
            state: 'selection_required' as const,
          }),
      }),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000010'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedPageCatalog(),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(selectionRequiredRuntime);
    const selectionRequiredPageResponse = yield* Effect.tryPromise(() =>
      selectionRequiredRuntime.handler(exactPageRequest()),
    );
    expect(selectionRequiredPageResponse.status).toBe(409);
    expect(
      Schema.decodeUnknownSync(ProblemStatusSchema)(
        yield* Effect.tryPromise(() => selectionRequiredPageResponse.json()),
      ).status,
    ).toBe(409);
    const deniedPageRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000011'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedPageCatalog(),
      false,
      Layer.mergeAll(
        Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
        Layer.succeed(ContextAccess, {
          ...legalEntitySelectionOptions.contextAccess,
          modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
            Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key }))),
        }),
      ),
    ).createHandler();
    handlers.push(deniedPageRuntime);
    const deniedPageResponse = yield* Effect.tryPromise(() => deniedPageRuntime.handler(exactPageRequest()));
    expect(deniedPageResponse.status).toBe(403);
    expect(
      Schema.decodeUnknownSync(ProblemStatusSchema)(yield* Effect.tryPromise(() => deniedPageResponse.json())).status,
    ).toBe(403);
    const currentSessionResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/session`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(currentSessionResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SessionResponseSchema)(yield* Effect.tryPromise(() => currentSessionResponse.json()))
        .identity?.principalId,
    ).toBe(principalId);
    const missingIdempotencyResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/identity/api-keys/self`, {
          body: JSON.stringify({ name: 'must-not-be-created' }),
          headers: {
            'content-type': 'application/json',
            cookie: headerValue(authenticatedHeaders, 'cookie'),
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(missingIdempotencyResponse.status).toBe(428);
    const deniedIdentityAdministrationRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000002'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      Layer.mergeAll(
        Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
        Layer.succeed(ContextAccess, {
          ...legalEntitySelectionOptions.contextAccess,
          tenants: ({
            permission,
            tenantIds,
          }: {
            readonly permission:
              | 'access'
              | 'impersonate'
              | 'manage_identity'
              | 'manage_party_identity'
              | 'manage_party_relationships'
              | 'merge_party_identity'
              | 'read_party_identity'
              | 'read_people'
              | 'review_party_identity'
              | 'select_context';
            readonly tenantIds: readonly string[];
          }) =>
            Effect.succeed(
              tenantIds.map((key) => ({
                decision: permission === 'manage_identity' ? ('denied' as const) : ('allowed' as const),
                key,
              })),
            ),
        }),
      ),
    ).createHandler();
    handlers.push(deniedIdentityAdministrationRuntime);
    const deniedIdentityAdministrationResponse = yield* Effect.tryPromise(() =>
      deniedIdentityAdministrationRuntime.handler(
        new Request(`${configuration.baseUrl}/auth/identity/principals`, {
          body: JSON.stringify({
            displayName: 'Denied managed identity',
            kind: 'service',
          }),
          headers: {
            'content-type': 'application/json',
            cookie: headerValue(authenticatedHeaders, 'cookie'),
            'idempotency-key': 'denied-managed-identity',
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(deniedIdentityAdministrationResponse.status).toBe(403);
    const [deniedIdentityInvocation] = yield* coreDatabase
      .select({
        actionInvocationId: actionInvocations.actionInvocationId,
        status: actionInvocations.status,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'denied-managed-identity'))
      .limit(1);
    assertOptionalField(deniedIdentityInvocation, 'status', 'rejected');
    if (deniedIdentityInvocation === undefined) {
      throw new Error('The denied identity Action did not persist its invocation');
    }
    const [deniedIdentityAudit] = yield* coreDatabase
      .select({
        eventType: auditEvents.eventType,
        outcomeCode: auditEvents.outcomeCode,
      })
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, deniedIdentityInvocation.actionInvocationId))
      .limit(1);
    expect(deniedIdentityAudit).toEqual({
      eventType: 'action.rejected',
      outcomeCode: 'spicedb_permission_denied',
    });
    const activeModulesResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(activeModulesResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => activeModulesResponse.json())).toEqual({
      compositionRevision: testRevision,
      deniedAppIds: [],
      gatewayAudiences: ['inventory-stock'],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const [compositionEvidence] = yield* coreDatabase
      .select({
        authBindingId: dataAccessEvents.authBindingId,
        evidencePayloadJson: dataAccessEvents.evidencePayloadJson,
        outcome: dataAccessEvents.outcome,
        outcomeCode: dataAccessEvents.outcomeCode,
        queryHash: dataAccessEvents.queryHash,
        resultCount: dataAccessEvents.resultCount,
      })
      .from(dataAccessEvents)
      .where(
        and(
          eq(dataAccessEvents.tenantId, tenantId),
          eq(dataAccessEvents.evidencePolicyKey, 'core.shell.composition.evidence.v1'),
        ),
      );
    expect(compositionEvidence).toEqual({
      authBindingId: fixtureAuthBindingId,
      evidencePayloadJson: null,
      outcome: 'allowed',
      outcomeCode: 'read_allowed',
      queryHash: null,
      resultCount: 0,
    });
    // Company admission must open the Shell frame even when every module capability is denied.
    const zeroRoleModuleChecks: string[] = [];
    const zeroRoleContextAccess = {
      ...legalEntitySelectionOptions.contextAccess,
      legalEntities: ({
        legalEntityIds,
        permission,
      }: Parameters<(typeof ContextAccess)['Service']['legalEntities']>[0]) =>
        Effect.succeed(
          legalEntityIds.map((key) => ({
            decision: permission === undefined || permission === 'access' ? ('allowed' as const) : ('denied' as const),
            key,
          })),
        ),
      modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) => {
        zeroRoleModuleChecks.push(...moduleIds);
        return Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key })));
      },
      tenants: ({ permission, tenantIds }: Parameters<(typeof ContextAccess)['Service']['tenants']>[0]) =>
        Effect.succeed(
          tenantIds.map((key) => ({
            decision: permission === 'access' ? ('allowed' as const) : ('denied' as const),
            key,
          })),
        ),
    };
    const zeroRoleRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000003'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      Layer.mergeAll(
        Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
        Layer.succeed(ContextAccess, zeroRoleContextAccess),
      ),
    ).createHandler();
    handlers.push(zeroRoleRuntime);
    const zeroRoleDocumentResponse = yield* Effect.tryPromise(() =>
      zeroRoleRuntime.handler(
        new Request(`${configuration.baseUrl}/shell/document-context`, {
          body: JSON.stringify({ home: true }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: headerValue(authenticatedHeaders, 'cookie'),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(zeroRoleDocumentResponse.status).toBe(200);
    const zeroRoleDocument = yield* Schema.decodeUnknownEffect(ShellDocumentContextSchema)(
      yield* Effect.tryPromise(() => zeroRoleDocumentResponse.json()),
    );
    expect(zeroRoleDocument.session).toMatchObject({
      identity: { legalEntityId: fixtureLegalEntityId },
      state: 'authenticated',
    });
    expect(zeroRoleDocument.composition).toEqual({
      compositionRevision: testRevision,
      deniedAppIds: ['inventory-stock'],
      gatewayAudiences: [],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    expect(zeroRoleDocument.home?.contribution).toEqual({ state: 'forbidden' });
    expect(zeroRoleDocument.canManagePeople).toBe(false);
    expect(zeroRoleDocument.legalEntities).toMatchObject({
      legalEntities: [{ legalEntityId: fixtureLegalEntityId }],
      selectedLegalEntityId: fixtureLegalEntityId,
      state: 'authenticated',
    });
    expect(zeroRoleModuleChecks).toContain('testing.one');
    expect(zeroRoleModuleChecks).not.toContain('core.shell');
    const refreshingRuntime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, {
        ...authentication,
        currentSession: () =>
          Effect.succeed({
            identity: current.identity,
            setCookieHeaders: ['refreshed-session=value; Path=/; HttpOnly'],
          }),
        resolveShellContext: () =>
          current.identity === null
            ? Effect.succeed({
                setCookieHeaders: ['refreshed-session=value; Path=/; HttpOnly'],
                state: 'anonymous' as const,
              })
            : Effect.succeed({
                availableLegalEntities: [
                  {
                    legalEntityId: fixtureLegalEntityId,
                    legalName: 'Fixture legal entity',
                  },
                ],
                identity: {
                  ...current.identity,
                  legalEntityId: fixtureLegalEntityId,
                  legalName: 'Fixture legal entity',
                },
                principal: Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
                  authBindingId: '45000000-0000-4000-8000-000000000001',
                  authContextRef: 'better-auth-session:45000000-0000-4000-8000-000000000001',
                  authenticationNamespaceId: staffAuthenticationNamespaceId,
                  authMethod: 'session',
                  legalEntityId: fixtureLegalEntityId,
                  principalId: current.identity.principalId,
                  tenantId: current.identity.tenantId,
                }),
                setCookieHeaders: ['refreshed-session=value; Path=/; HttpOnly'],
                state: 'authenticated' as const,
              }),
      }),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(refreshingRuntime);
    const refreshedModulesResponse = yield* Effect.tryPromise(() =>
      refreshingRuntime.handler(new Request(`${configuration.baseUrl}/shell/composition`)),
    );
    expect(refreshedModulesResponse.status).toBe(200);
    expect(
      refreshedModulesResponse.headers.getSetCookie().some((header) => header.startsWith('refreshed-session=value')),
    ).toBe(true);
    const unavailableModuleStates = {
      getTenantModuleStates: () =>
        Effect.fail(
          new TenantModuleStateReadUnavailableError({
            code: 'tenant_module_state_read_unavailable',
            reason: `secret SQL failure for ${tenantId}`,
          }),
        ),
      listActiveTenantModules: () =>
        Effect.fail(
          new TenantModuleStateReadUnavailableError({
            code: 'tenant_module_state_read_unavailable',
            reason: `secret SQL failure for ${tenantId}`,
          }),
        ),
      listTenantModuleStates: () =>
        Effect.fail(
          new TenantModuleStateReadUnavailableError({
            code: 'tenant_module_state_read_unavailable',
            reason: `secret SQL failure for ${tenantId}`,
          }),
        ),
    };
    const unavailableModulesHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAdmission: installedAdmission(['testing.one']),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      Layer.succeed(TenantModuleStateService, unavailableModuleStates),
      installedPageCatalog(),
      false,
      contextAccessLayer,
      undefined,
      () => unavailableModuleStates,
    ).createHandler();
    handlers.push(unavailableModulesHandler);
    const unavailableModulesResponse = yield* Effect.tryPromise(() =>
      unavailableModulesHandler.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(unavailableModulesResponse.status).toBe(503);
    const unavailableModulesProblem = yield* Effect.tryPromise(() => unavailableModulesResponse.text());
    expect(unavailableModulesProblem).not.toMatch(/SQL|30000000|40000000/u);
    const unavailablePageResponse = yield* Effect.tryPromise(() =>
      unavailableModulesHandler.handler(exactPageRequest()),
    );
    expect(unavailablePageResponse.status).toBe(503);
    expect(
      Schema.decodeUnknownSync(ProblemStatusSchema)(yield* Effect.tryPromise(() => unavailablePageResponse.json()))
        .status,
    ).toBe(503);
    const unavailableGatewayResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(unavailableGatewayResponse.status).toBe(503);
    expect(headerValue(unavailableGatewayResponse.headers, 'content-type')).toMatch(/application\/problem\+json/u);
    expect(
      Schema.decodeUnknownSync(RetryableProblemSchema)(
        yield* Effect.tryPromise(() => unavailableGatewayResponse.json()),
      ).retryable,
    ).toBe(true);
    const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
    const privateJwk = yield* Effect.tryPromise(() => exportJWK(pair.privateKey));
    const publicJwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
    const issuerDependencies: GatewayIssuerLayerOptions = {
      currentTimeSeconds: Effect.succeed(1_700_000_000),
      generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
      loadAdmission: installedAdmission(['testing.one']),
      loadConfig: Effect.succeed({
        issuer: 'https://shell.example.test',
        privateJwk: {
          alg: 'EdDSA',
          crv: 'Ed25519',
          d: optionalText(privateJwk.d),
          kid: 'integration-current',
          kty: 'OKP',
          use: 'sig',
          x: optionalText(privateJwk.x),
        },
      }),
    };
    const issuingHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer(issuerDependencies).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(issuingHandler);
    // Native Better Auth and PostgreSQL own the selected scope. Graph semantics are
    // covered separately against real SpiceDB; these decisions exercise session transitions.
    const tenantSwitch = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/context/tenant`, {
          headers: authenticatedHeaders,
          method: 'POST',
        }),
      ),
    );
    expect(tenantSwitch.status).toBe(200);
    expect(yield* Effect.tryPromise(() => tenantSwitch.json())).toEqual({ selectedContext: 'tenant' });
    const persistedTenantScope = yield* authDatabase
      .select({
        activeContextKind: session.activeContextKind,
        activeLegalEntityId: session.activeLegalEntityId,
        activeTenantId: session.activeTenantId,
      })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    expect(persistedTenantScope).toEqual([
      {
        activeContextKind: 'tenant',
        activeLegalEntityId: null,
        activeTenantId: tenantId,
      },
    ]);
    let selectionAllowed = true;
    let selectionChecks = 0;
    const selectedScopeLayer = Layer.mergeAll(
      Layer.succeed(LegalEntityContext, legalEntitySelectionOptions.legalEntityContext),
      Layer.succeed(ContextAccess, {
        ...legalEntitySelectionOptions.contextAccess,
        tenants: ({
          permission,
          principalId: checkedPrincipal,
          tenantIds,
        }: {
          readonly permission: string;
          readonly principalId: string;
          readonly tenantIds: readonly string[];
        }) =>
          Effect.sync(() => {
            expect(permission).toBe('select_context');
            expect(checkedPrincipal).toBe(principalId);
            expect(tenantIds).toEqual([tenantId]);
            selectionChecks += 1;
            return tenantIds.map((key) => ({
              decision: selectionAllowed ? ('allowed' as const) : ('denied' as const),
              key,
            }));
          }),
      }),
    );
    for (let reload = 0; reload < 2; reload += 1) {
      const selected = yield* authentication
        .resolveShellContext(authenticatedHeaders)
        .pipe(Effect.provide(selectedScopeLayer));
      expect(selected.state).toBe('tenant_authenticated');
      if (selected.state === 'tenant_authenticated') {
        expect(selected.principal.tenantId).toBe(tenantId);
        expect(selected.principal.legalEntityId).toBeUndefined();
      }
    }
    expect(selectionChecks).toBe(2);
    const tenantGateway = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: {
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(tenantGateway.status).toBe(200);
    const tenantAssertion = yield* verifiedGatewayAssertion(tenantGateway, pair.publicKey, testRevision);
    expect(tenantAssertion.principal.tenantId).toBe(tenantId);
    expect(tenantAssertion.principal.legalEntityId).toBeUndefined();
    const companyFromTenantScope = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({
            audience: 'inventory-stock',
            compositionRevision: testRevision,
            legalEntityId: fixtureLegalEntityId,
          }),
          headers: {
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          },
          method: 'POST',
        }),
      ),
    );
    expect(companyFromTenantScope.status).toBe(403);
    selectionAllowed = false;
    const revoked = yield* authentication
      .resolveShellContext(authenticatedHeaders)
      .pipe(Effect.provide(selectedScopeLayer));
    expect(revoked.state).toBe('access_blocked');
    expect(selectionChecks).toBe(3);
    const deniedSelection = yield* authentication
      .switchToTenantContext(authenticatedHeaders)
      .pipe(Effect.provide(selectedScopeLayer), Effect.flip);
    expect(Predicate.isTagged(deniedSelection, 'TenantAccessForbiddenError')).toBe(true);
    yield* authentication
      .switchLegalEntity(fixtureLegalEntityId, authenticatedHeaders)
      .pipe(Effect.provide(authenticationContextLayer));
    const restoredCompanyScope = yield* authDatabase
      .select({
        activeContextKind: session.activeContextKind,
        activeLegalEntityId: session.activeLegalEntityId,
      })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    expect(restoredCompanyScope).toEqual([{ activeContextKind: 'company', activeLegalEntityId: fixtureLegalEntityId }]);
    const assertionResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(assertionResponse.status, yield* Effect.tryPromise(() => assertionResponse.clone().text())).toBe(200);
    expect(headerValue(assertionResponse.headers, 'cache-control')).toBe('no-store');
    const { principal: verifiedPrincipal, token: assertionToken } = yield* verifiedGatewayAssertion(
      assertionResponse,
      pair.publicKey,
      testRevision,
    );
    expect(verifiedPrincipal.authBindingId).toBe(fixtureAuthBindingId);
    expect(optionalText(verifiedPrincipal.authContextRef)).toMatch(/^better-auth-session:/u);
    expect(verifiedPrincipal.authMethod).toBe('session');
    expect(verifiedPrincipal.legalEntityId).toBe(fixtureLegalEntityId);
    expect(verifiedPrincipal.principalId).toBe(principalId);
    expect(verifiedPrincipal.tenantId).toBe(tenantId);
    // The document batch issues the same session assertion per admitted audience and leaves out the rest.
    const documentBatchResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-contexts`, {
          body: JSON.stringify({ audiences: ['inventory-stock', 'not-admitted'], compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(documentBatchResponse.status).toBe(200);
    expect(headerValue(documentBatchResponse.headers, 'cache-control')).toBe('no-store');
    const documentBatch = Schema.decodeUnknownSync(
      Schema.Struct({ assertions: Schema.Array(Schema.Struct({ audience: Schema.String })) }),
    )(yield* Effect.tryPromise(() => documentBatchResponse.clone().json()));
    expect(documentBatch.assertions.map(({ audience }) => audience)).toEqual(['inventory-stock']);
    const [batchAssertion] = Schema.decodeUnknownSync(Schema.Struct({ assertions: Schema.Array(Schema.Unknown) }))(
      yield* Effect.tryPromise(() => documentBatchResponse.json()),
    ).assertions;
    const { principal: batchPrincipal } = yield* verifiedGatewayAssertion(
      Response.json(batchAssertion),
      pair.publicKey,
      testRevision,
    );
    expect(batchPrincipal).toEqual(verifiedPrincipal);
    const anonymousBatchResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-contexts`, {
          body: JSON.stringify({ audiences: ['inventory-stock'], compositionRevision: testRevision }),
          headers: new Headers({ 'content-type': 'application/json', origin: configuration.baseUrl }),
          method: 'POST',
        }),
      ),
    );
    expect(anonymousBatchResponse.status).toBe(401);
    expect(headerValue(anonymousBatchResponse.headers, 'cache-control')).toBe('no-store');
    yield* Effect.tryPromise(() =>
      mkdir(path.join(generatedFixtureRoot, 'node_modules', '@app'), {
        recursive: true,
      }),
    );
    yield* Effect.tryPromise(() =>
      symlink(
        path.join(appRoot, 'packages/core-runtime'),
        path.join(generatedFixtureRoot, 'node_modules/@app/core-runtime'),
        'dir',
      ),
    );
    yield* Effect.tryPromise(() =>
      symlink(
        path.join(appRoot, 'packages/shared-contracts'),
        path.join(generatedFixtureRoot, 'node_modules/@app/shared-contracts'),
        'dir',
      ),
    );
    yield* Effect.tryPromise(() =>
      symlink(
        path.join(appRoot, 'packages/gateway-principal-verifier'),
        path.join(generatedFixtureRoot, 'node_modules/@app/gateway-principal-verifier'),
        'dir',
      ),
    );
    yield* Effect.tryPromise(() =>
      symlink(path.join(appRoot, 'node_modules/effect'), path.join(generatedFixtureRoot, 'node_modules/effect'), 'dir'),
    );
    yield* Effect.tryPromise(() =>
      symlink(
        path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
        path.join(generatedFixtureRoot, 'node_modules/jose'),
        'dir',
      ),
    );
    yield* Effect.tryPromise(() => mkdir(path.join(generatedFixtureRoot, 'api', 'auth'), { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(path.join(generatedFixtureRoot, 'shared'), { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(generatedFixtureRoot, 'shared/ultramodern-build.ts'),
        "export const ultramodernApiMarker = { appId: 'inventory-stock', buildMarker: 'integration-build' } as const;\n",
        'utf-8',
      ),
    );
    const generatedVerifierPath = path.join(generatedFixtureRoot, 'api', 'auth', 'action-principal.ts');
    yield* Effect.tryPromise(() =>
      writeFile(generatedVerifierPath, renderActionPrincipalServer({ appId: 'inventory-stock' }), 'utf-8'),
    );
    const generatedVerifier = yield* Effect.tryPromise(() => import(pathToFileURL(generatedVerifierPath).href));
    type GeneratedVerifier = (
      authorization: string,
      options: {
        readonly currentTimeSeconds: Effect.Effect<number>;
        readonly environment: Readonly<Record<string, string>>;
        readonly redemption: {
          readonly consume: () => Effect.Effect<void>;
        };
      },
    ) => Effect.Effect<typeof TrustedPrincipalContextSchema.Type, unknown>;
    const verifyActionPrincipal = Schema.decodeUnknownSync(
      Schema.declare<GeneratedVerifier>((value): value is GeneratedVerifier => Predicate.isFunction(value)),
    )(generatedVerifier.verifyActionPrincipal);
    expect(Predicate.isFunction(verifyActionPrincipal)).toBe(true);
    const generatedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
      yield* verifyActionPrincipal(`Bearer ${assertionToken}`, {
        currentTimeSeconds: Effect.succeed(1_700_000_001),
        environment: {
          ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
            keys: [
              {
                ...publicJwk,
                alg: 'EdDSA',
                kid: 'integration-current',
                use: 'sig',
              },
            ],
          }),
        },
        redemption: { consume: () => Effect.void },
      }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: installedSnapshot(['testing.one']) })),
    );
    expect(generatedPrincipal.authBindingId).toBe(fixtureAuthBindingId);
    expect(optionalText(generatedPrincipal.authContextRef)).toMatch(/^better-auth-session:/u);
    expect(generatedPrincipal.authMethod).toBe('session');
    expect(generatedPrincipal.legalEntityId).toBe(fixtureLegalEntityId);
    expect(generatedPrincipal.principalId).toBe(principalId);
    expect(generatedPrincipal.tenantId).toBe(tenantId);
    const databaseConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const scopeGrantAdminClient = yield* makeTestPgClient(databaseConnections.admin.connectionString);
    // The grant function checks expiry against the database clock, so the issuer reads the same clock.
    const databaseNowSeconds = scopeGrantAdminClient<{
      readonly now: number;
    }>`select floor(extract(epoch from clock_timestamp()))::int as now`.pipe(
      Effect.map(([row]) => row?.now ?? 0),
      Effect.orDie,
    );
    const partyRegistryIssuingHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        ...issuerDependencies,
        currentTimeSeconds: databaseNowSeconds,
        generateJti: Effect.sync(() => randomUUID()),
        loadAdmission: Effect.succeed({
          audiences: new Map([['party-registry', 'integration-build']]),
          revision: testRevision,
        }),
      }).pipe(
        Layer.provide(
          GatewayScopeGrantRegistrarLive.pipe(
            Layer.provide(makeDatabaseIdentityEnrollmentLive(FIXTURE_DATABASE_IDENTITY_ENROLLMENT)),
          ),
        ),
      ),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(partyRegistryIssuingHandler);
    const partyRegistryAssertionResponse = yield* Effect.tryPromise(() =>
      partyRegistryIssuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'party-registry', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(
      partyRegistryAssertionResponse.status,
      yield* Effect.tryPromise(() => partyRegistryAssertionResponse.clone().text()),
    ).toBe(200);
    const partyRegistryAssertion = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(
      yield* Effect.tryPromise(() => partyRegistryAssertionResponse.json()),
    );
    const partyRegistryClaims = yield* Effect.tryPromise(() =>
      jwtVerify(partyRegistryAssertion.token, pair.publicKey, {
        algorithms: ['EdDSA'],
        audience: 'party-registry',
        issuer: 'https://shell.example.test',
      }),
    );
    yield* Effect.acquireRelease(Effect.void, () =>
      scopeGrantAdminClient`delete from trust.gateway_scope_grants where assertion_digest = sha256(convert_to(${partyRegistryAssertion.token}, 'UTF8'))`.pipe(
        Effect.orDie,
      ),
    );
    const scopeGrantRows = yield* scopeGrantAdminClient<{
      readonly audience: string;
      readonly expiresAt: number;
      readonly jti: string;
      readonly legalEntityId: string | null;
      readonly principalId: string;
      readonly registeredBy: string;
      readonly tenantId: string;
    }>`select audience, jti::text as jti, principal_id::text as "principalId", tenant_id::text as "tenantId", legal_entity_id::text as "legalEntityId", extract(epoch from expires_at)::bigint::int as "expiresAt", registered_by as "registeredBy" from trust.gateway_scope_grants where assertion_digest = sha256(convert_to(${partyRegistryAssertion.token}, 'UTF8'))`;
    expect(scopeGrantRows).toEqual([
      {
        audience: 'party-registry',
        expiresAt: partyRegistryClaims.payload.exp,
        jti: partyRegistryClaims.payload.jti,
        legalEntityId: fixtureLegalEntityId,
        principalId,
        registeredBy: 'shell_gateway_issuer',
        tenantId,
      },
    ]);
    const invalidAudienceResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'billing', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    expect(invalidAudienceResponse.status).toBe(400);
    const defectHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        ...issuerDependencies,
        generateJti: Effect.die(new Error('deliberate gateway test defect')),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(defectHandler);
    const defectResponse = yield* Effect.tryPromise(() =>
      defectHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: cookieHeader(signedInCookies),
            origin: configuration.baseUrl,
            'x-correlation-id': 'integration-correlation-id',
          }),
          method: 'POST',
        }),
      ),
    );
    expect(defectResponse.status).toBe(500);
    expect(headerValue(defectResponse.headers, 'content-type')).toMatch(/application\/problem\+json/u);
    const defectProblem = Schema.decodeUnknownSync(DefectProblemSchema)(
      yield* Effect.tryPromise(() => defectResponse.json()),
    );
    expect(defectProblem.detail).toBe('Gateway authentication could not complete.');
    expect(JSON.stringify(defectProblem)).not.toMatch(/deliberate gateway test defect/u);
    const stillAuthenticated = yield* authentication
      .currentSession(authenticatedHeaders)
      .pipe(Effect.provide(authenticationContextLayer));
    assertOptionalField(stillAuthenticated.identity, 'principalId', principalId);
    yield* coreDatabase
      .update(principalAuthBindings)
      .set({
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
        status: 'revoked',
      })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    yield* assertSessionForbidden(
      authentication.currentSession(authenticatedHeaders).pipe(Effect.provide(authenticationContextLayer)),
    );
    const forbiddenModulesResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(forbiddenModulesResponse.status).toBe(401);
    expect(headerValue(forbiddenModulesResponse.headers, 'www-authenticate')).toMatch(/^Bearer/u);
    expect(yield* Effect.tryPromise(() => forbiddenModulesResponse.text())).not.toMatch(/30000000|40000000/u);
    yield* coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const signOutResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/sign-out`, {
          headers: authenticatedHeaders,
          method: 'POST',
        }),
      ),
    );
    expect(signOutResponse.status).toBe(200);
    const signedOutCookies = signOutResponse.headers.getSetCookie();
    expect(signedOutCookies.length >= 3).toBe(true);
    expect(signedOutCookies.every((header) => !header.includes(password))).toBe(true);
    const anonymous = yield* authentication
      .currentSession(
        new Headers({
          cookie: cookieHeader(signedOutCookies),
          origin: configuration.baseUrl,
        }),
      )
      .pipe(Effect.provide(authenticationContextLayer));
    expect(anonymous.identity).toBe(null);
    const expiredModulesResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(expiredModulesResponse.status).toBe(401);
    expect(yield* Effect.tryPromise(() => expiredModulesResponse.text())).not.toMatch(/30000000|40000000/u);
  }),
);
it.live(
  'selects, lists, switches, revalidates, and upgrades a multi-tenant session',
  Effect.fnUntraced(function* runIntegration6() {
    const multiEmail = 'better-auth-multi-tenant@example.test';
    const firstTenantId = '31000000-0000-4000-8000-000000000001';
    const secondTenantId = '31000000-0000-4000-8000-000000000002';
    const firstPrincipalId = '41000000-0000-4000-8000-000000000001';
    const secondPrincipalId = '41000000-0000-4000-8000-000000000002';
    const firstLegalEntityId = '36000000-0000-4000-8000-000000000001';
    const secondLegalEntityId = '36000000-0000-4000-8000-000000000002';
    const firstAuthBindingId = '46000000-0000-4000-8000-000000000001';
    const secondAuthBindingId = '46000000-0000-4000-8000-000000000002';
    const legalEntityByTenant = new Map([
      [firstTenantId, { legalEntityId: firstLegalEntityId, legalName: 'First legal entity' }],
      [
        secondTenantId,
        {
          legalEntityId: secondLegalEntityId,
          legalName: 'Second legal entity',
        },
      ],
    ]);
    const multiLegalEntitySelectionOptions = {
      contextAccess: legalEntitySelectionOptions.contextAccess,
      legalEntityContext: {
        listActiveForTenant: (selectedTenantId: string) =>
          Effect.succeed(legalEntityByTenant.get(selectedTenantId)).pipe(
            Effect.map((selected) => (selected === undefined ? [] : [selected])),
          ),
        validateSelection: (selectedTenantId: string, legalEntityId: string) => {
          const selected = legalEntityByTenant.get(selectedTenantId);
          return selected?.legalEntityId === legalEntityId
            ? Effect.succeed(selected)
            : Effect.die('missing multi-tenant fixture legal entity');
        },
      },
    } as const;
    const multiContextAccessLayer = Layer.mergeAll(
      Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
      Layer.succeed(ContextAccess, multiLegalEntitySelectionOptions.contextAccess),
    );
    const multiAuthenticationContextLayer = Layer.mergeAll(
      multiContextAccessLayer,
      Layer.succeed(LegalEntityContext, multiLegalEntitySelectionOptions.legalEntityContext),
    );
    const configuration = yield* loadAuthConfig({ envPath: '/dev/null' });
    const databaseConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const adminClient = yield* makeTestPgClient(databaseConnections.admin.connectionString);
    const coreClient = yield* makeTestPgClient(configuration.connectionString);
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const authPersistence = yield* makeAuthDatabase({
      connectionString: configuration.connectionString,
      expectedRole: SHARED_RUNTIME_IDENTITY.role,
    });
    const authDatabase = authPersistence.executor;
    const adminAuthDatabase = yield* makeTestDatabaseFromClient(adminClient, authRelations);
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: staffAuthenticationNamespaceId },
    );
    const betterAuthRuntime = Layer.succeedContext(yield* Layer.build(BetterAuthRuntimeLive));
    const oauthAuthenticationLayer = Layer.mergeAll(
      betterAuthRuntime,
      BetterAuthNativeAdapterLive,
      OAuthAuthenticationAuditLive,
      OAuthEndpointGuardDataLive,
      OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
    ).pipe(
      Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor: coreDatabase }),
          Layer.succeed(AuthDatabase, authPersistence),
        ),
      ),
    );
    const authenticationFramework = BetterAuthFrameworkLive({ allowFixtureSignUp: true }).pipe(
      Layer.provideMerge(oauthAuthenticationLayer),
    );
    const authenticationGuards = OAuthEndpointGuardsLive.pipe(Layer.provideMerge(authenticationFramework));
    const authentication = yield* makeAuthenticationService().pipe(
      Effect.provide(authenticationGuards),
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    const moduleStateLayer = Layer.succeed(
      TenantModuleStateService,
      makeTenantModuleStateService({ executor: coreDatabase }),
    );
    const handlers: AuthenticationRuntimeHandler[] = [];
    const fixtureTenants = [firstTenantId, secondTenantId];
    // Ordered child-before-parent within the owned fixture rows.
    const cleanup = Effect.fnUntraced(function* runIntegration7() {
      yield* coreDatabase.delete(dataAccessEvents).where(inArray(dataAccessEvents.tenantId, fixtureTenants));
      // The switch to a disabled principal records an authn.rejected audit event bound to its auth binding.
      yield* coreDatabase.delete(auditEvents).where(inArray(auditEvents.tenantId, fixtureTenants));
      const existingUsers = yield* authDatabase.select({ id: user.id }).from(user).where(eq(user.email, multiEmail));
      const existingUserIds = existingUsers.map(({ id }) => id);
      if (existingUserIds.length > 0) {
        yield* purgeFixtureRows([
          coreDatabase
            .delete(principalAuthBindings)
            .where(inArray(principalAuthBindings.providerSubjectId, existingUserIds)),
          authDatabase.delete(session).where(inArray(session.userId, existingUserIds)),
          authDatabase.delete(account).where(inArray(account.userId, existingUserIds)),
          authDatabase.delete(user).where(inArray(user.id, existingUserIds)),
        ]);
      }
      yield* purgeFixtureRows([
        coreDatabase.delete(tenantModuleStates).where(inArray(tenantModuleStates.tenantId, fixtureTenants)),
        coreDatabase.delete(principals).where(inArray(principals.principalId, [firstPrincipalId, secondPrincipalId])),
        coreDatabase
          .delete(legalEntities)
          .where(inArray(legalEntities.legalEntityId, [firstLegalEntityId, secondLegalEntityId])),
        coreDatabase.delete(tenants).where(inArray(tenants.tenantId, fixtureTenants)),
      ]);
    });
    yield* Effect.acquireRelease(
      Effect.void,
      Effect.fnUntraced(function* integrationEffect8() {
        yield* Effect.all(
          handlers.map(
            Effect.fnUntraced(function* runIntegration9({ dispose }) {
              return yield* Effect.tryPromise(() => dispose());
            }),
          ),
        );
        yield* cleanup();
      }, Effect.orDie),
    );
    yield* cleanup();
    const betterAuthUserId = yield* authentication.createFixtureUser(multiEmail, 'Multi tenant fixture', password);
    yield* coreDatabase.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Zeta tenant',
        slug: 'multi-zeta-tenant',
        status: 'active',
        tenantId: firstTenantId,
      },
      {
        defaultLocale: 'en',
        name: 'Alpha tenant',
        slug: 'multi-alpha-tenant',
        status: 'active',
        tenantId: secondTenantId,
      },
    ]);
    yield* coreDatabase.insert(principals).values([
      {
        displayName: 'First tenant principal',
        kind: 'human',
        principalId: firstPrincipalId,
        status: 'active',
        tenantId: firstTenantId,
      },
      {
        displayName: 'Second tenant principal',
        kind: 'human',
        principalId: secondPrincipalId,
        status: 'active',
        tenantId: secondTenantId,
      },
    ]);
    yield* coreDatabase.insert(legalEntities).values([
      {
        legalEntityId: firstLegalEntityId,
        legalName: 'First legal entity',
        registrationCountry: 'CZ',
        registrationNumber: 'AUTH-MULTI-1',
        status: 'active',
        tenantId: firstTenantId,
      },
      {
        legalEntityId: secondLegalEntityId,
        legalName: 'Second legal entity',
        registrationCountry: 'CZ',
        registrationNumber: 'AUTH-MULTI-2',
        status: 'active',
        tenantId: secondTenantId,
      },
    ]);
    yield* coreDatabase.insert(principalAuthBindings).values([
      {
        authenticationNamespaceId: staffAuthenticationNamespaceId,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        principalAuthBindingId: firstAuthBindingId,
        principalId: firstPrincipalId,
        provider: 'better_auth',
        providerSubjectId: betterAuthUserId,
        status: 'active',
        subjectType: 'user',
        tenantId: firstTenantId,
      },
      {
        authenticationNamespaceId: staffAuthenticationNamespaceId,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        principalAuthBindingId: secondAuthBindingId,
        principalId: secondPrincipalId,
        provider: 'better_auth',
        providerSubjectId: betterAuthUserId,
        status: 'active',
        subjectType: 'user',
        tenantId: secondTenantId,
      },
    ]);
    yield* coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'testing.first', state: 'active', tenantId: firstTenantId },
      { moduleKey: 'testing.second', state: 'active', tenantId: secondTenantId },
    ]);
    const signIn = yield* authentication.signIn(multiEmail, password, new Headers({ origin: configuration.baseUrl }));
    expect(signIn.identity.tenantId).toBe(firstTenantId);
    expect(signIn.identity.principalId).toBe(firstPrincipalId);
    const authenticatedCookie = cookieHeader(signIn.setCookieHeaders);
    const authenticatedHeaders = new Headers({
      cookie: authenticatedCookie,
      origin: configuration.baseUrl,
    });
    // Tenant switching varies only the target and optional correlation header.
    const tenantSwitchRequest = (target: string, extraHeaders: Record<string, string> = {}) =>
      new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
        body: JSON.stringify({ tenantId: target }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
          ...extraHeaders,
        }),
        method: 'POST',
      });
    const readActiveTenantIds = () =>
      authDatabase
        .select({ activeTenantId: session.activeTenantId })
        .from(session)
        .where(eq(session.userId, betterAuthUserId));

    const initialSessions = yield* readActiveTenantIds();
    assertOptionalField(initialSessions[0], 'activeTenantId', firstTenantId);
    const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
    const privateJwk = yield* Effect.tryPromise(() => exportJWK(pair.privateKey));
    const testRevision = (yield* installedSnapshot(['testing.first', 'testing.second'])).composition.revision;
    const runtime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, authentication),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000001'),
        loadAdmission: installedAdmission(['testing.first', 'testing.second']),
        loadConfig: Effect.succeed({
          issuer: 'https://shell.example.test',
          privateJwk: {
            alg: 'EdDSA',
            crv: 'Ed25519',
            d: optionalText(privateJwk.d),
            kid: 'multi-tenant-current',
            kty: 'OKP',
            use: 'sig',
            x: optionalText(privateJwk.x),
          },
        }),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.first', 'testing.second']),
      false,
      multiContextAccessLayer,
    ).createHandler();
    handlers.push(runtime);
    const anonymousAvailableResponse = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/auth/tenants`, {
          headers: { origin: configuration.baseUrl },
        }),
      ),
    );
    expect(anonymousAvailableResponse.status).toBe(401);
    expect(headerValue(anonymousAvailableResponse.headers, 'www-authenticate')).toMatch(/^Bearer /u);
    const availableResponse = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/auth/tenants`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(availableResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => availableResponse.json())).toEqual({
      tenants: [
        { name: 'Alpha tenant', tenantId: secondTenantId },
        { name: 'Zeta tenant', tenantId: firstTenantId },
      ],
    });
    const availableTenants = yield* authentication
      .availableTenants(authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    expect(JSON.stringify(availableTenants)).not.toMatch(/principalId|sessionId|token|bindingId|password/u);
    const firstModules = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(yield* Effect.tryPromise(() => firstModules.json())).toEqual({
      compositionRevision: testRevision,
      deniedAppIds: [],
      gatewayAudiences: ['inventory-stock', 'testing-second'],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const forbiddenResponse = yield* Effect.tryPromise(() =>
      runtime.handler(tenantSwitchRequest('31000000-0000-4000-8000-000000000099')),
    );
    expect(forbiddenResponse.status).toBe(403);
    const sessionsAfterForbiddenSwitch = yield* readActiveTenantIds();
    assertOptionalField(sessionsAfterForbiddenSwitch[0], 'activeTenantId', firstTenantId);
    yield* coreDatabase
      .update(principals)
      .set({ status: 'disabled' })
      .where(eq(principals.principalId, secondPrincipalId));
    const inactiveTargetResponse = yield* Effect.tryPromise(() => runtime.handler(tenantSwitchRequest(secondTenantId)));
    expect(inactiveTargetResponse.status).toBe(403);
    const sessionsAfterInactiveSwitch = yield* readActiveTenantIds();
    assertOptionalField(sessionsAfterInactiveSwitch[0], 'activeTenantId', firstTenantId);
    yield* coreDatabase
      .update(principals)
      .set({ status: 'active' })
      .where(eq(principals.principalId, secondPrincipalId));
    // The framework captures the same overridden resolver as the service; only ready SDK instances are shared.
    const resolverUnavailableFramework = BetterAuthFrameworkLive().pipe(Layer.provideMerge(oauthAuthenticationLayer));
    const resolverUnavailableGuards = OAuthEndpointGuardsLive.pipe(Layer.provideMerge(resolverUnavailableFramework));
    const resolverUnavailableAuthentication = yield* makeAuthenticationService().pipe(
      Effect.provide(resolverUnavailableGuards),
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, {
        ...resolver,
        resolveBetterAuthUserForTenant: (userId, selectedTenantId) =>
          selectedTenantId === secondTenantId
            ? Effect.fail(
                new PrincipalResolverUnavailableError({
                  reason: 'Injected resolver outage',
                }),
              )
            : resolver.resolveBetterAuthUserForTenant(userId, selectedTenantId),
      }),
    );
    const resolverUnavailableRuntime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, resolverUnavailableAuthentication),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000002'),
        loadAdmission: Effect.succeed({ audiences: new Map<string, string>(), revision: '0'.repeat(64) }),
        loadConfig: parseGatewayIssuerConfig({}),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
    ).createHandler();
    handlers.push(resolverUnavailableRuntime);
    const resolverUnavailableResponse = yield* Effect.tryPromise(() =>
      resolverUnavailableRuntime.handler(tenantSwitchRequest(secondTenantId)),
    );
    expect(resolverUnavailableResponse.status).toBe(503);
    const sessionsAfterResolverFailure = yield* readActiveTenantIds();
    assertOptionalField(sessionsAfterResolverFailure[0], 'activeTenantId', firstTenantId);
    // Drizzle has no query-builder failure injection. This temporary trigger raises PostgreSQL's
    // connection-failure class for the fixed test tenant through the real Better Auth adapter path.
    yield* adminAuthDatabase.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION auth.tenant_switch_test_fail_persistence()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF NEW.active_tenant_id = '31000000-0000-4000-8000-000000000002'::uuid THEN
            RAISE EXCEPTION 'injected auth persistence outage' USING ERRCODE = '08006';
          END IF;
          RETURN NEW;
        END;
        $function$
      `),
    );
    yield* adminAuthDatabase.execute(
      sql.raw(`
        CREATE TRIGGER tenant_switch_test_persistence_failure
        BEFORE UPDATE ON auth.session
        FOR EACH ROW
        EXECUTE FUNCTION auth.tenant_switch_test_fail_persistence()
      `),
    );
    yield* Effect.scoped(
      Effect.gen(function* integrationEffect10() {
        yield* Effect.acquireRelease(
          Effect.void,
          Effect.fnUntraced(function* integrationEffect11() {
            yield* adminAuthDatabase.execute(
              sql.raw(`
          DROP TRIGGER IF EXISTS tenant_switch_test_persistence_failure ON auth.session
        `),
            );
            yield* adminAuthDatabase.execute(
              sql.raw(`
          DROP FUNCTION IF EXISTS auth.tenant_switch_test_fail_persistence()
        `),
            );
          }, Effect.orDie),
        );
        const persistenceUnavailableResponse = yield* Effect.tryPromise(() =>
          runtime.handler(tenantSwitchRequest(secondTenantId)),
        );
        expect(persistenceUnavailableResponse.status).toBe(503);
        const sessionsAfterPersistenceFailure = yield* readActiveTenantIds();
        assertOptionalField(sessionsAfterPersistenceFailure[0], 'activeTenantId', firstTenantId);
      }),
    );
    const sessionsBeforeSwitch = yield* authDatabase
      .select({ activeLegalEntityId: session.activeLegalEntityId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assertOptionalField(sessionsBeforeSwitch[0], 'activeLegalEntityId', firstLegalEntityId);
    const switchResponse = yield* Effect.tryPromise(() => runtime.handler(tenantSwitchRequest(secondTenantId)));
    expect(switchResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => switchResponse.json())).toEqual({
      selectedTenantId: secondTenantId,
    });
    const sessionsAfterSwitch = yield* authDatabase
      .select({
        activeLegalEntityId: session.activeLegalEntityId,
        activeTenantId: session.activeTenantId,
      })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assertOptionalField(sessionsAfterSwitch[0], 'activeTenantId', secondTenantId);
    assertOptionalField(sessionsAfterSwitch[0], 'activeLegalEntityId', null);
    const currentSessionAfterSwitch = yield* authentication
      .currentSession(authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    assertOptionalField(currentSessionAfterSwitch.identity, 'principalId', secondPrincipalId);
    const idempotentSwitch = yield* authentication
      .switchTenant(secondTenantId, authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    expect(idempotentSwitch.selectedTenantId).toBe(secondTenantId);
    const secondModules = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/shell/composition`, {
          headers: authenticatedHeaders,
        }),
      ),
    );
    expect(yield* Effect.tryPromise(() => secondModules.json())).toEqual({
      compositionRevision: testRevision,
      deniedAppIds: [],
      gatewayAudiences: ['inventory-stock', 'testing-second'],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const assertionResponse = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: authenticatedCookie,
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    const { principal: verifiedPrincipal } = yield* verifiedGatewayAssertion(
      assertionResponse,
      pair.publicKey,
      testRevision,
    );
    expect(verifiedPrincipal.authBindingId).toBe(secondAuthBindingId);
    expect(optionalText(verifiedPrincipal.authContextRef)).toMatch(/^better-auth-session:/u);
    expect(verifiedPrincipal.authMethod).toBe('session');
    expect(verifiedPrincipal.legalEntityId).toBe(secondLegalEntityId);
    expect(verifiedPrincipal.principalId).toBe(secondPrincipalId);
    expect(verifiedPrincipal.tenantId).toBe(secondTenantId);
    // A non-unavailability persistence rejection is an unexpected defect. The real Better Auth
    // adapter must roll it back, while each owning HTTP boundary logs and returns a redacted 500.
    yield* adminAuthDatabase.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION auth.tenant_switch_test_fail_internal_persistence()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF NEW.active_tenant_id = '31000000-0000-4000-8000-000000000001'::uuid THEN
            RAISE EXCEPTION 'secret auth persistence defect' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $function$
      `),
    );
    yield* adminAuthDatabase.execute(
      sql.raw(`
        CREATE TRIGGER tenant_switch_test_internal_persistence_failure
        BEFORE UPDATE ON auth.session
        FOR EACH ROW
        EXECUTE FUNCTION auth.tenant_switch_test_fail_internal_persistence()
      `),
    );
    yield* Effect.scoped(
      Effect.gen(function* integrationEffect12() {
        yield* Effect.acquireRelease(
          Effect.void,
          Effect.fnUntraced(function* integrationEffect13() {
            yield* adminAuthDatabase.execute(
              sql.raw(`
          DROP TRIGGER IF EXISTS tenant_switch_test_internal_persistence_failure ON auth.session
        `),
            );
            yield* adminAuthDatabase.execute(
              sql.raw(`
          DROP FUNCTION IF EXISTS auth.tenant_switch_test_fail_internal_persistence()
        `),
            );
          }, Effect.orDie),
        );
        const unexpectedSwitchResponse = yield* Effect.tryPromise(() =>
          runtime.handler(
            tenantSwitchRequest(firstTenantId, {
              'x-correlation-id': 'unexpected-switch-persistence-test',
            }),
          ),
        );
        expect(unexpectedSwitchResponse.status).toBe(500);
        expect(yield* Effect.tryPromise(() => unexpectedSwitchResponse.text())).not.toMatch(
          /secret auth persistence defect|P0001/u,
        );
        const sessionsAfterUnexpectedSwitchFailure = yield* readActiveTenantIds();
        assertOptionalField(sessionsAfterUnexpectedSwitchFailure[0], 'activeTenantId', secondTenantId);
        yield* authDatabase.update(session).set({ activeTenantId: null }).where(eq(session.userId, betterAuthUserId));
        const unexpectedLegacyUpgradeResponse = yield* Effect.tryPromise(() =>
          runtime.handler(
            new Request(`${configuration.baseUrl}/auth/session`, {
              headers: new Headers({
                cookie: authenticatedCookie,
                origin: configuration.baseUrl,
                'x-correlation-id': 'unexpected-legacy-upgrade-test',
              }),
            }),
          ),
        );
        expect(unexpectedLegacyUpgradeResponse.status).toBe(500);
        expect(yield* Effect.tryPromise(() => unexpectedLegacyUpgradeResponse.text())).not.toMatch(
          /secret auth persistence defect|P0001/u,
        );
        const sessionsAfterUnexpectedLegacyUpgrade = yield* readActiveTenantIds();
        assertOptionalField(sessionsAfterUnexpectedLegacyUpgrade[0], 'activeTenantId', null);
      }),
    );
    const upgradedSession = yield* authentication
      .currentSession(authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    assertOptionalField(upgradedSession.identity, 'tenantId', firstTenantId);
    const upgradedSessionRows = yield* readActiveTenantIds();
    assertOptionalField(upgradedSessionRows[0], 'activeTenantId', firstTenantId);
    yield* authentication
      .switchTenant(secondTenantId, authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    yield* coreDatabase
      .update(principalAuthBindings)
      .set({
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
        status: 'revoked',
      })
      .where(eq(principalAuthBindings.tenantId, secondTenantId));
    yield* assertSessionForbidden(
      authentication.currentSession(authenticatedHeaders).pipe(Effect.provide(multiAuthenticationContextLayer)),
    );
    yield* coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(eq(principalAuthBindings.tenantId, secondTenantId));
    const restoredSession = yield* authentication
      .currentSession(authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    assertOptionalField(restoredSession.identity, 'tenantId', secondTenantId);
    // Production evidence retains referenced bindings. Clear only this fixture's evidence so the
    // resolver can still prove that an existing selected session rejects a genuinely missing row.
    yield* purgeFixtureRows([
      coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, secondTenantId)),
      coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, secondTenantId)),
      coreDatabase.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, secondTenantId)),
    ]);
    yield* assertSessionForbidden(
      authentication.currentSession(authenticatedHeaders).pipe(Effect.provide(multiAuthenticationContextLayer)),
    );
  }),
);
