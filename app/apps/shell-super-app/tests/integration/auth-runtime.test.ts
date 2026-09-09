import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PrincipalResolver,
  PrincipalResolverUnavailableError,
  ContextAccess,
  LegalEntityContext,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
  buildInstalledModuleCatalog,
  loadDatabaseConnectionPair,
  makePrincipalResolver,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import type { InstalledModuleCatalog } from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';

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
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import { renderActionPrincipalServer } from '../../../../scripts/scaffolding/microvertical-action-boundary/scaffold.mts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, authRelations, session, user } from '../../api/auth/db/schema.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerLayerOptions } from '../../api/auth/gateway-issuer.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';

type AuthenticationRuntimeHandler = ReturnType<ReturnType<typeof makeShellAuthenticationApiRuntime>['createHandler']>;
const email = 'better-auth-runtime@example.test';
const password = 'correct-horse-battery-staple';
const tenantId = '30000000-0000-4000-8000-000000000001';
const foreignTenantId = '30000000-0000-4000-8000-000000000002';
const principalId = '40000000-0000-4000-8000-000000000001';
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const fixtureLegalEntityId = '35000000-0000-4000-8000-000000000001';
const fixtureAuthBindingId = '45000000-0000-4000-8000-000000000001';
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
const contextAccessLayer = Layer.succeed(ContextAccess, legalEntitySelectionOptions.contextAccess);
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

const installedCatalog = (moduleIds: readonly string[]): InstalledModuleCatalog =>
  Object.freeze({
    contracts: Object.freeze([]),
    deploymentAppIds: Object.freeze([]),
    deploymentStatuses: Object.freeze([]),
    getByDeploymentAppId: () => undefined,
    getByModuleId: () => undefined,
    moduleIds: Object.freeze([...moduleIds]),
    outboxSubscriptions: Object.freeze([]),
  });
const installedPageCatalog = (): InstalledModuleCatalog =>
  buildInstalledModuleCatalog([
    {
      contract: {
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
      expectedAppId: 'inventory-stock',
    },
  ]);
it.live(
  'creates, resolves, persists, revokes, and signs out a Better Auth session',
  Effect.fnUntraced(function* runIntegration1() {
    const configuration = yield* loadAuthConfig();
    const corePool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: configuration.connectionString })),
      (pool) => Effect.promise(() => pool.end()),
    );
    const coreDatabase = yield* makeTestDatabaseFromPool(corePool, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const resolver = makePrincipalResolver({ executor: coreDatabase });
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
      principalAuthBindingId: fixtureAuthBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    yield* coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'testing1', state: 'active', tenantId },
      { moduleKey: 'testing.pages', state: 'active', tenantId },
      { moduleKey: 'stale-non-installed', state: 'active', tenantId },
      { moduleKey: 'inactive-installed', state: 'suspended', tenantId },
      { moduleKey: 'testing1', state: 'active', tenantId: foreignTenantId },
    ]);
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
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
      contextAccessLayer,
    );
    const unavailableHandler = anonymousRuntime.createHandler();
    handlers.push(unavailableHandler);
    const anonymousGatewayResponse = yield* Effect.tryPromise(() =>
      unavailableHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock' }),
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
        body: JSON.stringify({ entrypointKey, moduleId: 'testing.pages' }),
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
    const pageRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000009'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedPageCatalog()),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(pageRuntime);
    const exactPageResponse = yield* Effect.tryPromise(() => pageRuntime.handler(exactPageRequest()));
    expect(exactPageResponse.status).toBe(200);
    expect(yield* Effect.tryPromise(() => exactPageResponse.json())).toEqual({
      appId: 'inventory-stock',
      componentKey: 'testing.pages.page-customers',
      entrypointKey: 'testing.pages.page.customers',
      moduleId: 'testing.pages',
      writable: true,
    });
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
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedPageCatalog()),
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
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedPageCatalog()),
      false,
      Layer.succeed(ContextAccess, {
        ...legalEntitySelectionOptions.contextAccess,
        modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
          Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key }))),
      }),
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
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
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
                principal: {
                  authBindingId: '45000000-0000-4000-8000-000000000001',
                  authContextRef: 'better-auth-session:45000000-0000-4000-8000-000000000001',
                  authMethod: 'session' as const,
                  legalEntityId: fixtureLegalEntityId,
                  principalId: current.identity.principalId,
                  tenantId: current.identity.tenantId,
                },
                setCookieHeaders: ['refreshed-session=value; Path=/; HttpOnly'],
                state: 'authenticated' as const,
              }),
      }),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['testing1'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
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
        loadAudiences: Effect.succeed(new Set(['testing1'])),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
      Layer.succeed(TenantModuleStateService, unavailableModuleStates),
      Effect.succeed(installedPageCatalog()),
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
          body: JSON.stringify({ audience: 'inventory-stock' }),
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
      loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
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
      makeGatewayIssuerLayer(issuerDependencies),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(issuingHandler);
    const assertionResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock' }),
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
    const generatedVerifierPath = path.join(generatedFixtureRoot, 'action-principal.ts');
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
      }),
    );
    expect(generatedPrincipal.authBindingId).toBe(fixtureAuthBindingId);
    expect(optionalText(generatedPrincipal.authContextRef)).toMatch(/^better-auth-session:/u);
    expect(generatedPrincipal.authMethod).toBe('session');
    expect(generatedPrincipal.legalEntityId).toBe(fixtureLegalEntityId);
    expect(generatedPrincipal.principalId).toBe(principalId);
    expect(generatedPrincipal.tenantId).toBe(tenantId);
    const invalidAudienceResponse = yield* Effect.tryPromise(() =>
      issuingHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'billing' }),
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
      }),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(defectHandler);
    const defectResponse = yield* Effect.tryPromise(() =>
      defectHandler.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock' }),
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
    const multiContextAccessLayer = Layer.succeed(ContextAccess, multiLegalEntitySelectionOptions.contextAccess);
    const multiAuthenticationContextLayer = Layer.mergeAll(
      multiContextAccessLayer,
      Layer.succeed(LegalEntityContext, multiLegalEntitySelectionOptions.legalEntityContext),
    );
    const configuration = yield* loadAuthConfig();
    const databaseConnections = yield* loadDatabaseConnectionPair();
    const adminPool = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: databaseConnections.admin.connectionString,
          }),
      ),
      (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
    );
    const corePool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: configuration.connectionString })),
      (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
    );
    const coreDatabase = yield* makeTestDatabaseFromPool(corePool, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const adminAuthDatabase = yield* makeTestDatabaseFromPool(adminPool, authRelations);
    const resolver = makePrincipalResolver({ executor: coreDatabase });
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
      { moduleKey: 'first-module', state: 'active', tenantId: firstTenantId },
      { moduleKey: 'second-module', state: 'active', tenantId: secondTenantId },
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
    const runtime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, authentication),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
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
      }),
      moduleStateLayer,
      Effect.succeed(installedCatalog(['first-module', 'second-module'])),
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
    const resolverUnavailableRuntime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, resolverUnavailableAuthentication),
      makeGatewayIssuerLayer({
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000002'),
        loadAudiences: Effect.succeed(new Set()),
        loadConfig: parseGatewayIssuerConfig({}),
      }),
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
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const assertionResponse = yield* Effect.tryPromise(() =>
      runtime.handler(
        new Request(`${configuration.baseUrl}/auth/gateway-context`, {
          body: JSON.stringify({ audience: 'inventory-stock' }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: authenticatedCookie,
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      ),
    );
    const { principal: verifiedPrincipal } = yield* verifiedGatewayAssertion(assertionResponse, pair.publicKey);
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
  }),
);
