import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';
import {
  PrincipalResolverUnavailableError,
  ContextAccess,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
  buildInstalledModuleCatalog,
  loadDatabaseConnectionPair,
  makePrincipalResolver,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import type { InstalledModuleCatalog } from '@app/core-runtime';
import {
  coreDatabaseSchema,
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import type { GatewayIssuerDependencies } from '../../api/auth/gateway-issuer.ts';
import { account, authDatabaseSchema, session, user } from '../../api/auth/db/schema.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { renderActionPrincipalServer } from '../../../../scripts/scaffolding/microvertical-action-boundary/scaffold.mts';

const email = 'better-auth-runtime@example.test';
const password = 'correct-horse-battery-staple';
const tenantId = '30000000-0000-4000-8000-000000000001';
const foreignTenantId = '30000000-0000-4000-8000-000000000002';
const principalId = '40000000-0000-4000-8000-000000000001';
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const fixtureLegalEntityId = '35000000-0000-4000-8000-000000000001';
const fixtureAuthBindingId = '45000000-0000-4000-8000-000000000001';

const IdentityResponseSchema = Schema.Struct({
  identity: Schema.Struct({ email: Schema.String, principalId: Schema.String }),
});
const ProblemStatusSchema = Schema.Struct({ status: Schema.Number });
const SessionResponseSchema = Schema.Struct({
  identity: Schema.optional(Schema.Struct({ principalId: Schema.optional(Schema.String) })),
});
const RetryableProblemSchema = Schema.Struct({ retryable: Schema.optional(Schema.Boolean) });
const TokenResponseSchema = Schema.Struct({ token: Schema.String });
const DefectProblemSchema = Schema.Struct({ detail: Schema.optional(Schema.String) });

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
      Effect.succeed([{ legalEntityId: fixtureLegalEntityId, legalName: 'Fixture legal entity' }]),
    validateSelection: (_tenantId: string, legalEntityId: string) =>
      legalEntityId === fixtureLegalEntityId
        ? Effect.succeed({ legalEntityId, legalName: 'Fixture legal entity' })
        : Effect.die('missing fixture legal entity'),
  },
} as const;
const contextAccessLayer = Layer.succeed(ContextAccess, legalEntitySelectionOptions.contextAccess);

const cookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.map((header) => header.split(';')[0]).join('; ');

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
        deployment: { appId: 'inventory-stock', buildMarker: 'integration-build' },
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

test('creates, resolves, persists, revokes, and signs out a Better Auth session', async () => {
  const configuration = await Effect.runPromise(loadAuthConfig());
  const corePool = new Pool({ connectionString: configuration.connectionString });
  const authPool = new Pool({ connectionString: configuration.connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
  const resolver = makePrincipalResolver({ executor: coreDatabase });
  const authentication = makeAuthenticationService(configuration, authDatabase, resolver, {
    allowFixtureSignUp: true,
    ...legalEntitySelectionOptions,
  });
  const authenticationLayer = Layer.succeed(AuthenticationService, authentication);
  const moduleStateLayer = Layer.succeed(
    TenantModuleStateService,
    makeTenantModuleStateService({ executor: coreDatabase }),
  );
  const handlers: { readonly dispose: () => Promise<void> }[] = [];
  const generatedFixtureRoot = await mkdtemp(path.join(tmpdir(), 'ontos-auth-runtime-'));

  const cleanup = async () => {
    await coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
    await coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    await coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));

    await Promise.all(
      existingUsers.map(async (existingUser) => {
        await coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, existingUser.id));
        await authDatabase.delete(session).where(eq(session.userId, existingUser.id));
        await authDatabase.delete(account).where(eq(account.userId, existingUser.id));
        await authDatabase.delete(user).where(eq(user.id, existingUser.id));
      }),
    );

    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.principalId, principalId));
    await coreDatabase.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId));
    await coreDatabase
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, foreignTenantId));
    await coreDatabase.delete(principals).where(eq(principals.principalId, principalId));
    await coreDatabase
      .delete(legalEntities)
      .where(eq(legalEntities.legalEntityId, fixtureLegalEntityId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, foreignTenantId));
  };

  try {
    await cleanup();
    const betterAuthUserId = await Effect.runPromise(
      authentication.createFixtureUser(email, 'Runtime fixture', password),
    );
    await coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Authentication runtime tenant',
      slug: 'authentication-runtime-tenant',
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Foreign authentication runtime tenant',
      slug: 'foreign-authentication-runtime-tenant',
      status: 'active',
      tenantId: foreignTenantId,
    });
    await coreDatabase.insert(principals).values({
      displayName: 'Runtime fixture',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(legalEntities).values({
      legalEntityId: fixtureLegalEntityId,
      legalName: 'Fixture legal entity',
      registrationCountry: 'CZ',
      registrationNumber: 'AUTH-RUNTIME-1',
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principalAuthBindings).values({
      principalAuthBindingId: fixtureAuthBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    await coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'testing1', state: 'active', tenantId },
      { moduleKey: 'testing.pages', state: 'active', tenantId },
      { moduleKey: 'stale-non-installed', state: 'active', tenantId },
      { moduleKey: 'inactive-installed', state: 'suspended', tenantId },
      { moduleKey: 'testing1', state: 'active', tenantId: foreignTenantId },
    ]);

    const requestHeaders = new Headers({
      origin: configuration.baseUrl,
    });
    const invalid = await Effect.runPromise(
      Effect.flip(authentication.signIn(email, 'wrong-password', requestHeaders)),
    );
    assert.equal(invalid._tag, 'InvalidCredentialsError');

    const anonymousRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
      contextAccessLayer,
    );
    const unavailableHandler = anonymousRuntime.createHandler();
    handlers.push(unavailableHandler);
    const anonymousGatewayResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: { 'content-type': 'application/json', origin: configuration.baseUrl },
        method: 'POST',
      }),
    );
    assert.equal(anonymousGatewayResponse.status, 401);
    assert.match(anonymousGatewayResponse.headers.get('www-authenticate') ?? '', /^Bearer/u);

    const anonymousModulesResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, {
        headers: { origin: configuration.baseUrl },
      }),
    );
    assert.equal(anonymousModulesResponse.status, 401);
    assert.match(anonymousModulesResponse.headers.get('www-authenticate') ?? '', /^Bearer/u);
    const anonymousPageResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/shell/module-target`, {
        body: JSON.stringify({
          entrypointKey: 'testing.pages.page.customers',
          moduleId: 'testing.pages',
        }),
        headers: { 'content-type': 'application/json', origin: configuration.baseUrl },
        method: 'POST',
      }),
    );
    assert.equal(anonymousPageResponse.status, 401);
    assert.match(anonymousPageResponse.headers.get('www-authenticate') ?? '', /^Bearer/u);

    const signInResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/sign-in`, {
        body: JSON.stringify({ email, password }),
        headers: { 'content-type': 'application/json', origin: configuration.baseUrl },
        method: 'POST',
      }),
    );
    assert.equal(signInResponse.status, 200);
    const signedIn = Schema.decodeUnknownSync(IdentityResponseSchema)(await signInResponse.json());
    const signedInCookies = signInResponse.headers.getSetCookie();
    assert.equal(signedIn.identity.email, email);
    assert.equal(signedIn.identity.principalId, principalId);
    assert.ok(signedInCookies.length > 0);

    const authenticatedHeaders = new Headers({
      cookie: cookieHeader(signedInCookies),
      origin: configuration.baseUrl,
    });
    const exactPageRequest = (entrypointKey = 'testing.pages.page.customers') =>
      new Request(`${configuration.baseUrl}/shell/module-target`, {
        body: JSON.stringify({ entrypointKey, moduleId: 'testing.pages' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedHeaders.get('cookie') ?? '',
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      });
    const current = await Effect.runPromise(authentication.currentSession(authenticatedHeaders));
    assert.equal(current.identity?.tenantId, tenantId);
    assert.notEqual(current.identity, undefined);

    const pageRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000009'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      moduleStateLayer,
      Effect.succeed(installedPageCatalog()),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(pageRuntime);
    const exactPageResponse = await pageRuntime.handler(exactPageRequest());
    assert.equal(exactPageResponse.status, 200);
    assert.deepEqual(await exactPageResponse.json(), {
      appId: 'inventory-stock',
      componentKey: 'testing.pages.page-customers',
      entrypointKey: 'testing.pages.page.customers',
      moduleId: 'testing.pages',
      writable: true,
    });
    const missingPageResponse = await pageRuntime.handler(
      exactPageRequest('testing.pages.page.missing'),
    );
    assert.equal(missingPageResponse.status, 404);

    const authenticatedContext = await Effect.runPromise(
      authentication.resolveShellContext(authenticatedHeaders),
    );
    assert.equal(authenticatedContext.state, 'authenticated');
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
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000010'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      moduleStateLayer,
      Effect.succeed(installedPageCatalog()),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(selectionRequiredRuntime);
    const selectionRequiredPageResponse =
      await selectionRequiredRuntime.handler(exactPageRequest());
    assert.equal(selectionRequiredPageResponse.status, 409);
    assert.equal(
      Schema.decodeUnknownSync(ProblemStatusSchema)(await selectionRequiredPageResponse.json())
        .status,
      409,
    );

    const deniedPageRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000011'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
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
    const deniedPageResponse = await deniedPageRuntime.handler(exactPageRequest());
    assert.equal(deniedPageResponse.status, 403);
    assert.equal(
      Schema.decodeUnknownSync(ProblemStatusSchema)(await deniedPageResponse.json()).status,
      403,
    );

    const currentSessionResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/session`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(currentSessionResponse.status, 200);
    assert.equal(
      Schema.decodeUnknownSync(SessionResponseSchema)(await currentSessionResponse.json()).identity
        ?.principalId,
      principalId,
    );

    const missingIdempotencyResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/identity/api-keys/self`, {
        body: JSON.stringify({ name: 'must-not-be-created' }),
        headers: {
          'content-type': 'application/json',
          cookie: authenticatedHeaders.get('cookie') ?? '',
          origin: configuration.baseUrl,
        },
        method: 'POST',
      }),
    );
    assert.equal(missingIdempotencyResponse.status, 428);

    const deniedIdentityAdministrationRuntime = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000002'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
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
              decision:
                permission === 'manage_identity' ? ('denied' as const) : ('allowed' as const),
              key,
            })),
          ),
      }),
    ).createHandler();
    handlers.push(deniedIdentityAdministrationRuntime);
    const deniedIdentityAdministrationResponse = await deniedIdentityAdministrationRuntime.handler(
      new Request(`${configuration.baseUrl}/auth/identity/principals`, {
        body: JSON.stringify({ displayName: 'Denied managed identity', kind: 'service' }),
        headers: {
          'content-type': 'application/json',
          cookie: authenticatedHeaders.get('cookie') ?? '',
          'idempotency-key': 'denied-managed-identity',
          origin: configuration.baseUrl,
        },
        method: 'POST',
      }),
    );
    assert.equal(deniedIdentityAdministrationResponse.status, 403);
    const [deniedIdentityInvocation] = await coreDatabase
      .select({
        actionInvocationId: actionInvocations.actionInvocationId,
        status: actionInvocations.status,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'denied-managed-identity'))
      .limit(1);
    assert.equal(deniedIdentityInvocation?.status, 'rejected');
    if (deniedIdentityInvocation === undefined) {
      throw new Error('The denied identity Action did not persist its invocation');
    }
    const [deniedIdentityAudit] = await coreDatabase
      .select({
        eventType: auditEvents.eventType,
        outcomeCode: auditEvents.outcomeCode,
      })
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, deniedIdentityInvocation.actionInvocationId))
      .limit(1);
    assert.deepEqual(deniedIdentityAudit, {
      eventType: 'action.rejected',
      outcomeCode: 'spicedb_permission_denied',
    });

    const activeModulesResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(activeModulesResponse.status, 200);
    assert.deepEqual(await activeModulesResponse.json(), {
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const [compositionEvidence] = await coreDatabase
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
    assert.deepEqual(compositionEvidence, {
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
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['testing1'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
      false,
      contextAccessLayer,
    ).createHandler();
    handlers.push(refreshingRuntime);
    const refreshedModulesResponse = await refreshingRuntime.handler(
      new Request(`${configuration.baseUrl}/shell/composition`),
    );
    assert.equal(refreshedModulesResponse.status, 200);
    assert.ok(
      refreshedModulesResponse.headers
        .getSetCookie()
        .some((header) => header.startsWith('refreshed-session=value')),
    );

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
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['testing1'])),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      Layer.succeed(TenantModuleStateService, unavailableModuleStates),
      Effect.succeed(installedPageCatalog()),
      false,
      contextAccessLayer,
      undefined,
      () => unavailableModuleStates,
    ).createHandler();
    handlers.push(unavailableModulesHandler);
    const unavailableModulesResponse = await unavailableModulesHandler.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(unavailableModulesResponse.status, 503);
    const unavailableModulesProblem = await unavailableModulesResponse.text();
    assert.doesNotMatch(unavailableModulesProblem, /SQL|30000000|40000000/u);
    const unavailablePageResponse = await unavailableModulesHandler.handler(exactPageRequest());
    assert.equal(unavailablePageResponse.status, 503);
    assert.equal(
      Schema.decodeUnknownSync(ProblemStatusSchema)(await unavailablePageResponse.json()).status,
      503,
    );

    const unavailableGatewayResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(unavailableGatewayResponse.status, 503);
    assert.match(
      unavailableGatewayResponse.headers.get('content-type') ?? '',
      /application\/problem\+json/u,
    );
    assert.equal(
      Schema.decodeUnknownSync(RetryableProblemSchema)(await unavailableGatewayResponse.json())
        .retryable,
      true,
    );

    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const issuerDependencies: GatewayIssuerDependencies = {
      currentTimeSeconds: Effect.succeed(1_700_000_000),
      generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
      loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
      loadConfig: Effect.succeed({
        issuer: 'https://shell.example.test',
        privateJwk: {
          alg: 'EdDSA',
          crv: 'Ed25519',
          d: privateJwk.d ?? '',
          kid: 'integration-current',
          kty: 'OKP',
          use: 'sig',
          x: privateJwk.x ?? '',
        },
      }),
    };
    const issuingHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      issuerDependencies,
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
    ).createHandler();
    handlers.push(issuingHandler);
    const assertionResponse = await issuingHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(assertionResponse.status, 200);
    const assertion = Schema.decodeUnknownSync(TokenResponseSchema)(await assertionResponse.json());
    const verifiedAssertion = await jwtVerify(assertion.token, pair.publicKey, {
      algorithms: ['EdDSA'],
      audience: 'inventory-stock',
      currentDate: new Date(1_700_000_001_000),
      issuer: 'https://shell.example.test',
    });
    const verifiedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
      verifiedAssertion.payload['principal'],
    );
    assert.equal(verifiedPrincipal.authBindingId, fixtureAuthBindingId);
    assert.match(verifiedPrincipal.authContextRef ?? '', /^better-auth-session:/u);
    assert.equal(verifiedPrincipal.authMethod, 'session');
    assert.equal(verifiedPrincipal.legalEntityId, fixtureLegalEntityId);
    assert.equal(verifiedPrincipal.principalId, principalId);
    assert.equal(verifiedPrincipal.tenantId, tenantId);

    await mkdir(path.join(generatedFixtureRoot, 'node_modules', '@app'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime'),
      path.join(generatedFixtureRoot, 'node_modules/@app/core-runtime'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(generatedFixtureRoot, 'node_modules/@app/shared-contracts'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'node_modules/effect'),
      path.join(generatedFixtureRoot, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(generatedFixtureRoot, 'node_modules/jose'),
      'dir',
    );
    const generatedVerifierPath = path.join(generatedFixtureRoot, 'action-principal.ts');
    await writeFile(
      generatedVerifierPath,
      renderActionPrincipalServer({ appId: 'inventory-stock' }),
      'utf-8',
    );
    const generatedVerifier = await import(pathToFileURL(generatedVerifierPath).href);
    const { verifyActionPrincipal } = generatedVerifier;
    assert.ok(Predicate.isFunction(verifyActionPrincipal));
    const generatedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
      await Effect.runPromise(
        verifyActionPrincipal(`Bearer ${assertion.token}`, {
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
      ),
    );
    assert.equal(generatedPrincipal.authBindingId, fixtureAuthBindingId);
    assert.match(generatedPrincipal.authContextRef ?? '', /^better-auth-session:/u);
    assert.equal(generatedPrincipal.authMethod, 'session');
    assert.equal(generatedPrincipal.legalEntityId, fixtureLegalEntityId);
    assert.equal(generatedPrincipal.principalId, principalId);
    assert.equal(generatedPrincipal.tenantId, tenantId);

    const invalidAudienceResponse = await issuingHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'billing' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(invalidAudienceResponse.status, 400);

    const defectHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        ...issuerDependencies,
        generateJti: Effect.die(new Error('deliberate gateway test defect')),
      },
      moduleStateLayer,
      Effect.succeed(installedCatalog(['testing1'])),
    ).createHandler();
    handlers.push(defectHandler);
    const defectResponse = await defectHandler.handler(
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
    );
    assert.equal(defectResponse.status, 500);
    assert.match(defectResponse.headers.get('content-type') ?? '', /application\/problem\+json/u);
    const defectProblem = Schema.decodeUnknownSync(DefectProblemSchema)(
      await defectResponse.json(),
    );
    assert.equal(defectProblem.detail, 'Gateway authentication could not complete.');
    assert.doesNotMatch(JSON.stringify(defectProblem), /deliberate gateway test defect/u);

    const stillAuthenticated = await Effect.runPromise(
      authentication.currentSession(authenticatedHeaders),
    );
    assert.equal(stillAuthenticated.identity?.principalId, principalId);

    await coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: new Date('2026-09-01T00:00:00.000Z'), status: 'revoked' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const revoked = await Effect.runPromise(
      Effect.flip(authentication.currentSession(authenticatedHeaders)),
    );
    assert.equal(revoked._tag, 'OntosIdentityForbiddenError');
    const forbiddenModulesResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(forbiddenModulesResponse.status, 401);
    assert.match(forbiddenModulesResponse.headers.get('www-authenticate') ?? '', /^Bearer/u);
    assert.doesNotMatch(await forbiddenModulesResponse.text(), /30000000|40000000/u);

    await coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const signOutResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/sign-out`, {
        headers: authenticatedHeaders,
        method: 'POST',
      }),
    );
    assert.equal(signOutResponse.status, 200);
    const signedOutCookies = signOutResponse.headers.getSetCookie();
    assert.ok(signedOutCookies.length >= 3);
    assert.ok(signedOutCookies.every((header) => !header.includes(password)));

    const anonymous = await Effect.runPromise(
      authentication.currentSession(
        new Headers({
          cookie: cookieHeader(signedOutCookies),
          origin: configuration.baseUrl,
        }),
      ),
    );
    assert.equal(anonymous.identity, null);
    const expiredModulesResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(expiredModulesResponse.status, 401);
    assert.doesNotMatch(await expiredModulesResponse.text(), /30000000|40000000/u);
  } finally {
    await Promise.all(handlers.map(async ({ dispose }) => await dispose()));
    await rm(generatedFixtureRoot, { force: true, recursive: true });
    await cleanup();
    await Promise.all([authPool.end(), corePool.end()]);
  }
});

test('selects, lists, switches, revalidates, and upgrades a multi-tenant session', async () => {
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
    [secondTenantId, { legalEntityId: secondLegalEntityId, legalName: 'Second legal entity' }],
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
  const multiContextAccessLayer = Layer.succeed(
    ContextAccess,
    multiLegalEntitySelectionOptions.contextAccess,
  );
  const configuration = await Effect.runPromise(loadAuthConfig());
  const databaseConnections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({
    connectionString: databaseConnections.admin.connectionString,
  });
  const corePool = new Pool({ connectionString: configuration.connectionString });
  const authPool = new Pool({ connectionString: configuration.connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
  const adminAuthDatabase = drizzle({ client: adminPool, schema: authDatabaseSchema });
  const resolver = makePrincipalResolver({ executor: coreDatabase });
  const authentication = makeAuthenticationService(configuration, authDatabase, resolver, {
    allowFixtureSignUp: true,
    ...multiLegalEntitySelectionOptions,
  });
  const moduleStateLayer = Layer.succeed(
    TenantModuleStateService,
    makeTenantModuleStateService({ executor: coreDatabase }),
  );
  const handlers: { readonly dispose: () => Promise<void> }[] = [];

  const cleanup = async () => {
    await coreDatabase
      .delete(dataAccessEvents)
      .where(inArray(dataAccessEvents.tenantId, [firstTenantId, secondTenantId]));
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, multiEmail));
    const existingUserIds = existingUsers.map(({ id }) => id);
    if (existingUserIds.length > 0) {
      await coreDatabase
        .delete(principalAuthBindings)
        .where(inArray(principalAuthBindings.providerSubjectId, existingUserIds));
      await authDatabase.delete(session).where(inArray(session.userId, existingUserIds));
      await authDatabase.delete(account).where(inArray(account.userId, existingUserIds));
      await authDatabase.delete(user).where(inArray(user.id, existingUserIds));
    }
    await coreDatabase
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, firstTenantId));
    await coreDatabase
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, secondTenantId));
    await coreDatabase.delete(principals).where(eq(principals.principalId, firstPrincipalId));
    await coreDatabase.delete(principals).where(eq(principals.principalId, secondPrincipalId));
    await coreDatabase
      .delete(legalEntities)
      .where(inArray(legalEntities.legalEntityId, [firstLegalEntityId, secondLegalEntityId]));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, firstTenantId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, secondTenantId));
  };

  try {
    await cleanup();
    const betterAuthUserId = await Effect.runPromise(
      authentication.createFixtureUser(multiEmail, 'Multi tenant fixture', password),
    );
    await coreDatabase.insert(tenants).values([
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
    await coreDatabase.insert(principals).values([
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
    await coreDatabase.insert(legalEntities).values([
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
    await coreDatabase.insert(principalAuthBindings).values([
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
    await coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'first-module', state: 'active', tenantId: firstTenantId },
      { moduleKey: 'second-module', state: 'active', tenantId: secondTenantId },
    ]);

    const signIn = await Effect.runPromise(
      authentication.signIn(multiEmail, password, new Headers({ origin: configuration.baseUrl })),
    );
    assert.equal(signIn.identity.tenantId, firstTenantId);
    assert.equal(signIn.identity.principalId, firstPrincipalId);
    const authenticatedCookie = cookieHeader(signIn.setCookieHeaders);
    const authenticatedHeaders = new Headers({
      cookie: authenticatedCookie,
      origin: configuration.baseUrl,
    });
    const initialSessions = await authDatabase
      .select({ activeTenantId: session.activeTenantId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(initialSessions[0]?.activeTenantId, firstTenantId);

    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const runtime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, authentication),
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
        loadConfig: Effect.succeed({
          issuer: 'https://shell.example.test',
          privateJwk: {
            alg: 'EdDSA',
            crv: 'Ed25519',
            d: privateJwk.d ?? '',
            kid: 'multi-tenant-current',
            kty: 'OKP',
            use: 'sig',
            x: privateJwk.x ?? '',
          },
        }),
      },
      moduleStateLayer,
      Effect.succeed(installedCatalog(['first-module', 'second-module'])),
      false,
      multiContextAccessLayer,
    ).createHandler();
    handlers.push(runtime);

    const anonymousAvailableResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/tenants`, {
        headers: { origin: configuration.baseUrl },
      }),
    );
    assert.equal(anonymousAvailableResponse.status, 401);
    assert.match(anonymousAvailableResponse.headers.get('www-authenticate') ?? '', /^Bearer /u);

    const availableResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/tenants`, { headers: authenticatedHeaders }),
    );
    assert.equal(availableResponse.status, 200);
    assert.deepEqual(await availableResponse.json(), {
      tenants: [
        { name: 'Alpha tenant', tenantId: secondTenantId },
        { name: 'Zeta tenant', tenantId: firstTenantId },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(authentication.availableTenants(authenticatedHeaders)),
      /principalId|sessionId|token|bindingId|password/u,
    );

    const firstModules = await runtime.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, { headers: authenticatedHeaders }),
    );
    assert.deepEqual(await firstModules.json(), {
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });

    const forbiddenResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
        body: JSON.stringify({ tenantId: '31000000-0000-4000-8000-000000000099' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(forbiddenResponse.status, 403);
    const sessionsAfterForbiddenSwitch = await authDatabase
      .select({ activeTenantId: session.activeTenantId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(sessionsAfterForbiddenSwitch[0]?.activeTenantId, firstTenantId);

    await coreDatabase
      .update(principals)
      .set({ status: 'disabled' })
      .where(eq(principals.principalId, secondPrincipalId));
    const inactiveTargetResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
        body: JSON.stringify({ tenantId: secondTenantId }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(inactiveTargetResponse.status, 403);
    const sessionsAfterInactiveSwitch = await authDatabase
      .select({ activeTenantId: session.activeTenantId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(sessionsAfterInactiveSwitch[0]?.activeTenantId, firstTenantId);
    await coreDatabase
      .update(principals)
      .set({ status: 'active' })
      .where(eq(principals.principalId, secondPrincipalId));

    const resolverUnavailableAuthentication = makeAuthenticationService(
      configuration,
      authDatabase,
      {
        ...resolver,
        resolveBetterAuthUserForTenant: (userId, selectedTenantId) =>
          selectedTenantId === secondTenantId
            ? Effect.fail(
                new PrincipalResolverUnavailableError({ reason: 'Injected resolver outage' }),
              )
            : resolver.resolveBetterAuthUserForTenant(userId, selectedTenantId),
      },
      multiLegalEntitySelectionOptions,
    );
    const resolverUnavailableRuntime = makeShellAuthenticationApiRuntime(
      Layer.succeed(AuthenticationService, resolverUnavailableAuthentication),
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('61000000-0000-4000-8000-000000000002'),
        loadAudiences: Effect.succeed(new Set()),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      moduleStateLayer,
    ).createHandler();
    handlers.push(resolverUnavailableRuntime);
    const resolverUnavailableResponse = await resolverUnavailableRuntime.handler(
      new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
        body: JSON.stringify({ tenantId: secondTenantId }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(resolverUnavailableResponse.status, 503);
    const sessionsAfterResolverFailure = await authDatabase
      .select({ activeTenantId: session.activeTenantId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(sessionsAfterResolverFailure[0]?.activeTenantId, firstTenantId);

    // Drizzle has no query-builder failure injection. This temporary trigger raises PostgreSQL's
    // connection-failure class for the fixed test tenant through the real Better Auth adapter path.
    await adminAuthDatabase.execute(
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
    await adminAuthDatabase.execute(
      sql.raw(`
        CREATE TRIGGER tenant_switch_test_persistence_failure
        BEFORE UPDATE ON auth.session
        FOR EACH ROW
        EXECUTE FUNCTION auth.tenant_switch_test_fail_persistence()
      `),
    );
    try {
      const persistenceUnavailableResponse = await runtime.handler(
        new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
          body: JSON.stringify({ tenantId: secondTenantId }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: authenticatedCookie,
            origin: configuration.baseUrl,
          }),
          method: 'POST',
        }),
      );
      assert.equal(persistenceUnavailableResponse.status, 503);
      const sessionsAfterPersistenceFailure = await authDatabase
        .select({ activeTenantId: session.activeTenantId })
        .from(session)
        .where(eq(session.userId, betterAuthUserId));
      assert.equal(sessionsAfterPersistenceFailure[0]?.activeTenantId, firstTenantId);
    } finally {
      await adminAuthDatabase.execute(
        sql.raw(`
          DROP TRIGGER IF EXISTS tenant_switch_test_persistence_failure ON auth.session
        `),
      );
      await adminAuthDatabase.execute(
        sql.raw(`
          DROP FUNCTION IF EXISTS auth.tenant_switch_test_fail_persistence()
        `),
      );
    }

    const sessionsBeforeSwitch = await authDatabase
      .select({ activeLegalEntityId: session.activeLegalEntityId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(sessionsBeforeSwitch[0]?.activeLegalEntityId, firstLegalEntityId);

    const switchResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
        body: JSON.stringify({ tenantId: secondTenantId }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(switchResponse.status, 200);
    assert.deepEqual(await switchResponse.json(), { selectedTenantId: secondTenantId });
    const sessionsAfterSwitch = await authDatabase
      .select({
        activeLegalEntityId: session.activeLegalEntityId,
        activeTenantId: session.activeTenantId,
      })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(sessionsAfterSwitch[0]?.activeTenantId, secondTenantId);
    assert.equal(sessionsAfterSwitch[0]?.activeLegalEntityId, null);
    const currentSessionAfterSwitch = await Effect.runPromise(
      authentication.currentSession(authenticatedHeaders),
    );
    assert.equal(currentSessionAfterSwitch.identity?.principalId, secondPrincipalId);
    const idempotentSwitch = await Effect.runPromise(
      authentication.switchTenant(secondTenantId, authenticatedHeaders),
    );
    assert.equal(idempotentSwitch.selectedTenantId, secondTenantId);

    const secondModules = await runtime.handler(
      new Request(`${configuration.baseUrl}/shell/composition`, { headers: authenticatedHeaders }),
    );
    assert.deepEqual(await secondModules.json(), {
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    const assertionResponse = await runtime.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: authenticatedCookie,
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    const assertion = Schema.decodeUnknownSync(TokenResponseSchema)(await assertionResponse.json());
    const verified = await jwtVerify(assertion.token, pair.publicKey, {
      algorithms: ['EdDSA'],
      audience: 'inventory-stock',
      currentDate: new Date(1_700_000_001_000),
      issuer: 'https://shell.example.test',
    });
    const verifiedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
      verified.payload['principal'],
    );
    assert.equal(verifiedPrincipal.authBindingId, secondAuthBindingId);
    assert.match(verifiedPrincipal.authContextRef ?? '', /^better-auth-session:/u);
    assert.equal(verifiedPrincipal.authMethod, 'session');
    assert.equal(verifiedPrincipal.legalEntityId, secondLegalEntityId);
    assert.equal(verifiedPrincipal.principalId, secondPrincipalId);
    assert.equal(verifiedPrincipal.tenantId, secondTenantId);

    // A non-unavailability persistence rejection is an unexpected defect. The real Better Auth
    // adapter must roll it back, while each owning HTTP boundary logs and returns a redacted 500.
    await adminAuthDatabase.execute(
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
    await adminAuthDatabase.execute(
      sql.raw(`
        CREATE TRIGGER tenant_switch_test_internal_persistence_failure
        BEFORE UPDATE ON auth.session
        FOR EACH ROW
        EXECUTE FUNCTION auth.tenant_switch_test_fail_internal_persistence()
      `),
    );
    try {
      const unexpectedSwitchResponse = await runtime.handler(
        new Request(`${configuration.baseUrl}/auth/tenant/switch`, {
          body: JSON.stringify({ tenantId: firstTenantId }),
          headers: new Headers({
            'content-type': 'application/json',
            cookie: authenticatedCookie,
            origin: configuration.baseUrl,
            'x-correlation-id': 'unexpected-switch-persistence-test',
          }),
          method: 'POST',
        }),
      );
      assert.equal(unexpectedSwitchResponse.status, 500);
      assert.doesNotMatch(
        await unexpectedSwitchResponse.text(),
        /secret auth persistence defect|P0001/u,
      );
      const sessionsAfterUnexpectedSwitchFailure = await authDatabase
        .select({ activeTenantId: session.activeTenantId })
        .from(session)
        .where(eq(session.userId, betterAuthUserId));
      assert.equal(sessionsAfterUnexpectedSwitchFailure[0]?.activeTenantId, secondTenantId);

      await authDatabase
        .update(session)
        .set({ activeTenantId: null })
        .where(eq(session.userId, betterAuthUserId));
      const unexpectedLegacyUpgradeResponse = await runtime.handler(
        new Request(`${configuration.baseUrl}/auth/session`, {
          headers: new Headers({
            cookie: authenticatedCookie,
            origin: configuration.baseUrl,
            'x-correlation-id': 'unexpected-legacy-upgrade-test',
          }),
        }),
      );
      assert.equal(unexpectedLegacyUpgradeResponse.status, 500);
      assert.doesNotMatch(
        await unexpectedLegacyUpgradeResponse.text(),
        /secret auth persistence defect|P0001/u,
      );
      const sessionsAfterUnexpectedLegacyUpgrade = await authDatabase
        .select({ activeTenantId: session.activeTenantId })
        .from(session)
        .where(eq(session.userId, betterAuthUserId));
      assert.equal(sessionsAfterUnexpectedLegacyUpgrade[0]?.activeTenantId, null);
    } finally {
      await adminAuthDatabase.execute(
        sql.raw(`
          DROP TRIGGER IF EXISTS tenant_switch_test_internal_persistence_failure ON auth.session
        `),
      );
      await adminAuthDatabase.execute(
        sql.raw(`
          DROP FUNCTION IF EXISTS auth.tenant_switch_test_fail_internal_persistence()
        `),
      );
    }

    const upgradedSession = await Effect.runPromise(
      authentication.currentSession(authenticatedHeaders),
    );
    assert.equal(upgradedSession.identity?.tenantId, firstTenantId);
    const upgradedSessionRows = await authDatabase
      .select({ activeTenantId: session.activeTenantId })
      .from(session)
      .where(eq(session.userId, betterAuthUserId));
    assert.equal(upgradedSessionRows[0]?.activeTenantId, firstTenantId);

    await Effect.runPromise(authentication.switchTenant(secondTenantId, authenticatedHeaders));
    await coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: new Date('2026-09-01T00:00:00.000Z'), status: 'revoked' })
      .where(eq(principalAuthBindings.tenantId, secondTenantId));
    const revokedSession = await Effect.runPromise(
      Effect.flip(authentication.currentSession(authenticatedHeaders)),
    );
    assert.equal(revokedSession._tag, 'OntosIdentityForbiddenError');
    await coreDatabase
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(eq(principalAuthBindings.tenantId, secondTenantId));
    const restoredSession = await Effect.runPromise(
      authentication.currentSession(authenticatedHeaders),
    );
    assert.equal(restoredSession.identity?.tenantId, secondTenantId);

    // Production evidence retains referenced bindings. Clear only this fixture's evidence so the
    // resolver can still prove that an existing selected session rejects a genuinely missing row.
    await coreDatabase
      .delete(dataAccessEvents)
      .where(eq(dataAccessEvents.tenantId, secondTenantId));
    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, secondTenantId));
    const sessionWithRemovedBinding = await Effect.runPromise(
      Effect.flip(authentication.currentSession(authenticatedHeaders)),
    );
    assert.equal(sessionWithRemovedBinding._tag, 'OntosIdentityForbiddenError');
  } finally {
    await Promise.all(handlers.map(async ({ dispose }) => await dispose()));
    await cleanup();
    await Promise.all([adminPool.end(), authPool.end(), corePool.end()]);
  }
});
