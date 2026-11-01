import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ActiveApplicationCompositionService,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  ActiveApplicationCompositionUnavailableError,
  PrincipalResolver,
  PrincipalResolverUnavailableError,
  ContextAccess,
  LegalEntityContext,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
  loadDatabaseConnectionPair,
  loadDatabaseIdentityConnections,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  makePrincipalResolver,
  makeTenantModuleStateService,
  ActiveApplicationCompositionSnapshotSchema,
  bindSelfApiKeyAction,
  changeTenantModuleStateAction,
  InstalledModuleCatalogService,
  CorePersistenceLive,
  DatabaseConfig,
  makeContextAccessLive,
  makeContextPermissionRelationshipMutationLive,
  PrincipalResolverLive,
  runAction,
} from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeGatewayScopeGrantRegistrar, makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
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
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, apikey, authRelations, session, user } from '../../api/auth/db/schema.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerLayerOptions } from '../../api/auth/gateway-issuer.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime as makeProductionShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';
import {
  contentDigest,
  makeCompositionSnapshot as makeFixtureCompositionSnapshot,
} from '../fixtures/application-composition.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

/** Test authority retains the actual validated fixture snapshot, including its original freshness. */
const fixtureSnapshots = new Map<string, Effect.Success<ReturnType<typeof makeFixtureCompositionSnapshot>>>();
const makeCompositionSnapshot: typeof makeFixtureCompositionSnapshot = (...args) =>
  makeFixtureCompositionSnapshot(...args).pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        fixtureSnapshots.set(snapshot.composition.revision, snapshot);
      }),
    ),
  );
const makeShellRuntimeForDatabase =
  (runtimeDatabase?: DatabaseConnectionPair) =>
  (...args: Parameters<typeof makeProductionShellAuthenticationApiRuntime>) => {
    const [authentication, issuer, states, loadCatalog, matcher, access, gateways, scopedStates, external] = args;
    const load =
      loadCatalog === undefined
        ? Effect.fail(
            new ActiveApplicationCompositionUnavailableError({ reason: 'No test release source was configured' }),
          )
        : loadCatalog.pipe(
            Effect.mapError(
              (cause) =>
                new ActiveApplicationCompositionUnavailableError({
                  cause,
                  reason: 'Test release source is unavailable',
                }),
            ),
            Effect.flatMap((catalog) => {
              const snapshot = fixtureSnapshots.get(catalog.composition.revision);
              return snapshot === undefined
                ? Effect.fail(
                    new ActiveApplicationCompositionUnavailableError({
                      reason: 'No actual fixture snapshot matches the captured release',
                    }),
                  )
                : Effect.succeed(snapshot);
            }),
          );
    return makeProductionShellAuthenticationApiRuntime(
      authentication,
      issuer,
      states,
      loadCatalog,
      matcher,
      access,
      gateways,
      scopedStates,
      external,
      { load },
      runtimeDatabase,
    );
  };
const makeShellAuthenticationApiRuntime = makeShellRuntimeForDatabase();
const shellAuthFixtureServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const fixtureSnapshotForRevision = (revision: string) => {
  const snapshot = fixtureSnapshots.get(revision);
  return snapshot === undefined
    ? Effect.fail(
        new ActiveApplicationCompositionUnavailableError({
          reason: 'No actual fixture snapshot matches this revision',
        }),
      )
    : Effect.succeed(snapshot);
};

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
    const approvedPageCatalog = yield* installedPageCatalog();
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: yield* fixtureSnapshotForRevision(approvedPageCatalog.composition.revision),
      mode: 'schema-only',
      purpose: 'stabilization-1287-shell-auth',
    });
    const makeOwnedShellAuthenticationApiRuntime = makeShellRuntimeForDatabase(isolated.connections);
    const configuration = {
      ...(yield* loadAuthConfig({ envPath: '/dev/null' })),
      connectionString: isolated.connections.runtime.connectionString,
    };
    const coreClient = yield* makeTestPgClient(isolated.connections.admin.connectionString);
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: staffAuthenticationNamespaceId },
    );
    const authentication = yield* makeAuthenticationService({
      allowFixtureSignUp: true,
    }).pipe(
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
    const anonymousRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    const pageRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    const selectionRequiredRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    const deniedPageRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    // A real explicit promotion changes only this case's owned database after the page stale/denial controls.
    const replacementSnapshot = yield* installedSnapshot(['testing.one']);
    expect(replacementSnapshot.composition.revision).toBe(testRevision);
    yield* isolated.composition.closeAdmission();
    yield* isolated.composition.drain();
    yield* isolated.composition.publishReplacement(replacementSnapshot);
    const supersededPageResponse = yield* Effect.tryPromise(() => pageRuntime.handler(exactPageRequest()));
    expect(supersededPageResponse.status).toBe(503);
    expect(providerCalls).toBe(0);
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
    const deniedIdentityAdministrationRuntime = makeOwnedShellAuthenticationApiRuntime(
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
              | 'review_party_identity';
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
    // This is the production Shell wiring and its real dynamically created Core Read, not a ReadRuntime double.
    expect(activeModulesResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => activeModulesResponse.json())).toEqual({
      compositionRevision: testRevision,
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
        servingModuleKey: dataAccessEvents.servingModuleKey,
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
      servingModuleKey: 'core.shell',
    });
    const refreshingRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    const unavailableModulesHandler = makeOwnedShellAuthenticationApiRuntime(
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
    const issuingHandler = makeOwnedShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer(issuerDependencies).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      moduleStateLayer,
      installedCatalog(['testing.one']),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(issuingHandler);
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
    const databaseConnections = isolated.connections;
    const scopeGrantAdminClient = yield* makeTestPgClient(databaseConnections.admin.connectionString);
    const sourceIdentities = yield* loadDatabaseIdentityConnections({ envPath: '/dev/null' });
    const sourceIssuer = sourceIdentities.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
    const issuerAddress = new URL(sourceIssuer.connectionString);
    expect(sourceIssuer.host).toBe(isolated.connections.runtime.host);
    expect(sourceIssuer.port).toBe(isolated.connections.runtime.port);
    expect(sourceIssuer.database).toBe(sourceIdentities.runtime[SHARED_RUNTIME_IDENTITY.id].database);
    expect(sourceIssuer.user).toBe(SHELL_GATEWAY_ISSUER_IDENTITY.role);
    expect(issuerAddress.search).toBe('');
    expect(issuerAddress.hash).toBe('');
    issuerAddress.pathname = `/${isolated.connections.runtime.database}`;
    const ownedIssuer = yield* loadDatabaseConnectionPair({
      environment: {
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerAddress.href,
      },
      envPath: '/dev/null',
      identity: SHELL_GATEWAY_ISSUER_IDENTITY,
    });
    const scopeGrantIssuerClient = yield* makeTestPgClient(ownedIssuer.runtime.connectionString);
    // The grant function checks expiry against the database clock, so the issuer reads the same clock.
    const databaseNowSeconds = scopeGrantAdminClient<{
      readonly now: number;
    }>`select floor(extract(epoch from clock_timestamp()))::int as now`.pipe(
      Effect.map(([row]) => row?.now ?? 0),
      Effect.orDie,
    );
    const partyRegistryIssuingHandler = makeOwnedShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        ...issuerDependencies,
        currentTimeSeconds: databaseNowSeconds,
        generateJti: Effect.sync(() => randomUUID()),
        loadAdmission: Effect.succeed({
          audiences: new Map([['party-registry', 'integration-build']]),
          revision: testRevision,
        }),
      }).pipe(Layer.provide(scopeGrantRegistrarLayer(makeGatewayScopeGrantRegistrar(scopeGrantIssuerClient)))),
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
    const defectHandler = makeOwnedShellAuthenticationApiRuntime(
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
  }, Effect.provide(shellAuthFixtureServices)),
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
    const fallbackLegalEntityId = '36000000-0000-4000-8000-000000000003';
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
    const initialSnapshot = yield* installedSnapshot(['testing.first', 'testing.second']);
    const testRevision = initialSnapshot.composition.revision;
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: initialSnapshot,
      mode: 'schema-only',
      purpose: 'stabilization-1287-shell-auth',
    });
    const makeOwnedShellAuthenticationApiRuntime = makeShellRuntimeForDatabase(isolated.connections);
    const configuration = {
      ...(yield* loadAuthConfig({ envPath: '/dev/null' })),
      connectionString: isolated.connections.runtime.connectionString,
    };
    const databaseConnections = isolated.connections;
    const adminClient = yield* makeTestPgClient(databaseConnections.admin.connectionString);
    const coreClient = yield* makeTestPgClient(isolated.connections.admin.connectionString);
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const adminAuthDatabase = yield* makeTestDatabaseFromClient(adminClient, authRelations);
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: staffAuthenticationNamespaceId },
    );
    const authentication = yield* makeAuthenticationService({
      allowFixtureSignUp: true,
    }).pipe(
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
          .where(
            inArray(legalEntities.legalEntityId, [firstLegalEntityId, secondLegalEntityId, fallbackLegalEntityId]),
          ),
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
    const runtime = makeOwnedShellAuthenticationApiRuntime(
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
    const resolverUnavailableAuthentication = yield* makeAuthenticationService({}).pipe(
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
    const resolverUnavailableRuntime = makeOwnedShellAuthenticationApiRuntime(
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
    // Q01=A: retire saved A, then expose the sole active authorized B in the same Tenant.
    // Only the candidate/permission services are fixture-controlled; AuthenticationService,
    // Better Auth session persistence, the gateway route, signing and verification remain real.
    yield* coreDatabase.insert(legalEntities).values({
      legalEntityId: fallbackLegalEntityId,
      legalName: 'Fallback legal entity',
      registrationCountry: 'CZ',
      registrationNumber: 'AUTH-MULTI-3',
      status: 'active',
      tenantId: firstTenantId,
    });
    yield* coreDatabase
      .update(legalEntities)
      .set({ status: 'suspended' })
      .where(eq(legalEntities.legalEntityId, firstLegalEntityId));
    legalEntityByTenant.set(firstTenantId, {
      legalEntityId: fallbackLegalEntityId,
      legalName: 'Fallback legal entity',
    });
    const issueForExpectedEntity = (legalEntityId?: string) =>
      Effect.tryPromise(() =>
        runtime.handler(
          new Request(`${configuration.baseUrl}/auth/gateway-context`, {
            body: JSON.stringify({ audience: 'inventory-stock', compositionRevision: testRevision, legalEntityId }),
            headers: new Headers({
              'content-type': 'application/json',
              cookie: authenticatedCookie,
              origin: configuration.baseUrl,
            }),
            method: 'POST',
          }),
        ),
      );
    const staleExpectedResponse = yield* issueForExpectedEntity(firstLegalEntityId);
    expect(staleExpectedResponse.status).toBe(403);
    const staleExpectedBody = yield* Effect.tryPromise(() => staleExpectedResponse.json());
    expect(staleExpectedBody).not.toHaveProperty('token');
    const persistedFallback = yield* authDatabase
      .select({
        activeLegalEntityId: session.activeLegalEntityId,
        activeTenantId: session.activeTenantId,
      })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assertOptionalField(persistedFallback[0], 'activeTenantId', firstTenantId);
    assertOptionalField(persistedFallback[0], 'activeLegalEntityId', fallbackLegalEntityId);
    const resolvedFallback = yield* authentication
      .resolveShellContext(authenticatedHeaders)
      .pipe(Effect.provide(multiAuthenticationContextLayer));
    expect(resolvedFallback.state).toBe('authenticated');
    if (resolvedFallback.state === 'authenticated') {
      expect(resolvedFallback.principal.legalEntityId).toBe(fallbackLegalEntityId);
      expect(resolvedFallback.principal.tenantId).toBe(firstTenantId);
    }
    for (const expectedEntity of [undefined, fallbackLegalEntityId]) {
      const fallbackResponse = yield* issueForExpectedEntity(expectedEntity);
      const { principal: fallbackPrincipal } = yield* verifiedGatewayAssertion(
        fallbackResponse,
        pair.publicKey,
        testRevision,
      );
      expect(fallbackPrincipal.legalEntityId).toBe(fallbackLegalEntityId);
      expect(fallbackPrincipal.tenantId).toBe(firstTenantId);
      expect(fallbackPrincipal.principalId).toBe(firstPrincipalId);
    }
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
      coreDatabase.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, secondTenantId)),
    ]);
    yield* assertSessionForbidden(
      authentication.currentSession(authenticatedHeaders).pipe(Effect.provide(multiAuthenticationContextLayer)),
    );
  }, Effect.provide(shellAuthFixtureServices)),
);

class TenantPartyGatewayTestError extends Schema.TaggedError<TenantPartyGatewayTestError>()(
  'TenantPartyGatewayTestError',
  { reason: Schema.String },
) {}

const PartyOwnerMarkerSchema = Schema.Struct({
  appId: Schema.Literal('party-registry'),
  buildMarker: Schema.String.check(Schema.isMinLength(1)),
});
const PartyOwnerReadySchema = Schema.Struct({
  marker: PartyOwnerMarkerSchema,
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const ShellOwnerReadySchema = Schema.Struct({
  marker: Schema.Struct({ appId: Schema.Literal('shell-super-app'), buildMarker: Schema.String }),
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const PartyGatewayReferenceSchema = Schema.Struct({
  moduleId: Schema.Literal('party.registry'),
  resourceId: Schema.String.pipe(Schema.brand('ResourceId')),
  resourceType: Schema.Literal('party.registry.party'),
  tenantId: Schema.String.pipe(Schema.brand('TenantId')),
});
const PartyCreatedResponseSchema = Schema.Struct({
  outcome: Schema.Literal('CREATED'),
  partyRef: PartyGatewayReferenceSchema,
});
const PartyGatewayDetailResponseSchema = Schema.Struct({
  factHistory: Schema.OptionFromNullOr(Schema.Array(Schema.Struct({ partyRef: PartyGatewayReferenceSchema }))),
  party: Schema.Struct({
    displayName: Schema.String,
    partyRef: PartyGatewayReferenceSchema,
    partyType: Schema.Literal('ORGANIZATION'),
  }),
});
const tenantPartyServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);
const tenantPartyArtifactServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const readFixtureReleaseIdentity = Effect.fn('TenantPartyGatewayTest.releaseIdentity')(
  function* readFixtureReleaseIdentity(directory: string) {
    const generated = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          deliveryUnit: Schema.Struct({
            buildMarker: Schema.String,
            unitId: Schema.String.pipe(Schema.brand('UltramodernDeliveryUnitId')),
          }),
        }),
      ),
    )(
      yield* Effect.tryPromise(() => readFile(path.join(appRoot, directory, 'shared/ultramodern-build.json'), 'utf-8')),
    );
    return yield* Effect.try(() =>
      resolveUltramodernReleaseIdentity({
        generationBuildMarker: generated.deliveryUnit.buildMarker,
        unitId: generated.deliveryUnit.unitId,
        workspaceRoot: appRoot,
      }),
    );
  },
);

const prepareTenantPartyArtifacts = Effect.fn('TenantPartyGatewayTest.artifacts')(
  function* prepareTenantPartyArtifacts() {
    const toolchainPaths: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'MISE_DATA_DIR', 'MISE_CACHE_DIR', 'MISE_CONFIG_DIR', 'MISE_INSTALL_PATH']) {
      const value = yield* Config.option(Config.String(key));
      if (Option.isSome(value)) {
        toolchainPaths[key] = value.value;
      }
    }
    const toolchainEnvironment = { ...toolchainPaths, APP_ENV_PATH: '/dev/null' };
    const partyIdentity = yield* readFixtureReleaseIdentity('verticals/party-registry');
    const shellIdentity = yield* readFixtureReleaseIdentity('apps/shell-super-app');
    // Source-compiled default HTTP proof: retain the complete actual public documents and their physical hashes.
    // Separate native relay tests prove the actual packaged receivers.
    const partyDocument = yield* Effect.tryPromise(() =>
      readFile(
        path.join(appRoot, 'verticals/party-registry/.output/public/.well-known/ontos-module-manifest.json'),
        'utf-8',
      ),
    );
    const shellRuntimeDocument = yield* Effect.tryPromise(() =>
      readFile(
        path.join(appRoot, 'apps/shell-super-app/.output/public', ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1)),
        'utf-8',
      ),
    );
    const partyContract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      partyDocument,
    );
    const shellRuntimeContract = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OntosShellRuntimeContractSchema),
    )(shellRuntimeDocument);
    expect(partyContract.deployment).toMatchObject({ appId: 'party-registry', buildMarker: partyIdentity.buildMarker });
    expect(shellRuntimeContract.deployment).toMatchObject({
      appId: 'shell-super-app',
      buildMarker: shellIdentity.buildMarker,
    });
    const partyContractSha256 = contentDigest(partyDocument);
    const shellRuntimeSha256 = contentDigest(shellRuntimeDocument);
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const artifact = path.join(appRoot, 'verticals/party-registry/node_modules/.cache/ontos-1267', `${suffix}.mjs`);
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
    const bundle = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/party-registry/tests/support/tenant-party-http.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--define:ULTRAMODERN_BUILD_MARKER=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(partyIdentity.buildMarker)}`,
        `--define:ULTRAMODERN_SOURCE_REVISION=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(partyIdentity.sourceRevision)}`,
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, env: toolchainEnvironment, extendEnv: false, stderr: 'pipe', stdout: 'pipe' },
    );
    const [bundleExit] = yield* Effect.all(
      [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
      { concurrency: 3 },
    );
    expect(bundleExit).toBe(0);
    const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
      cwd: appRoot,
      env: toolchainEnvironment,
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [markerLines, descriptionExit] = yield* Effect.all(
      [
        description.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        description.exitCode,
        Stream.runDrain(description.stderr),
      ],
      { concurrency: 3 },
    );
    expect(descriptionExit).toBe(0);
    const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PartyOwnerMarkerSchema))(markerLines[0]);
    expect(marker).toEqual(partyContract.deployment);
    const shellArtifact = path.join(appRoot, 'apps/shell-super-app/node_modules/.cache/ontos-1267', `${suffix}.mjs`);
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(shellArtifact, { force: true })));
    const shellBundle = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'apps/shell-super-app/tests/support/tenant-party-shell-http.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--define:ULTRAMODERN_BUILD_MARKER=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(shellIdentity.buildMarker)}`,
        `--define:ULTRAMODERN_SOURCE_REVISION=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(shellIdentity.sourceRevision)}`,
        `--outfile=${shellArtifact}`,
      ],
      { cwd: appRoot, env: toolchainEnvironment, extendEnv: false, stderr: 'pipe', stdout: 'pipe' },
    );
    const [shellBundleExit] = yield* Effect.all(
      [shellBundle.exitCode, Stream.runDrain(shellBundle.stderr), Stream.runDrain(shellBundle.stdout)],
      { concurrency: 3 },
    );
    expect(shellBundleExit).toBe(0);
    return {
      artifact,
      marker,
      partyContractSha256,
      partyDocument,
      shellArtifact,
      shellRuntimeDocument,
      shellRuntimeSha256,
      toolchainEnvironment,
    };
  },
);
const TenantPartyArtifacts = Context.Service<Effect.Success<ReturnType<typeof prepareTenantPartyArtifacts>>>(
  'TenantPartyGatewayTest.artifacts',
);
const tenantPartyArtifactsLayer = Layer.effect(TenantPartyArtifacts, prepareTenantPartyArtifacts()).pipe(
  Layer.provideMerge(tenantPartyArtifactServices),
);

const prepareTenantPartyCase = Effect.fn('TenantPartyGatewayTest.prepareCase')(function* prepareTenantPartyCase(
  quotaOnly: boolean,
) {
  const {
    artifact,
    marker,
    partyContractSha256,
    partyDocument,
    shellArtifact,
    shellRuntimeDocument,
    shellRuntimeSha256,
    toolchainEnvironment,
  } = yield* TenantPartyArtifacts;
  const crypto = yield* Crypto.Crypto;
  const suffix = yield* crypto.randomUUIDv4();
  const snapshot = yield* makeCompositionSnapshot([partyDocument], 3_600_000, shellRuntimeDocument);
  expect(snapshot.composition.modules[0]?.contract.sha256).toBe(partyContractSha256);
  expect(snapshot.composition.modules[0]?.contractDocument).toBe(partyDocument);
  expect(snapshot.composition.shell.runtimeContract.sha256).toBe(shellRuntimeSha256);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1267-party-gateway',
  });
  const snapshotDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(snapshot);
  const source = yield* HttpServer.HttpServer;
  yield* source.serve(
    Effect.succeed(
      HttpServerResponse.text(snapshotDocument, {
        contentType: 'application/json',
      }),
    ),
  );
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
    return yield* new TenantPartyGatewayTestError({ reason: 'The composition source requires a TCP address' });
  }
  const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const privateJwk = yield* Effect.tryPromise(() => exportJWK(pair.privateKey));
  const publicJwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
  const sourceIdentities = yield* loadDatabaseIdentityConnections({ envPath: '/dev/null' });
  const partyUrl = new URL(sourceIdentities.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id].connectionString);
  const issuerUrl = new URL(sourceIdentities.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id].connectionString);
  const sourceShared = sourceIdentities.runtime[SHARED_RUNTIME_IDENTITY.id];
  for (const identity of [PARTY_REGISTRY_REQUEST_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY]) {
    const canonical = sourceIdentities.runtime[identity.id];
    const address = new URL(canonical.connectionString);
    const exactSourceAndOwnedTarget = [
      canonical.database === sourceIdentities.admin.database,
      canonical.database === sourceShared.database,
      canonical.host === sourceIdentities.admin.host,
      canonical.port === sourceIdentities.admin.port,
      canonical.host === sourceShared.host,
      canonical.port === sourceShared.port,
      canonical.user === identity.role,
      canonical.host === isolated.connections.admin.host,
      canonical.port === isolated.connections.admin.port,
      isolated.connections.runtime.host === isolated.connections.admin.host,
      isolated.connections.runtime.port === isolated.connections.admin.port,
      isolated.connections.runtime.database === isolated.connections.admin.database,
      isolated.connections.admin.database !== sourceIdentities.admin.database,
      isolated.connections.admin.database !== sourceShared.database,
      ['localhost', '127.0.0.1'].includes(canonical.host),
      address.search === '',
      address.hash === '',
    ].every(Boolean);
    if (!exactSourceAndOwnedTarget) {
      return yield* new TenantPartyGatewayTestError({ reason: 'Dedicated identity target was refused' });
    }
  }
  partyUrl.pathname = `/${isolated.connections.runtime.database}`;
  issuerUrl.pathname = `/${isolated.connections.runtime.database}`;
  const partyConnections = yield* loadDatabaseConnectionPair({
    environment: {
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      PARTY_REGISTRY_DATABASE_URL: partyUrl.href,
    },
    envPath: '/dev/null',
    identity: PARTY_REGISTRY_REQUEST_IDENTITY,
  });
  const issuerConnections = yield* loadDatabaseConnectionPair({
    environment: {
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerUrl.href,
    },
    envPath: '/dev/null',
    identity: SHELL_GATEWAY_ISSUER_IDENTITY,
  });
  expect(partyConnections.runtime.database).toBe(isolated.connections.runtime.database);
  expect(issuerConnections.runtime.database).toBe(isolated.connections.runtime.database);
  const issuer = 'https://shell.example.test';
  const kid = `party-${suffix}`;
  const environment = {
    APP_ENV_PATH: '/dev/null',
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${source.address.port}/active-composition`,
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
  };
  const sourceConfiguration = yield* loadAuthConfig({ envPath: '/dev/null' });
  const configuration = { ...sourceConfiguration, connectionString: isolated.connections.runtime.connectionString };
  expect(new URL(configuration.connectionString).pathname === `/${isolated.connections.runtime.database}`).toBe(true);
  const authPersistence = yield* makeAuthDatabase(configuration);
  const resolverContext = yield* Layer.build(
    PrincipalResolverLive({ authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID }).pipe(
      Layer.provide(CorePersistenceLive),
      Layer.provide(Layer.succeed(DatabaseConfig, isolated.connections.runtime)),
    ),
  );
  const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
    Effect.provideService(AuthConfig, configuration),
    Effect.provideService(AuthDatabase, authPersistence),
    Effect.provideContext(resolverContext),
  );
  const fixtureEmail = `party-gateway-${suffix}@example.test`;
  const providerSubjectId = yield* authentication.createFixtureUser(fixtureEmail, 'Party gateway fixture', password);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [
        bindSelfApiKeyAction.descriptor.actionKey,
        changeTenantModuleStateAction.descriptor.actionKey,
        'party.registry.create-party',
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      managerIdentityAdmin: !quotaOnly,
      managerProviderSubjectId: providerSubjectId,
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const permissionEnvironment = {
    ...fixture.permissionEnvironment,
    SPICEDB_PRESHARED_KEY: Redacted.value(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY),
  };
  const runtimeContext = yield* Layer.build(fixture.layer);
  return {
    artifact,
    authentication,
    authPersistence,
    configuration,
    crypto,
    environment,
    fixture,
    fixtureEmail,
    isolated,
    issuer,
    issuerConnections,
    kid,
    marker,
    pair,
    partyConnections,
    permissionEnvironment,
    privateJwk,
    quotaOnly,
    runtimeContext,
    shellArtifact,
    snapshot,
    sourceIdentities,
    suffix,
    toolchainEnvironment,
  };
});
const TenantPartyCase =
  Context.Service<Effect.Success<ReturnType<typeof prepareTenantPartyCase>>>('TenantPartyGatewayTest.case');
const tenantPartyCaseLayer = (quotaOnly: boolean) =>
  Layer.effect(TenantPartyCase, prepareTenantPartyCase(quotaOnly)).pipe(Layer.provideMerge(tenantPartyServices));

const prepareTenantPartyReceivers = Effect.fn('TenantPartyGatewayTest.receivers')(
  function* prepareTenantPartyReceivers() {
    const {
      artifact,
      configuration,
      environment,
      isolated,
      issuerConnections,
      kid,
      marker,
      partyConnections,
      permissionEnvironment,
      privateJwk,
      quotaOnly,
      shellArtifact,
      snapshot,
      sourceIdentities,
      toolchainEnvironment,
    } = yield* TenantPartyCase;
    if (quotaOnly) {
      return { receivers: Option.none() };
    }
    const ownerSchemaEnvironment = {
      ...toolchainEnvironment,
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      DATABASE_URL: isolated.connections.runtime.connectionString,
      ONTOS_FIXTURE_OWNED_DATABASE: isolated.connections.admin.database,
      ONTOS_FIXTURE_SOURCE_DATABASE: sourceIdentities.admin.database,
      PARTY_REGISTRY_DATABASE_URL: partyConnections.runtime.connectionString,
      PATH: yield* Config.String('PATH'),
    };
    const runOwnerSchemaPhase = Effect.fn('TenantPartyGatewayTest.ownerSchemaPhase')(function* runOwnerSchemaPhase(
      phase: 'rebuild' | 'verify',
    ) {
      const ownerSchema = yield* ChildProcess.make(
        'mise',
        [
          'exec',
          '--',
          'pnpm',
          '--filter',
          '@app/party-registry',
          'exec',
          'node',
          'tests/support/current-owner-schema.fixture.ts',
          phase,
        ],
        {
          cwd: appRoot,
          env: ownerSchemaEnvironment,
          extendEnv: false,
          stderr: 'pipe',
          stdout: 'pipe',
        },
      );
      const [ownerSchemaExit] = yield* Effect.all(
        [ownerSchema.exitCode, Stream.runDrain(ownerSchema.stdout), Stream.runDrain(ownerSchema.stderr)],
        { concurrency: 3 },
      );
      expect(ownerSchemaExit).toBe(0);
    });
    yield* runOwnerSchemaPhase('rebuild');
    const ownershipContext = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const ownershipClient = Context.get(ownershipContext, PgClient.PgClient);
    const [physicalIdentity] = yield* ownershipClient<{
      readonly databaseName: string;
      readonly databaseOid: string;
      readonly owned: boolean;
      readonly systemIdentifier: string;
    }>`select current_database() as "databaseName", d.oid::text as "databaseOid",
      (pg_control_system()).system_identifier::text as "systemIdentifier",
      pg_get_userbyid(d.datdba)=current_user and current_user=session_user as owned
      from pg_database d where d.datname=current_database()`;
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        databaseName: Schema.Literal(isolated.connections.admin.database),
        databaseOid: Schema.String.check(Schema.isPattern(/^\d+$/u)),
        owned: Schema.Literal(true),
        systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
      }),
    )(physicalIdentity);
    const identitySetupRequest = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          creatorPid: Schema.Int,
          databaseName: Schema.String,
          databaseOid: Schema.String,
          systemIdentifier: Schema.String,
          type: Schema.Literal('prepare-privacy-native-identities'),
        }),
      ),
    )({
      creatorPid: process.pid,
      databaseName: identity.databaseName,
      databaseOid: identity.databaseOid,
      systemIdentifier: identity.systemIdentifier,
      type: 'prepare-privacy-native-identities',
    });
    // Fixed creator-bound CLI reapplies only the declared clone ACL/trust manifests; no login/password mutation.
    const identityManifest = yield* ChildProcess.make(
      process.execPath,
      [path.join(appRoot, 'scripts/integration/support/privacy-native-database-identities.mts'), identitySetupRequest],
      {
        cwd: appRoot,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          PARTY_REGISTRY_DATABASE_URL: partyConnections.runtime.connectionString,
          PATH: yield* Config.String('PATH'),
          SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerConnections.runtime.connectionString,
        },
        extendEnv: false,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [identityLines, identityManifestExit] = yield* Effect.all(
      [
        identityManifest.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        identityManifest.exitCode,
        Stream.runDrain(identityManifest.stderr),
      ],
      { concurrency: 3 },
    );
    expect(identityManifestExit).toBe(0);
    expect(identityLines).toHaveLength(1);
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          databaseName: Schema.Literal(identity.databaseName),
          databaseOid: Schema.Literal(identity.databaseOid),
          systemIdentifier: Schema.Literal(identity.systemIdentifier),
          type: Schema.Literal('privacy-native-identities-prepared'),
        }),
      ),
      { onExcessProperty: 'error' },
    )(identityLines[0]);
    yield* runOwnerSchemaPhase('verify');
    const shellChild = yield* ChildProcess.make(process.execPath, [shellArtifact], {
      cwd: appRoot,
      env: {
        ...toolchainEnvironment,
        ...permissionEnvironment,
        ...environment,
        BETTER_AUTH_SECRET: configuration.secret,
        BETTER_AUTH_TRUSTED_ORIGINS: configuration.trustedOrigins.join(','),
        BETTER_AUTH_URL: configuration.baseUrl,
        ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid, use: 'sig' }),
        SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerConnections.runtime.connectionString,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    yield* Stream.runDrain(shellChild.stderr).pipe(Effect.forkScoped);
    const shellFirstLine = yield* shellChild.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
    if (Option.isNone(shellFirstLine)) {
      return yield* new TenantPartyGatewayTestError({ reason: 'The real Shell runtime did not start' });
    }
    const shellReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellOwnerReadySchema))(
      shellFirstLine.value,
    );
    expect(shellReady.marker.buildMarker).toBe(snapshot.composition.shell.deployment.buildMarker);
    const child = yield* ChildProcess.make(process.execPath, [artifact], {
      cwd: appRoot,
      env: {
        ...toolchainEnvironment,
        ...permissionEnvironment,
        ...environment,
        PARTY_REGISTRY_DATABASE_URL: partyConnections.runtime.connectionString,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    const firstLine = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
    if (Option.isNone(firstLine)) {
      return yield* new TenantPartyGatewayTestError({ reason: 'The real Party runtime did not start' });
    }
    const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PartyOwnerReadySchema))(firstLine.value);
    expect(ready.marker).toEqual(marker);
    return { receivers: Option.some({ ready, shellReady }) };
  },
);
const TenantPartyReceivers = Context.Service<Effect.Success<ReturnType<typeof prepareTenantPartyReceivers>>>(
  'TenantPartyGatewayTest.receivers',
);
const tenantPartyReceiversLayer = () => Layer.effect(TenantPartyReceivers, prepareTenantPartyReceivers());

const tenantPartyPublicGateway = Effect.fn('TenantPartyGatewayTest.publicGateway')(
  function* tenantPartyPublicGateway() {
    const {
      authentication,
      authPersistence,
      configuration,
      crypto,
      fixture,
      fixtureEmail,
      issuer,
      pair,
      quotaOnly,
      runtimeContext,
      snapshot,
      suffix,
    } = yield* TenantPartyCase;
    const { receivers } = yield* TenantPartyReceivers;
    const signedIn = yield* authentication.signIn(
      fixtureEmail,
      password,
      new Headers({ origin: configuration.baseUrl }),
    );
    const sessionHeaders = new Headers({
      cookie: cookieHeader(signedIn.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const contextAccess = yield* makeContextAccessLive();
    const resolved = yield* authentication
      .resolveTenantContext(sessionHeaders)
      .pipe(Effect.provideService(ContextAccess, contextAccess));
    expect(resolved.state).toBe('authenticated');
    if (resolved.state !== 'authenticated') {
      return yield* new TenantPartyGatewayTestError({ reason: 'The real staff session did not resolve' });
    }
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
    );
    const pending = yield* keys.issue(sessionHeaders, {
      issuerPrincipalId: resolved.principal.principalId,
      lifecycleOperationId: yield* crypto.randomUUIDv4(),
      name: 'Tenant Party gateway proof',
      tenantId: fixture.tenantId,
    });
    yield* runAction({
      payload: yield* Schema.decodeEffect(bindSelfApiKeyAction.descriptor.payloadSchema)({
        providerSubjectId: pending.providerKeyId,
      }),
      principal: resolved.principal,
      registration: bindSelfApiKeyAction,
      transport: {
        correlationId: yield* crypto.randomUUIDv4(),
        idempotencyKey: yield* crypto.randomUUIDv4(),
        targetModuleKey: 'core.identity',
      },
    }).pipe(Effect.provideContext(runtimeContext));
    yield* keys.clearPendingCleanup(pending.providerKeyId);
    if (quotaOnly) {
      for (let verification = 0; verification < 12; verification += 1) {
        const verified = yield* keys.verify(Redacted.value(pending.secret));
        expect(verified.providerKeyId === pending.providerKeyId).toBe(true);
      }
      const invalid = yield* keys.verify(`invalid-${suffix}`).pipe(Effect.result);
      expect(Result.isFailure(invalid) && invalid.failure.code === 'api_key_invalid').toBe(true);
      yield* keys.setEnabled(pending.providerKeyId, false);
      const disabled = yield* keys.verify(Redacted.value(pending.secret)).pipe(Effect.result);
      expect(Result.isFailure(disabled) && disabled.failure.code === 'api_key_invalid').toBe(true);
      yield* keys.setEnabled(pending.providerKeyId, true);
      // Only this fixture's own key is expired; the real provider must still reject it.
      yield* authPersistence.executor
        .update(apikey)
        .set({ expiresAt: yield* DateTime.nowAsDate })
        .where(eq(apikey.id, pending.providerKeyId));
      const expired = yield* keys.verify(Redacted.value(pending.secret)).pipe(Effect.result);
      expect(Result.isFailure(expired) && expired.failure.code === 'api_key_invalid').toBe(true);
      return undefined;
    }
    if (Option.isNone(receivers)) {
      return yield* new TenantPartyGatewayTestError({ reason: 'The default Party receivers were not prepared' });
    }
    const { ready, shellReady } = receivers.value;
    const issue = (legalEntityId?: string) =>
      Effect.tryPromise(() =>
        fetch(`http://127.0.0.1:${shellReady.port}/shell-super-app-api/auth/api-key/gateway-context`, {
          body: JSON.stringify({
            audience: 'party-registry',
            compositionRevision: snapshot.composition.revision,
            legalEntityId,
          }),
          headers: {
            'content-type': 'application/json',
            origin: configuration.baseUrl,
            'x-api-key': Redacted.value(pending.secret),
          },
          method: 'POST',
        }),
      );
    const firstAssertion = yield* issue();
    expect(firstAssertion.status).toBe(200);
    const { token } = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(
      yield* Effect.tryPromise(() => firstAssertion.json()),
    );
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(token, pair.publicKey, { audience: 'party-registry', issuer }),
    );
    const apiKeyPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
      verified.payload['principal'],
    );
    expect(apiKeyPrincipal.authMethod).toBe('api_key');
    expect(apiKeyPrincipal.legalEntityId).toBeUndefined();
    const ownerUrl = `http://127.0.0.1:${ready.port}/party-registry-api`;
    const request = Effect.fn('TenantPartyGatewayTest.request')(function* ownerRequest(
      route: string,
      body: string,
      assertion?: string,
    ) {
      let fresh = assertion;
      if (fresh === undefined) {
        const assertionResponse = yield* issue();
        expect(assertionResponse.status).toBe(200);
        const decoded = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(
          yield* Effect.tryPromise(() => assertionResponse.json()),
        );
        fresh = decoded.token;
      }
      const requestToken = fresh;
      return yield* Effect.tryPromise(() =>
        fetch(`${ownerUrl}${route}`, {
          body,
          headers: {
            authorization: `Bearer ${requestToken}`,
            'content-type': 'application/json',
            'idempotency-key': suffix,
            'x-correlation-id': suffix,
            'x-ontos-composition-revision': snapshot.composition.revision,
          },
          method: 'POST',
        }),
      );
    });
    const createdResponse = yield* request(
      '/party-registry/actions/create-party',
      JSON.stringify({
        candidate: {
          displayName: 'Public tenant gateway proof',
          evidenceRefs: ['review/public-party-gateway'],
          officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
          partyType: 'ORGANIZATION',
          provenance: { method: 'DOCUMENT', source: 'public-party-gateway' },
          subjectEvidence: [
            {
              basis: 'REVIEWED_DOCUMENT',
              evidenceRef: 'review/public-party-gateway',
              kind: 'ACTOR_ATTESTATION',
              observedSubject: 'ORGANIZATION',
              statement: 'Reviewed the concrete external organization',
              subjectKey: suffix,
            },
          ],
          validFrom: '2020-01-01T00:00:00.000Z',
        },
      }),
      token,
    );
    expect(createdResponse.status).toBe(200);
    const created = yield* Schema.decodeUnknownEffect(PartyCreatedResponseSchema)(
      yield* Effect.tryPromise(() => createdResponse.json()),
    );
    expect(created.partyRef.tenantId).toBe(fixture.tenantId);
    const detailPayload = { partyRef: created.partyRef };
    expect((yield* request('/reads/party-detail', JSON.stringify(detailPayload))).status).toBe(403);
    const mutation = yield* makeContextPermissionRelationshipMutationLive();
    const grant = {
      principal: apiKeyPrincipal,
      target: { moduleId: 'party.registry', permission: 'module.access' },
      tenantId: fixture.tenantId,
    };
    yield* mutation.mutate({ ...grant, operation: 'grant' });
    yield* Effect.addFinalizer(() => mutation.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
    const detailResponse = yield* request('/reads/party-detail', JSON.stringify(detailPayload));
    expect(detailResponse.status).toBe(200);
    const detail = yield* Schema.decodeUnknownEffect(PartyGatewayDetailResponseSchema)(
      yield* Effect.tryPromise(() => detailResponse.json()),
    );
    expect(detail.party).toEqual({
      displayName: 'Public tenant gateway proof',
      partyRef: created.partyRef,
      partyType: 'ORGANIZATION',
    });
    expect(Option.isNone(detail.factHistory)).toBe(true);
    const historyResponse = yield* request(
      '/reads/party-detail',
      JSON.stringify({ ...detailPayload, includeFactHistory: true }),
    );
    expect(historyResponse.status).toBe(200);
    const history = yield* Schema.decodeUnknownEffect(PartyGatewayDetailResponseSchema)(
      yield* Effect.tryPromise(() => historyResponse.json()),
    );
    expect(history.party).toEqual(detail.party);
    expect(Option.isSome(history.factHistory)).toBe(true);
    if (Option.isNone(history.factHistory)) {
      return yield* new TenantPartyGatewayTestError({ reason: 'The authorized owner history was absent' });
    }
    expect(history.factHistory.value.length).toBeGreaterThan(0);
    for (const fact of history.factHistory.value) {
      expect(fact.partyRef).toEqual(created.partyRef);
      expect(fact.partyRef.tenantId).toBe(fixture.tenantId);
    }
    const foreignReference = { ...created.partyRef, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    expect((yield* request('/reads/party-detail', JSON.stringify({ partyRef: foreignReference }))).status).toBe(404);
    expect(
      (yield* request(
        '/reads/party-detail',
        JSON.stringify({ partyRef: { ...created.partyRef, resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }),
      )).status,
    ).toBe(404);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const changeState = Effect.fn('TenantPartyGatewayTest.changeState')(function* changeState(
      newState: 'active' | 'inactive',
    ) {
      return yield* runAction({
        payload: yield* Schema.decodeEffect(changeTenantModuleStateAction.descriptor.payloadSchema)({
          moduleKey: 'party.registry',
          newState,
        }),
        principal: resolved.principal,
        registration: changeTenantModuleStateAction,
        transport: {
          correlationId: yield* crypto.randomUUIDv4(),
          idempotencyKey: yield* crypto.randomUUIDv4(),
          targetModuleKey: 'core.modules',
        },
      }).pipe(
        Effect.provideContext(runtimeContext),
        Effect.provideService(InstalledModuleCatalogService, {
          loadForRevision: (_compositionRevision) => Effect.succeed(catalog),
        }),
      );
    });
    yield* changeState('inactive');
    expect((yield* request('/reads/party-detail', JSON.stringify(detailPayload))).status).toBe(403);
    yield* changeState('active');
    expect((yield* request('/reads/party-detail', JSON.stringify(detailPayload))).status).toBe(200);
    expect((yield* request('/reads/party-detail', JSON.stringify(detailPayload), token)).status).toBe(401);
    expect((yield* issue('ffffffff-ffff-4fff-8fff-ffffffffffff')).status).toBe(403);
    return undefined;
  },
);

// The outer hook owns immutable bundles only; each selected case gets fresh native resources.
const tenantPartyArtifactMemoMap = Layer.makeMemoMapUnsafe();
it.layer(tenantPartyArtifactsLayer, {
  excludeTestServices: true,
  memoMap: tenantPartyArtifactMemoMap,
  timeout: 30_000,
})('tenant Party public gateway', () => {
  for (const { name, quotaOnly } of [
    {
      name: 'verifies the same API key more than ten times while rejecting invalid disabled and expired keys',
      quotaOnly: true,
    },
    {
      name: 'issues a real API-key assertion and serves tenant detail through the default Party HTTP runtime',
      quotaOnly: false,
    },
  ]) {
    const caseMemoMap = Layer.forkMemoMapUnsafe(tenantPartyArtifactMemoMap);
    const caseLayer = tenantPartyCaseLayer(quotaOnly).pipe(Layer.provideMerge(tenantPartyArtifactsLayer));
    it.layer(caseLayer, {
      excludeTestServices: true,
      memoMap: caseMemoMap,
      timeout: 30_000,
    })(() => {
      it.layer(tenantPartyReceiversLayer().pipe(Layer.provideMerge(caseLayer)), {
        excludeTestServices: true,
        memoMap: caseMemoMap,
        timeout: 30_000,
      })((caseIt) => {
        caseIt.effect(name, tenantPartyPublicGateway);
      });
    });
  }
});
