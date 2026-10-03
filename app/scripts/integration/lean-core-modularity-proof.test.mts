import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { and, eq, inArray } from 'drizzle-orm';
import { Config, ConfigProvider, Context, DateTime, Duration, Effect, FileSystem, Layer, Ref, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { NetAddress } from 'effect/unstable/net';
import { expect, it } from 'effect-rstest';
import { decodeJwt } from 'jose';

import { createSharedRuntimeConfig } from '../../module-federation.shared.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { validateActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../../packages/core-runtime/src/modules/application-composition.ts';
import {
  ONTOS_MODULE_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';

import { makeActionRepository } from '../../packages/core-runtime/src/actions/repository.ts';
import { ActionRuntime, makeActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import { AuthenticationNamespaceRegistrationSchema } from '../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import {
  PrincipalManagementRepository,
  principalManagementRepositoryFromTransaction,
} from '../../packages/core-runtime/src/auth/principal-management.ts';
import { PrincipalResolver, makePrincipalResolver } from '../../packages/core-runtime/src/auth/principal-resolver.ts';
import {
  SupportRecoveryPrincipalContextResolver,
  makeSupportRecoveryPrincipalContextResolver,
} from '../../packages/core-runtime/src/auth/support-recovery-principal-context.ts';
import {
  actionInvocations,
  applicationCompositionAuthority,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../packages/core-runtime/src/operations/context.ts';
import { openActionRuntimeOptions } from '../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  ContextAccess,
  toLegalEntityAccessObjectId,
} from '../../packages/core-runtime/src/permissions/context-access.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import {
  GatewayContextResponseSchema,
  GatewayContextV2ClaimsSchema,
} from '../../packages/shared-contracts/src/gateway-context.ts';
import { AuthConfig, loadAuthConfig } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import {
  account,
  apikey,
  session,
  supportImpersonationRecovery,
  user,
} from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import {
  makeSupportAuthProvider,
  makeSupportImpersonationService,
  makeSupportImpersonationStore,
  SupportAuthProviderService,
  SupportImpersonationCorrelationId,
  SupportImpersonationStoreService,
} from '../../apps/shell-super-app/api/auth/impersonation-service.ts';
import { AuthenticationService, makeAuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';

const gatewayAudience = 'party-registry';

class LeanCoreCompositionFixtureError extends Schema.TaggedError<LeanCoreCompositionFixtureError>()(
  'LeanCoreCompositionFixtureError',
  { reason: Schema.String },
) {}

const fixtureError = (reason: string) => new LeanCoreCompositionFixtureError({ reason });
const artifact = (url: string, document: string) => ({ bytes: new TextEncoder().encode(document), url });
const packageVersionJson = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }));
const topologyIdentityJson = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({
      deliveryUnit: Schema.Struct({
        buildMarker: Schema.NonEmptyString,
        unitId: Schema.Literal('app/shell-super-app'),
      }),
    }),
  }),
);

/** Local admission claims for the isolated API-only audience, not deployed browser artifact evidence. */
const acquireLeanCoreComposition = Effect.fn('LeanCoreProof.acquireComposition')(function* acquireComposition() {
  const documents = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Ref.get(documents).pipe(
        Effect.map((current) => {
          if (request.method !== 'GET') {
            return HttpServerResponse.empty({ status: 405 });
          }
          const document = current.get(request.url);
          return document === undefined
            ? HttpServerResponse.empty({ status: 404 })
            : HttpServerResponse.text(document, {
                contentType: 'application/json',
                headers: { 'cache-control': 'no-store' },
              });
        }),
      ),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* fixtureError('The composition fixture must bind one native loopback TCP server');
  }
  const origin = `http://127.0.0.1:${server.address.port}`;
  const workspaceRoot = nodePath.resolve(import.meta.dirname, '../..');
  const fileSystem = yield* FileSystem.FileSystem;
  const { shell } = yield* Schema.decodeEffect(topologyIdentityJson)(
    yield* fileSystem.readFileString(nodePath.join(workspaceRoot, 'topology/reference-topology.json')),
  );
  const identity = yield* Effect.try({
    catch: () => fixtureError('The Shell fixture requires a native release identity'),
    try: () =>
      resolveUltramodernReleaseIdentity({
        generationBuildMarker: shell.deliveryUnit.buildMarker,
        unitId: shell.deliveryUnit.unitId,
        workspaceRoot,
      }),
  });
  const localRequire = createRequire(pathToFileURL(nodePath.join(workspaceRoot, 'apps/shell-super-app/package.json')));
  const versions = yield* Effect.forEach(
    ['@modern-js/plugin-i18n', '@modern-js/runtime', '@tanstack/react-router', 'react', 'react-dom'],
    (name) =>
      Effect.gen(function* readInstalledSingleton() {
        const filename = yield* Effect.try({
          catch: () => fixtureError('A native Shell singleton package could not be resolved'),
          try: () => localRequire.resolve(`${name}/package.json`),
        });
        const { version } = yield* Schema.decodeEffect(packageVersionJson)(yield* fileSystem.readFileString(filename));
        return version;
      }),
    { concurrency: 1 },
  );
  const [i18n, runtime, router, react, reactDom] = versions;
  const shared = Object.entries(
    createSharedRuntimeConfig({
      '@modern-js/plugin-i18n/runtime': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(i18n),
      '@modern-js/runtime': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(runtime),
      '@tanstack/react-router': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(router),
      react: yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(react),
      'react-dom': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(reactDom),
    }),
  ).map(([name, value]) => ({ name, requiredVersion: value.requiredVersion, singleton: value.singleton }));
  const moduleContract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    deployment: { appId: gatewayAudience, buildMarker: `lean-core-api-only-${identity.buildMarker}` },
    manifest: {
      activation: {
        defaultState: 'inactive',
        preservesHistoryWhenInactive: true,
        scope: 'tenant',
        supportedStates: ['inactive', 'active'],
      },
      module: {
        description: 'Isolated API-only modularity proof audience.',
        displayName: 'Party proof audience',
        id: 'party.registry',
        implementedAs: 'ultramodern_microvertical',
        kind: 'business_module',
      },
      publicSurface: {
        actions: [],
        api: [],
        businessPermissions: [],
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
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    moduleContract,
  );
  const shellContract = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    createShellRuntimeContract(identity.buildMarker),
  );
  const shellManifest = JSON.stringify({ exposes: [], name: 'shellSuperApp', shared });
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'development',
    modules: [
      {
        appId: gatewayAudience,
        backend: { baseUrl: `${origin}/`, transport: 'node-http' },
        contract: artifact(`${origin}${ONTOS_MODULE_CONTRACT_PATH}`, contractDocument),
      },
    ],
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: artifact(`${origin}/mf-manifest.json`, shellManifest),
      runtimeContract: artifact(`${origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`, shellContract),
    },
    validity: Duration.minutes(30),
  });
  const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
  const [runtimeUrl, adminUrl] = yield* Effect.all([
    Config.String('DATABASE_URL'),
    Config.String('DATABASE_ADMIN_URL'),
  ]);
  const connections = yield* parseDatabaseConnectionPair({ DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: runtimeUrl });
  if (
    connections.admin.host !== connections.runtime.host ||
    connections.admin.port !== connections.runtime.port ||
    connections.admin.database !== connections.runtime.database
  ) {
    return yield* fixtureError('The modularity proof requires one explicit administrative and runtime database');
  }
  const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
  const adminDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
  yield* Effect.acquireRelease(
    adminDatabase.transaction((transaction) =>
      Effect.gen(function* publishFixtureAuthority() {
        yield* lockApplicationCompositionPublication(transaction);
        const existing = yield* transaction.select().from(applicationCompositionAuthority);
        if (existing.length !== 0) {
          yield* fixtureError('The modularity proof requires an empty native composition authority');
        }
        yield* publishApplicationCompositionAuthority(transaction, approved);
      }),
    ),
    () =>
      adminDatabase
        .transaction((transaction) =>
          Effect.gen(function* cleanupFixtureAuthority() {
            yield* lockApplicationCompositionPublication(transaction);
            const rows = yield* transaction.select().from(applicationCompositionAuthority);
            const [current] = rows;
            if (
              rows.length !== 1 ||
              current?.revision !== approved.composition.revision ||
              current.validUntil.getTime() !== DateTime.toEpochMillis(approved.validUntil) ||
              current.phase !== 'active' ||
              current.durableWorkAdmission !== 'open'
            ) {
              yield* fixtureError('The modularity proof no longer owns the native composition authority');
            }
            yield* transaction
              .delete(applicationCompositionAuthority)
              .where(
                and(
                  eq(applicationCompositionAuthority.authorityKey, 'active'),
                  eq(applicationCompositionAuthority.revision, approved.composition.revision),
                  eq(applicationCompositionAuthority.validUntil, DateTime.toDateUtc(approved.validUntil)),
                  eq(applicationCompositionAuthority.phase, 'active'),
                  eq(applicationCompositionAuthority.durableWorkAdmission, 'open'),
                ),
              );
          }),
        )
        .pipe(Effect.orDie),
  );
  yield* Ref.set(
    documents,
    new Map([
      ['/active', encoded],
      [ONTOS_MODULE_CONTRACT_PATH, contractDocument],
      [ONTOS_SHELL_RUNTIME_CONTRACT_PATH, shellContract],
      ['/mf-manifest.json', shellManifest],
    ]),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const buildMarker = Object.getOwnPropertyDescriptor(globalThis, 'ULTRAMODERN_BUILD_MARKER');
      const sourceRevision = Object.getOwnPropertyDescriptor(globalThis, 'ULTRAMODERN_SOURCE_REVISION');
      Reflect.set(globalThis, 'ULTRAMODERN_BUILD_MARKER', identity.buildMarker);
      Reflect.set(globalThis, 'ULTRAMODERN_SOURCE_REVISION', identity.sourceRevision);
      return { buildMarker, sourceRevision };
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, descriptor] of [
          ['ULTRAMODERN_BUILD_MARKER', previous.buildMarker],
          ['ULTRAMODERN_SOURCE_REVISION', previous.sourceRevision],
        ] as const) {
          if (descriptor === undefined) {
            Reflect.deleteProperty(globalThis, name);
          } else {
            Object.defineProperty(globalThis, name, descriptor);
          }
        }
      }),
  );
  expect(approved.composition.modules.map(({ deployment }) => deployment.appId)).toEqual([gatewayAudience]);
  expect(approved.composition.modules[0]?.federation.execution).toBe('server');
  return {
    configuration: ConfigProvider.fromUnknown({ ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${origin}/active` }).pipe(
      ConfigProvider.orElse(ConfigProvider.fromEnv()),
    ),
    revision: approved.composition.revision,
    targetBuildMarker: moduleContract.deployment.buildMarker,
  };
});

const principalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const tenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const authBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AuthBindingId'));

const isolatedSignInResponseSchema = Schema.Struct({
  identity: Schema.Struct({
    email: Schema.String,
    principalId: principalIdSchema,
    tenantId: tenantIdSchema,
  }),
});
const authenticatedSessionResponseSchema = Schema.Struct({
  identity: Schema.Struct({
    legalEntityId: legalEntityIdSchema,
    principalId: principalIdSchema,
    tenantId: tenantIdSchema,
  }),
  state: Schema.Literal('authenticated'),
});
const apiKeyIssueResponseSchema = Schema.Struct({
  authBindingId: authBindingIdSchema,
  cleanupPending: Schema.Boolean,
  enabled: Schema.Boolean,
  secret: Schema.String,
});
const externalIdentityForbiddenProblemSchema = Schema.Struct({
  _tag: Schema.Literal('ExternalIdentityForbiddenProblem'),
  status: Schema.Literal(403),
});

type SpiceDbClient = ReturnType<typeof v1.NewClient>;
type SpiceDbRelationshipOperation = v1.RelationshipUpdate_Operation;

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({
      objectId: resourceId,
      objectType: resourceType,
    }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: subjectId,
        objectType: subjectType,
      }),
    }),
  });

const writeSpiceDbRelationships = (
  client: SpiceDbClient,
  relationships: readonly v1.Relationship[],
  operation: SpiceDbRelationshipOperation,
) =>
  Effect.tryPromise(() =>
    client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation,
            relationship: item,
          }),
        ),
      }),
    ),
  );

const cookieHeader = (setCookieHeaders: readonly string[]): string => {
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0) {
      cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join('; ');
};

const mergeResponseCookies = (current: string, response: Response): string => {
  const merged = cookieHeader([
    ...(current.length === 0 ? [] : current.split('; ').map((pair) => `${pair};`)),
    ...response.headers.getSetCookie(),
  ]);
  return merged;
};

const requestFor = (
  baseUrl: string,
  path: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET' | 'POST';
  },
) => {
  const headers = new Headers({
    origin: baseUrl,
    'x-correlation-id': randomUUID(),
    ...options.headers,
  });
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${baseUrl}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method,
  });
};

it.live(
  'proves the default Shell runtime starts and serves staff authentication without Commerce',
  Effect.fnUntraced(function* leanCoreModularityProof() {
    const composition = yield* acquireLeanCoreComposition();
    const configuration = yield* loadAuthConfig();
    const coreClient = yield* makeTestPgClient(configuration.connectionString);
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const authPersistence = yield* makeAuthDatabase(configuration);
    const authDatabase = authPersistence.executor;
    const resolver = makePrincipalResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
    );
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );

    const tenantId = randomUUID();
    const principalId = randomUUID();
    const legalEntityId = randomUUID();
    const authBindingId = randomUUID();
    const email = `lean-core-modularity-${randomUUID()}@example.test`;
    const password = randomUUID();
    // T27: a second staff principal used to exercise support/impersonation recovery.
    let supportTargetUserId = '';
    const supportTargetPrincipalId = randomUUID();
    const supportTargetAuthBindingId = randomUUID();
    const supportTargetEmail = `lean-core-support-target-${randomUUID()}@example.test`;

    const spiceDbConfiguration = yield* loadSpiceDbConfig();
    const spiceDbClient = yield* Effect.acquireRelease(
      Effect.sync(() => newSpiceDbGrpcClient(spiceDbConfiguration)),
      (client) => Effect.sync(() => client.close()),
    );
    const legalEntityAccessObjectId = toLegalEntityAccessObjectId(tenantId, legalEntityId);
    if (legalEntityAccessObjectId === undefined) {
      return yield* Effect.die('The modularity fixture legal-entity object ID could not be encoded');
    }
    const bindSelfApiKeyActionObjectId = toSpiceDbActionObjectId('core.identity.bind-self-api-key');
    const spiceDbRelationships = [
      relationship('tenant', tenantId, 'member', 'principal', principalId),
      relationship('legal_entity', legalEntityAccessObjectId, 'tenant', 'tenant', tenantId),
      relationship('legal_entity', legalEntityAccessObjectId, 'member', 'principal', principalId),
      relationship('action', bindSelfApiKeyActionObjectId, 'executor', 'principal', principalId),
    ];
    const cleanup = Effect.fnUntraced(function* cleanupLeanCoreModularityFixture() {
      yield* writeSpiceDbRelationships(spiceDbClient, spiceDbRelationships, v1.RelationshipUpdate_Operation.DELETE);
      yield* purgeFixtureRows([
        authDatabase.delete(supportImpersonationRecovery).where(eq(supportImpersonationRecovery.tenantId, tenantId)),
        coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
        coreDatabase.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
        coreDatabase.delete(principals).where(eq(principals.tenantId, tenantId)),
        coreDatabase.delete(legalEntities).where(eq(legalEntities.legalEntityId, legalEntityId)),
        coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId)),
      ]);
      const users = yield* authDatabase
        .select({ id: user.id })
        .from(user)
        .where(inArray(user.email, [email, supportTargetEmail]));
      yield* Effect.forEach(
        users,
        ({ id }) =>
          purgeFixtureRows([
            authDatabase.delete(apikey).where(eq(apikey.referenceId, id)),
            authDatabase.delete(session).where(eq(session.userId, id)),
            authDatabase.delete(account).where(eq(account.userId, id)),
            authDatabase.delete(user).where(eq(user.id, id)),
          ]),
        { concurrency: 1, discard: true },
      );
    });
    yield* Effect.acquireRelease(Effect.void, () => cleanup().pipe(Effect.orDie));

    const betterAuthUserId = yield* authentication.createFixtureUser(email, 'Lean Core Modularity', password);
    yield* coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Lean Core Modularity Tenant',
      slug: `lean-core-modularity-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principals).values({
      displayName: 'Lean Core Modularity User',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Lean Core Modularity Legal Entity',
      registrationCountry: 'CZ',
      registrationNumber: `LCM-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principalAuthBindings).values({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: authBindingId,
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });
    yield* writeSpiceDbRelationships(spiceDbClient, spiceDbRelationships, v1.RelationshipUpdate_Operation.TOUCH);

    const shellApi = yield* Effect.tryPromise(() => import('../../apps/shell-super-app/api/index.ts'));
    const configuredShellApi = defineEffectBff({
      ...shellApi.default,
      layer: shellApi.default.layer.pipe(Layer.provide(ConfigProvider.layer(composition.configuration))),
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => configuredShellApi.createHandler()),
      (createdHandler) => Effect.tryPromise(() => createdHandler.dispose()).pipe(Effect.orDie),
    );

    const signInResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/sign-in', {
          body: { email, password },
          method: 'POST',
        }),
      ),
    );
    expect(signInResponse.status).toBe(200);
    const signIn = Schema.decodeUnknownSync(isolatedSignInResponseSchema)(
      yield* Effect.tryPromise(() => signInResponse.json()),
    );
    expect(signIn.identity.email).toBe(email);
    expect(signIn.identity.principalId).toBe(principalId);
    expect(signIn.identity.tenantId).toBe(tenantId);
    let cookies = cookieHeader(signInResponse.headers.getSetCookie());
    expect(cookies.length > 0).toBe(true);

    const sessionResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/session', {
          headers: { cookie: cookies },
          method: 'GET',
        }),
      ),
    );
    expect(sessionResponse.status).toBe(200);
    cookies = mergeResponseCookies(cookies, sessionResponse);
    const currentSession = Schema.decodeUnknownSync(authenticatedSessionResponseSchema)(
      yield* Effect.tryPromise(() => sessionResponse.json()),
    );
    expect(currentSession.identity.principalId).toBe(principalId);
    expect(currentSession.identity.tenantId).toBe(tenantId);
    expect(currentSession.identity.legalEntityId).toBe(legalEntityId);

    // T27: the staff binding created for sign-in carries the staff authentication namespace.
    const [staffBindingRow] = yield* coreDatabase
      .select({ authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId })
      .from(principalAuthBindings)
      .where(eq(principalAuthBindings.principalAuthBindingId, authBindingId));
    expect(STAFF_AUTHENTICATION_NAMESPACE_ID).toBe('ontos.staff.better-auth.v1');
    expect(staffBindingRow?.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);

    const apiKeyResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/identity/api-keys/self', {
          body: { name: 'lean-core-key' },
          headers: {
            cookie: cookies,
            'idempotency-key': randomUUID(),
          },
          method: 'POST',
        }),
      ),
    );
    expect(apiKeyResponse.status).toBe(200);
    const issuedApiKey = Schema.decodeUnknownSync(apiKeyIssueResponseSchema)(
      yield* Effect.tryPromise(() => apiKeyResponse.json()),
    );
    expect(issuedApiKey.enabled).toBe(true);
    expect(issuedApiKey.cleanupPending).toBe(false);
    // T27: the issued self API key binds to a fresh binding id, distinct from the session binding.
    expect(issuedApiKey.authBindingId).not.toBe(authBindingId);

    const gatewayResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/api-key/gateway-context', {
          body: { audience: gatewayAudience, compositionRevision: composition.revision },
          headers: { 'x-api-key': issuedApiKey.secret },
          method: 'POST',
        }),
      ),
    );
    expect(gatewayResponse.status).toBe(200);
    const gateway = Schema.decodeUnknownSync(GatewayContextResponseSchema)(
      yield* Effect.tryPromise(() => gatewayResponse.json()),
    );
    const gatewayClaims = Schema.decodeUnknownSync(GatewayContextV2ClaimsSchema)(decodeJwt(gateway.token));
    // T27: the API-key gateway context (v2) resolves for the freshly issued self API key.
    expect(gateway.compositionRevision).toBe(composition.revision);
    expect(gatewayClaims.compositionRevision).toBe(composition.revision);
    expect(gatewayClaims.targetBuildMarker).toBe(composition.targetBuildMarker);
    expect(gatewayClaims.aud).toBe(gatewayAudience);
    expect(gatewayClaims.principal.authMethod).toBe('api_key');
    expect(gatewayClaims.principal.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
    expect(gatewayClaims.principal.principalId).toBe(principalId);
    expect(gatewayClaims.principal.tenantId).toBe(tenantId);
    expect(gatewayClaims.principal.authBindingId).toBe(issuedApiKey.authBindingId);

    const absentExternalIdentityResponse = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/identity/external/resolve', {
          body: {
            authenticationNamespaceId: 'unknown.absent.better-auth.v1',
            authenticationRef: `lean-core-absent-${randomUUID()}`,
            compositionRevision: composition.revision,
            providerSubjectId: `absent-provider-subject-${randomUUID()}`,
            subjectType: 'user',
          },
          headers: { 'x-api-key': issuedApiKey.secret },
          method: 'POST',
        }),
      ),
    );
    expect(absentExternalIdentityResponse.status).toBe(403);
    expect(
      Schema.decodeUnknownSync(externalIdentityForbiddenProblemSchema)(
        yield* Effect.tryPromise(() => absentExternalIdentityResponse.json()),
      ).status,
    ).toBe(403);

    const sessionAfterAbsentCapability = yield* Effect.tryPromise(() =>
      handler.handler(
        requestFor(configuration.baseUrl, '/auth/session', {
          headers: { cookie: cookies },
          method: 'GET',
        }),
      ),
    );
    expect(sessionAfterAbsentCapability.status).toBe(200);

    // T27: staff support recovery (the support/impersonation contract exercised in
    // identity-modes-runtime.test.ts) still works for a Shell runtime composed without Commerce.
    supportTargetUserId = yield* authentication.createFixtureUser(
      supportTargetEmail,
      'Lean Core Support Target',
      randomUUID(),
    );
    yield* coreDatabase.insert(principals).values({
      displayName: 'Lean Core Support Target',
      kind: 'human',
      principalId: supportTargetPrincipalId,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principalAuthBindings).values({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: supportTargetAuthBindingId,
      principalId: supportTargetPrincipalId,
      provider: 'better_auth',
      providerSubjectId: supportTargetUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });

    const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
      Schema.decodeUnknownSync(AuthenticationNamespaceRegistrationSchema)({
        allowedAudiences: [gatewayAudience],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        provider: 'better-auth',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user', 'api_key'],
        trustedAttesterPrincipalIds: [],
      }),
    ]);
    const provideAuthenticationNamespaceRegistry = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>,
    ) => effect.pipe(Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry));
    const principalManagementRepository = principalManagementRepositoryFromTransaction(
      coreDatabase,
      STAFF_AUTHENTICATION_NAMESPACE_ID,
    );
    const providePrincipalManagementRepository = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>,
    ) =>
      provideAuthenticationNamespaceRegistry(
        effect.pipe(Effect.provideService(PrincipalManagementRepository, principalManagementRepository)),
      );
    const allowedContextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: ({ tenantIds }: { readonly permission: string; readonly tenantIds: readonly string[] }) =>
        Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
    };
    const provideContextAccess = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>,
    ) =>
      provideAuthenticationNamespaceRegistry(effect.pipe(Effect.provideService(ContextAccess, allowedContextAccess)));
    const operationalScope = makeOperationalScopeResolver(
      makeOperationalScopeRepository({ executor: coreDatabase }),
      allowedContextAccess,
    );
    const supportActionRuntime = makeActionRuntime(
      { executor: coreDatabase },
      makeActionRepository(),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      operationalScope,
      { ...openActionRuntimeOptions, contextAccess: allowedContextAccess },
    );
    const supportRecoveryPrincipal = makeSupportRecoveryPrincipalContextResolver(
      { executor: coreDatabase },
      { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
    );
    const supportConfiguration = { ...configuration, supportUserIds: [betterAuthUserId] };
    const supportAuthentication = yield* makeAuthenticationService({}).pipe(
      Effect.provideService(AuthConfig, supportConfiguration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    const support = makeSupportImpersonationService(
      Context.empty().pipe(
        Context.add(ActionRuntime, supportActionRuntime),
        Context.add(AuthenticationService, supportAuthentication),
        Context.add(AuthConfig, supportConfiguration),
        Context.add(PrincipalResolver, resolver),
        Context.add(SupportRecoveryPrincipalContextResolver, supportRecoveryPrincipal),
        Context.add(SupportAuthProviderService, makeSupportAuthProvider(supportConfiguration, authPersistence.adapter)),
        Context.add(SupportImpersonationStoreService, makeSupportImpersonationStore(authDatabase)),
      ),
    );
    const started = yield* provideContextAccess(
      providePrincipalManagementRepository(
        support
          .start({
            idempotencyKey: randomUUID(),
            reason: 'T27 lean-core staff support recovery proof',
            requestHeaders: new Headers({ cookie: cookies, origin: configuration.baseUrl }),
            targetPrincipalId: supportTargetPrincipalId,
          })
          .pipe(Effect.provideService(SupportImpersonationCorrelationId, randomUUID())),
      ),
    );
    expect(started.active).toBe(true);
    const impersonatedHeaders = new Headers({
      cookie: cookieHeader(started.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const impersonated = yield* provideContextAccess(supportAuthentication.resolveTenantContext(impersonatedHeaders));
    expect(impersonated.state).toBe('authenticated');
    if (impersonated.state === 'authenticated') {
      expect(impersonated.principal.authMethod).toBe('support_impersonation');
      expect(impersonated.principal.principalId).toBe(supportTargetPrincipalId);
      expect(impersonated.principal.impersonatedByPrincipalId).toBe(principalId);
    }
    const stopped = yield* provideContextAccess(
      providePrincipalManagementRepository(
        support
          .stop({
            idempotencyKey: randomUUID(),
            requestHeaders: impersonatedHeaders,
          })
          .pipe(Effect.provideService(SupportImpersonationCorrelationId, randomUUID())),
      ),
    );
    expect(stopped.checkpointPending).toBe(false);

    return yield* Effect.void;
  }, Effect.provide(NodeServices.layer)),
);
