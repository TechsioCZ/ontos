import {
  ActiveApplicationCompositionSnapshotSchema,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
  validateActiveApplicationCompositionSnapshot,
  TrustedPrincipalContextSchema,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  makePrincipalResolver,
  PrincipalResolver,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '@app/core-runtime';
import {
  executePartyContactPointDetailWithAuthorization,
  PartyContactPointDetailAuthenticationProblemSchema,
} from '@app/party-registry/api/client';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  makeLiveOperationFixture,
  publishTestApplicationCompositionAuthority,
  testCoreDatabase,
} from '@app/core-runtime/testing/owner-evidence';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { v1 } from '@authzed/authzed-node';
import { getCookies } from 'better-auth/cookies';
import { Config, Crypto, DateTime, Duration, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Cookies, HttpBody, HttpClient } from 'effect/http';
import type { ChildProcessHandle } from 'effect/process/ChildProcessSpawner';
import { expect, it } from 'effect-rstest';

import { eq, inArray } from 'drizzle-orm';

import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../../../../scripts/active-application-composition.mts';
import { startNativeHttpServer } from '../support/native-http-server.ts';

import { AuthConfig, parseAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, user } from '../../api/auth/db/schema.ts';
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import {
  ApiKeyIssueResponseSchema,
  AuthenticatedSessionSchema,
  CurrentSessionSchema,
  PrincipalMutationResponseSchema,
  ShellAuthenticationRequiredProblemSchema,
  SignInResponseSchema,
} from '../../shared/api.ts';
import {
  allocateLoopbackPort,
  PackagedOwnerStartupError,
  startPackagedApplication,
} from '../support/server-owner-relay-native-fixture.ts';

// Catalog's emitted public product-detail contract declares this shared Problem Details schema.
const CatalogProductAuthenticationProblemSchema = makeProblemDetailsSchema('ProductDetailAuthenticationProblem', 401);

const makePackagedShellUserFixture = Effect.fn('ServerOwnerRelayNative.makePackagedShellUserFixture')(
  function* makePackagedShellUserFixture(compositionUrl?: string) {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const issuerConfiguration = yield* loadDatabaseConfig({
      envPath: '/dev/null',
      identity: SHELL_GATEWAY_ISSUER_IDENTITY,
    });
    const issuerClient = yield* PgClient.make({ url: Redacted.make(issuerConfiguration.connectionString) });
    const issuerRoles = yield* issuerClient`select current_user::text as role`;
    expect(issuerRoles).toEqual([{ role: 'shell_gateway_issuer' }]);
    yield* Effect.logInfo('Dedicated Shell issuer fixture connection verified', { role: issuerConfiguration.user });
    const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
    const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
    const core = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionKeys: ['core.identity.create-non-human-principal', 'core.identity.bind-managed-api-key'],
        adminConnectionString: Redacted.make(connections.admin.connectionString),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        // Seed-only configuration; no authority is published and core.layer is never provided.
        compositionRevision: 'a'.repeat(64),
        enabledModuleIds: ['commerce.catalog'],
        runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
      }),
      (fixture) => fixture.close(),
    );
    const crypto = yield* Crypto.Crypto;
    const secret = Redacted.make(yield* crypto.randomUUIDv4());
    const password = Redacted.make(yield* crypto.randomUUIDv4());
    const port = yield* allocateLoopbackPort();
    const origin = `http://localhost:${port}`;
    const configuration = yield* parseAuthConfig({
      BETTER_AUTH_SECRET: Redacted.value(secret),
      BETTER_AUTH_URL: origin,
      DATABASE_URL: connections.runtime.connectionString,
      NODE_ENV: 'production',
    });
    const persistence = yield* makeAuthDatabase(configuration);
    const resolver = makePrincipalResolver(
      { executor: database },
      { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
    );
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, persistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    const email = `packaged-${core.manager.authBindingId}@example.test`;
    const generatedId = yield* Effect.acquireRelease(
      authentication.createFixtureUser(email, 'Native packaged manager', password),
      (id) =>
        persistence.executor
          .delete(user)
          .where(inArray(user.id, [id, core.manager.authBindingId]))
          .pipe(Effect.orDie),
    );
    yield* persistence.executor.transaction(
      Effect.fn('ServerOwnerRelayNative.alignAuthSubject')(function* alignAuthSubject(transaction) {
        const [generated] = yield* transaction.select().from(user).where(eq(user.id, generatedId));
        if (generated === undefined) {
          return yield* new PackagedOwnerStartupError({ reason: 'Actual fixture Auth user was not persisted' });
        }
        yield* transaction
          .update(user)
          .set({ email: `relocated-${generatedId}@example.test` })
          .where(eq(user.id, generatedId));
        yield* transaction.insert(user).values({ ...generated, email, id: core.manager.authBindingId });
        yield* transaction
          .update(account)
          .set({ accountId: core.manager.authBindingId, userId: core.manager.authBindingId })
          .where(eq(account.userId, generatedId));
        yield* transaction.delete(user).where(eq(user.id, generatedId));
        return yield* Effect.void;
      }),
    );
    const spice = yield* Config.all({
      caCertificate: Config.String('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      preSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    const applicationInput = {
      appId: 'shell-super-app',
      authentication: {
        baseUrl: origin,
        connectionString: Redacted.make(connections.runtime.connectionString),
        issuerConnectionString: Redacted.make(issuerConfiguration.connectionString),
        port,
        secret,
        spice,
      },
      relativeDirectory: '.',
    } satisfies Parameters<typeof startPackagedApplication>[0];
    if (compositionUrl !== undefined) {
      Object.assign(applicationInput, { compositionUrl });
    }
    const application = yield* startPackagedApplication(applicationInput);
    return { application, configuration, core, email, origin, password, persistence, resolver };
  },
);

const grantNativeIdentityAdministration = Effect.fn('ServerOwnerRelayNative.grantIdentityAdministration')(
  function* grantNativeIdentityAdministration(core: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>) {
    const config = yield* Config.all({
      certificate: Config.String('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    const spice = yield* Effect.acquireRelease(
      Effect.sync(() =>
        v1.NewClientWithCustomCert(Redacted.value(config.key), config.endpoint, Buffer.from(config.certificate)),
      ),
      (client) => Effect.sync(() => client.close()),
    );
    const relationship = v1.Relationship.create({
      relation: 'identity_admin',
      resource: { objectId: core.tenantId, objectType: 'tenant' },
      subject: { object: { objectId: core.manager.principalId, objectType: 'principal' } },
    });
    const write = (operation: v1.RelationshipUpdate_Operation) =>
      Effect.tryPromise({
        catch: () =>
          new PackagedOwnerStartupError({ reason: 'Native identity administration permission write failed' }),
        try: () =>
          spice.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [v1.RelationshipUpdate.create({ operation, relationship })],
            }),
          ),
      });
    yield* Effect.acquireRelease(write(v1.RelationshipUpdate_Operation.TOUCH), () =>
      write(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie),
    );
    const permission = yield* Effect.tryPromise({
      catch: () =>
        new PackagedOwnerStartupError({ reason: 'Native identity administration fully-consistent check failed' }),
      try: () =>
        spice.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: v1.Consistency.create({
              requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
            }),
            permission: 'manage_identity',
            resource: { objectId: core.tenantId, objectType: 'tenant' },
            subject: { object: { objectId: core.manager.principalId, objectType: 'principal' } },
          }),
        ),
    });
    expect(permission.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
  },
);

it.live('starts the real packaged Shell, exposes its compiled contract and API prefix, and terminates its child', () =>
  Effect.gen(function* packagedShellStartup() {
    let startedChild: ChildProcessHandle | undefined;
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* checkPackagedShell() {
          const fixture = yield* startPackagedApplication({ appId: 'shell-super-app', relativeDirectory: '.' });
          startedChild = fixture.child;
          yield* Effect.logInfo('Packaged Shell child ready', {
            origin: fixture.origin,
            pid: fixture.child.pid,
            sourceRevision: fixture.compiled.sourceRevision,
          });
          expect(yield* fixture.child.isRunning).toBe(true);
          const client = yield* HttpClient.HttpClient;
          const contractResponse = yield* client.get(`${fixture.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`);
          const contractBody = yield* contractResponse.json;
          yield* Effect.logInfo('Packaged Shell contract HTTP observation', {
            array: Schema.is(Schema.Array(Schema.Unknown))(contractBody),
            null: contractBody === null,
            object: Schema.is(Schema.Struct({}))(contractBody),
            origin: fixture.origin,
            status: contractResponse.status,
            string: Schema.is(Schema.String)(contractBody),
          });
          expect(contractResponse.status).toBe(200);
          const contract = yield* Schema.decodeUnknownEffect(OntosShellRuntimeContractSchema)(contractBody);
          expect(contract.deployment).toEqual({ appId: 'shell-super-app', buildMarker: fixture.compiled.buildMarker });
          const sessionResponse = yield* client.get(`${fixture.origin}${fixture.apiPrefix}/auth/session`);
          yield* Effect.logInfo('Packaged Shell API prefix observation', { status: sessionResponse.status });
          expect(sessionResponse.status).toBe(200);
          const session = yield* sessionResponse.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CurrentSessionSchema)),
          );
          expect(session).toEqual({ state: 'anonymous' });
        }),
      ),
    );
    if (startedChild !== undefined) {
      const running = yield* startedChild.isRunning;
      yield* Effect.logInfo('Packaged Shell scoped child release', { pid: startedChild.pid, running });
      expect(running).toBe(false);
    }
    if (Exit.isFailure(result)) {
      yield* Effect.failCause(result.cause);
    }
  }).pipe(
    Effect.timeout('25 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  ),
);

it.live('starts the real packaged Party receiver, serves its contract and refuses an unauthenticated public read', () =>
  Effect.gen(function* packagedPartyStartup() {
    let startedChild: ChildProcessHandle | undefined;
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* checkPackagedParty() {
          const fixture = yield* startPackagedApplication({
            appId: 'party-registry',
            relativeDirectory: '../../verticals/party-registry',
          });
          startedChild = fixture.child;
          expect(yield* fixture.child.isRunning).toBe(true);
          const client = yield* HttpClient.HttpClient;
          const contractResponse = yield* client.get(`${fixture.origin}${ONTOS_MODULE_CONTRACT_PATH}`);
          expect(contractResponse.status).toBe(200);
          const contract = yield* contractResponse.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)),
          );
          expect(contract.deployment).toEqual({ appId: 'party-registry', buildMarker: fixture.compiled.buildMarker });
          expect(contract.manifest.module.id).toBe('party.registry');
          expect(fixture.apiPrefix).toBe('/party-registry-api');
          const failure = yield* Effect.flip(
            executePartyContactPointDetailWithAuthorization(
              {
                contactPointRef: {
                  moduleId: 'party.registry',
                  resourceId: '60000000-0000-4000-8000-000000000001',
                  resourceType: 'party.registry.party-contact-point',
                  tenantId: '50000000-0000-4000-8000-000000000001',
                },
              },
              '',
              'packaged-party-startup',
              { baseUrl: `${fixture.origin}${fixture.apiPrefix}` },
            ),
          );
          const problem = yield* Schema.decodeUnknownEffect(PartyContactPointDetailAuthenticationProblemSchema)(
            failure,
          );
          expect(problem.status).toBe(401);
          yield* Effect.logInfo('Packaged Party HTTP observations', {
            apiPrefix: fixture.apiPrefix,
            authenticationStatus: problem.status,
            buildMarker: fixture.compiled.buildMarker,
            contractStatus: contractResponse.status,
            origin: fixture.origin,
            pid: fixture.child.pid,
            sourceRevision: fixture.compiled.sourceRevision,
          });
        }),
      ),
    );
    if (startedChild !== undefined) {
      const running = yield* startedChild.isRunning;
      yield* Effect.logInfo('Packaged Party scoped child release', { pid: startedChild.pid, running });
      expect(running).toBe(false);
    }
    if (Exit.isFailure(result)) {
      yield* Effect.failCause(result.cause);
    }
  }).pipe(
    Effect.timeout('25 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  ),
);

it.live(
  'starts the real packaged Catalog receiver, serves its contract and refuses an unauthenticated public read',
  () =>
    Effect.gen(function* packagedCatalogStartup() {
      let startedChild: ChildProcessHandle | undefined;
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* checkPackagedCatalog() {
            const fixture = yield* startPackagedApplication({
              appId: 'catalog',
              relativeDirectory: '../../verticals/catalog',
            });
            startedChild = fixture.child;
            expect(yield* fixture.child.isRunning).toBe(true);
            const client = yield* HttpClient.HttpClient;
            const contractResponse = yield* client.get(`${fixture.origin}${ONTOS_MODULE_CONTRACT_PATH}`);
            expect(contractResponse.status).toBe(200);
            const contract = yield* contractResponse.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)),
            );
            expect(contract.deployment).toEqual({ appId: 'catalog', buildMarker: fixture.compiled.buildMarker });
            expect(contract.manifest.module.id).toBe('commerce.catalog');
            expect(fixture.apiPrefix).toBe('/catalog-api');
            const body = yield* HttpBody.json({
              locale: 'en',
              productRef: {
                moduleId: 'commerce.catalog',
                resourceId: '60000000-0000-4000-8000-000000000001',
                resourceType: 'commerce.catalog.product',
                tenantId: '50000000-0000-4000-8000-000000000001',
              },
            });
            // This path is declared by the packaged public shared/apis/product-detail.js contract.
            const response = yield* client.post(`${fixture.origin}${fixture.apiPrefix}/reads/product-detail`, {
              body,
              headers: { 'x-correlation-id': 'packaged-catalog-startup' },
            });
            expect(response.status).toBe(401);
            const problem = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(CatalogProductAuthenticationProblemSchema)),
            );
            yield* Effect.logInfo('Packaged Catalog HTTP observations', {
              apiPrefix: fixture.apiPrefix,
              authenticationStatus: problem.status,
              buildMarker: fixture.compiled.buildMarker,
              contractStatus: contractResponse.status,
              origin: fixture.origin,
              pid: fixture.child.pid,
              sourceRevision: fixture.compiled.sourceRevision,
            });
          }),
        ),
      );
      if (startedChild !== undefined) {
        const running = yield* startedChild.isRunning;
        yield* Effect.logInfo('Packaged Catalog scoped child release', { pid: startedChild.pid, running });
        expect(running).toBe(false);
      }
      if (Exit.isFailure(result)) {
        yield* Effect.failCause(result.cause);
      }
    }).pipe(
      Effect.timeout('25 seconds'),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
);

it.live('connects role-separated local databases and provisions the real public Core and Spice fixture', () =>
  Effect.gen(function* connectedCoreSpiceFixture() {
    let fixtureClosed = false;
    const recordFixtureClosed = Effect.sync(() => {
      fixtureClosed = true;
    });
    yield* Effect.scoped(
      Effect.gen(function* checkConnectedCoreSpiceFixture() {
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        expect(connections.runtime.user).toBe('ontos_runtime');
        expect(connections.admin.user).toBe('ontos_admin');
        const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
        const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
        const runtimeRoles = yield* runtime`select current_user::text as role`;
        const adminRoles = yield* admin`select current_user::text as role`;
        expect(runtimeRoles).toEqual([{ role: 'ontos_runtime' }]);
        expect(adminRoles).toEqual([{ role: 'ontos_admin' }]);
        const crypto = yield* Crypto.Crypto;
        const privateSecret = Redacted.make(yield* crypto.randomUUIDv4());
        const auth = yield* parseAuthConfig({
          BETTER_AUTH_SECRET: Redacted.value(privateSecret),
          BETTER_AUTH_URL: 'http://localhost:3020',
          DATABASE_URL: connections.runtime.connectionString,
          NODE_ENV: 'production',
        });
        expect(auth.baseUrl).toBe('http://localhost:3020');
        expect(auth.secureCookies).toBe(true);
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: ['core.identity.create-non-human-principal', 'core.identity.bind-managed-api-key'],
            adminConnectionString: Redacted.make(connections.admin.connectionString),
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            // Seed-only fixture configuration; no authority is published and fixture.layer is never provided.
            compositionRevision: 'a'.repeat(64),
            enabledModuleIds: ['commerce.catalog'],
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.andThen(recordFixtureClosed)),
        );
        const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
        const tenant = yield* database.query.tenants.findFirst({ where: { tenantId: fixture.tenantId } });
        expect(tenant?.status).toBe('active');
        const manager = yield* database.query.principals.findFirst({
          where: { principalId: fixture.manager.principalId },
        });
        expect(manager?.tenantId).toBe(fixture.tenantId);
        expect(manager?.kind).toBe('human');
        expect(manager?.status).toBe('active');
        const binding = yield* database.query.principalAuthBindings.findFirst({
          where: { principalAuthBindingId: fixture.manager.authBindingId },
        });
        expect(binding?.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
        expect(binding?.providerSubjectId).toBe(fixture.manager.authBindingId);
        expect(binding?.subjectType).toBe('user');
        const modules = yield* database.query.tenantModuleStates.findMany({ where: { tenantId: fixture.tenantId } });
        expect(modules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ moduleKey: 'party.registry', state: 'active' }),
            expect.objectContaining({ moduleKey: 'commerce.catalog', state: 'active' }),
          ]),
        );
        yield* Effect.logInfo('Real local Core and Spice fixture connections verified', {
          adminRole: connections.admin.user,
          authenticationNamespaceId: fixture.manager.authenticationNamespaceId,
          catalogEnabled: true,
          principalCount: 3,
          runtimeRole: connections.runtime.user,
          spiceRelationshipWriteSucceeded: true,
          tenantId: fixture.tenantId,
        });
      }),
    );
    expect(fixtureClosed).toBe(true);
    yield* Effect.logInfo('Real Core and Spice fixture resources closed', { fixtureClosed });
  }).pipe(Effect.timeout('45 seconds'), Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.live('signs a real Core-bound user into the actual packaged Shell and reads its authenticated session', () =>
  Effect.gen(function* packagedShellUserAuthentication() {
    let startedChild: ChildProcessHandle | undefined;
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* checkPackagedShellUserAuthentication() {
          const fixture = yield* makePackagedShellUserFixture();
          startedChild = fixture.application.child;
          const client = yield* HttpClient.HttpClient;
          const body = yield* HttpBody.json({ email: fixture.email, password: Redacted.value(fixture.password) });
          const response = yield* client.post(`${fixture.origin}${fixture.application.apiPrefix}/auth/sign-in`, {
            body,
            headers: { origin: fixture.origin },
          });
          if (response.status !== 200) {
            const failureBody = yield* response.text;
            const diagnostic = [
              failureBody,
              ...fixture.application.diagnostics.map((line) => Redacted.value(line)),
            ].join('\n');
            const categories = [
              'ConfigError',
              'DatabaseConfigError',
              'Service not found',
              'Cannot find module',
              'ERR_MODULE_NOT_FOUND',
              'ReferenceError',
              'TypeError',
              'ENOENT',
              'UNAUTHENTICATED',
              'PERMISSION_DENIED',
            ].filter((category) => diagnostic.includes(category));
            const keys = [
              ...new Set(
                [
                  ...diagnostic.matchAll(
                    /\b(?:APP_ENV_PATH|(?:BETTER_AUTH|DATABASE|SHELL_GATEWAY|ONTOS_GATEWAY|SPICEDB|ULTRAMODERN|ONTOS_APPLICATION|ONTOS_COMPOSITION)[A-Z0-9_]*)\b/gu,
                  ),
                ].map((match) => match[0]),
              ),
            ];
            const missingServices = [
              ...diagnostic.matchAll(
                /(?:Service not found|Cannot find module|No such service):?\s*['"]?(?<name>[@A-Za-z0-9_/.#-]+)/gu,
              ),
            ].map((match) => match.groups?.['name']);
            yield* Effect.logInfo('Sanitized packaged sign-in failure diagnostic', {
              bodyLength: failureBody.length,
              categories,
              childDiagnosticLines: fixture.application.diagnostics.length,
              keys,
              missingServices,
              status: response.status,
            });
          }
          expect(response.status).toBe(200);
          const signedIn = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SignInResponseSchema)));
          expect(signedIn.identity.principalId).toBe(fixture.core.manager.principalId);
          expect(signedIn.identity.tenantId).toBe(fixture.core.tenantId);
          expect(Cookies.isEmpty(response.cookies)).toBe(false);
          const cookie = Redacted.make(Cookies.toCookieHeader(response.cookies));
          const current = yield* client.get(`${fixture.origin}${fixture.application.apiPrefix}/auth/session`, {
            headers: { cookie: Redacted.value(cookie), origin: fixture.origin },
          });
          expect(current.status).toBe(200);
          const currentSession = yield* current.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CurrentSessionSchema)),
          );
          const authenticated = yield* Schema.decodeUnknownEffect(AuthenticatedSessionSchema)(currentSession);
          expect(authenticated.identity.principalId).toBe(fixture.core.manager.principalId);
          expect(authenticated.identity.tenantId).toBe(fixture.core.tenantId);
          expect(authenticated.identity.legalEntityId).toBe(fixture.core.legalEntityId);
          const resolved = yield* fixture.resolver.resolveBetterAuthUserForTenant(
            fixture.core.manager.authBindingId,
            fixture.core.tenantId,
          );
          expect(resolved.authBindingId).toBe(fixture.core.manager.authBindingId);
          expect(resolved.principalId).toBe(fixture.core.manager.principalId);
          const sessions = yield* fixture.persistence.executor.query.session.findMany({
            columns: { activeLegalEntityId: true, activeTenantId: true, id: true, userId: true },
            where: { userId: fixture.core.manager.authBindingId },
          });
          expect(sessions).toHaveLength(1);
          const [persisted] = sessions;
          expect(persisted?.userId).toBe(fixture.core.manager.authBindingId);
          expect(persisted?.activeTenantId).toBe(fixture.core.tenantId);
          expect(persisted?.activeLegalEntityId).toBe(fixture.core.legalEntityId);
          expect(persisted?.id).not.toBe(fixture.core.manager.authBindingId);
          yield* Effect.logInfo('Packaged Shell real authenticated user verified', {
            actualSessionReferenceDiffersFromSyntheticFixture: true,
            authenticatedSessionStatus: current.status,
            coreBindingMatches: true,
            legalEntityMatches: true,
            realSessionCount: sessions.length,
            signInStatus: response.status,
            sourceRevision: fixture.application.compiled.sourceRevision,
          });
        }),
      ),
    );
    if (startedChild !== undefined) {
      const running = yield* startedChild.isRunning;
      expect(running).toBe(false);
      yield* Effect.logInfo('Authenticated packaged Shell scoped child release', { running });
    }
    if (Exit.isFailure(result)) {
      yield* Effect.failCause(result.cause);
    }
  }).pipe(
    Effect.timeout('45 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Reactivity.layer)),
  ),
);

it.live('derives and publishes real Shell Party Catalog Composition with matching native HTTP and Core authority', () =>
  Effect.gen(function* realPackagedComposition() {
    const children: ChildProcessHandle[] = [];
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* publishRealPackagedComposition() {
          let encoded: string | null = null;
          const source = yield* startNativeHttpServer((request) => {
            if (new URL(request.url).pathname !== '/active') {
              return Promise.resolve(new Response(null, { status: 404 }));
            }
            if (encoded === null) {
              return Promise.resolve(new Response(null, { status: 503 }));
            }
            return Promise.resolve(
              new Response(encoded, { headers: { 'content-type': 'application/json' }, status: 200 }),
            );
          });
          const compositionUrl = `${source.origin}/active`;
          const shell = yield* startPackagedApplication({
            appId: 'shell-super-app',
            compositionUrl,
            relativeDirectory: '.',
          });
          children.push(shell.child);
          const party = yield* startPackagedApplication({
            appId: 'party-registry',
            compositionUrl,
            relativeDirectory: '../../verticals/party-registry',
          });
          children.push(party.child);
          const catalog = yield* startPackagedApplication({
            appId: 'catalog',
            compositionUrl,
            relativeDirectory: '../../verticals/catalog',
          });
          children.push(catalog.child);
          const client = yield* HttpClient.HttpClient;
          const observe = Effect.fn('ServerOwnerRelayNative.observeCompositionArtifact')(
            function* observeCompositionArtifact(url: string) {
              const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
              expect(response.status).toBe(200);
              return { bytes: new Uint8Array(yield* response.arrayBuffer), url };
            },
          );
          const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
            environment: 'development',
            modules: [
              {
                appId: 'party-registry',
                backend: { baseUrl: `${party.origin}/`, transport: 'node-http' },
                contract: yield* observe(`${party.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                federationManifest: yield* observe(`${party.origin}/mf-manifest.json`),
              },
              {
                appId: 'catalog',
                backend: { baseUrl: `${catalog.origin}/`, transport: 'node-http' },
                contract: yield* observe(`${catalog.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                federationManifest: yield* observe(`${catalog.origin}/mf-manifest.json`),
              },
            ],
            observedAt: yield* DateTime.now,
            shell: {
              federationManifest: yield* observe(`${shell.origin}/mf-manifest.json`),
              runtimeContract: yield* observe(`${shell.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`),
            },
            validity: Duration.minutes(15),
          });
          const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
          const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
          yield* database.transaction(
            Effect.fn('ServerOwnerRelayNative.drainPreviousAuthority')(function* drainPreviousAuthority(transaction) {
              yield* lockApplicationCompositionPublication(transaction);
              const previous = yield* transaction.query.applicationCompositionAuthority.findFirst({
                where: { authorityKey: 'active' },
              });
              if (previous !== undefined && previous.revision !== approved.composition.revision) {
                yield* closeApplicationCompositionDurableAdmission(transaction, previous.revision);
                yield* drainApplicationCompositionAuthority(transaction, previous.revision);
              }
            }),
          );
          yield* publishTestApplicationCompositionAuthority(database, approved);
          encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
          const response = yield* client.get(compositionUrl);
          expect(response.status).toBe(200);
          const received = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)),
          );
          const current = yield* validateActiveApplicationCompositionSnapshot(received);
          expect(current.composition.revision).toBe(approved.composition.revision);
          expect(current.composition.shell.deployment).toEqual({
            appId: 'shell-super-app',
            buildMarker: shell.compiled.buildMarker,
          });
          expect(current.composition.modules).toHaveLength(2);
          expect(current.composition.modules).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                backend: { baseUrl: `${party.origin}/`, transport: 'node-http' },
                deployment: { appId: 'party-registry', buildMarker: party.compiled.buildMarker },
                federation: expect.objectContaining({ execution: 'browser' }),
              }),
              expect.objectContaining({
                backend: { baseUrl: `${catalog.origin}/`, transport: 'node-http' },
                deployment: { appId: 'catalog', buildMarker: catalog.compiled.buildMarker },
                federation: expect.objectContaining({ execution: 'browser' }),
              }),
            ]),
          );
          const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
          const runtimeDatabase = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
          const authority = yield* runtimeDatabase.query.applicationCompositionAuthority.findFirst({
            where: { authorityKey: 'active' },
          });
          expect(authority?.revision).toBe(current.composition.revision);
          expect(authority?.phase).toBe('active');
          expect(authority?.durableWorkAdmission).toBe('open');
          yield* Effect.logInfo('Real packaged Composition publication verified', {
            browserModules: current.composition.modules.length,
            currentAuthorityRevision: authority?.revision,
            httpStatus: response.status,
            revision: current.composition.revision,
            shellBuildMarker: shell.compiled.buildMarker,
            sourceRevision: shell.compiled.sourceRevision,
          });
        }),
      ),
    );
    for (const child of children) {
      expect(yield* child.isRunning).toBe(false);
    }
    yield* Effect.logInfo('Real Composition packaged children stopped', { count: children.length });
    if (Exit.isFailure(result)) {
      yield* Effect.failCause(result.cause);
    }
  }).pipe(
    Effect.timeout('60 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Reactivity.layer)),
  ),
);

it.live('creates a real separately bound managed service credential through packaged Shell HTTP', () =>
  Effect.gen(function* realManagedServiceCredential() {
    const children: ChildProcessHandle[] = [];
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* issueRealManagedServiceCredential() {
          let encoded: string | null = null;
          const source = yield* startNativeHttpServer((request) => {
            if (new URL(request.url).pathname !== '/active') {
              return Promise.resolve(new Response(null, { status: 404 }));
            }
            if (encoded === null) {
              return Promise.resolve(new Response(null, { status: 503 }));
            }
            return Promise.resolve(
              new Response(encoded, { headers: { 'content-type': 'application/json' }, status: 200 }),
            );
          });
          const compositionUrl = `${source.origin}/active`;
          const fixture = yield* makePackagedShellUserFixture(compositionUrl);
          const shell = fixture.application;
          children.push(shell.child);
          const party = yield* startPackagedApplication({
            appId: 'party-registry',
            compositionUrl,
            relativeDirectory: '../../verticals/party-registry',
          });
          children.push(party.child);
          const catalog = yield* startPackagedApplication({
            appId: 'catalog',
            compositionUrl,
            relativeDirectory: '../../verticals/catalog',
          });
          children.push(catalog.child);
          const client = yield* HttpClient.HttpClient;
          const observe = Effect.fn('ServerOwnerRelayNative.observeCompositionArtifact')(
            function* observeCompositionArtifact(url: string) {
              const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
              expect(response.status).toBe(200);
              return { bytes: new Uint8Array(yield* response.arrayBuffer), url };
            },
          );
          const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
            environment: 'development',
            modules: [
              {
                appId: 'party-registry',
                backend: { baseUrl: `${party.origin}/`, transport: 'node-http' },
                contract: yield* observe(`${party.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                federationManifest: yield* observe(`${party.origin}/mf-manifest.json`),
              },
              {
                appId: 'catalog',
                backend: { baseUrl: `${catalog.origin}/`, transport: 'node-http' },
                contract: yield* observe(`${catalog.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                federationManifest: yield* observe(`${catalog.origin}/mf-manifest.json`),
              },
            ],
            observedAt: yield* DateTime.now,
            shell: {
              federationManifest: yield* observe(`${shell.origin}/mf-manifest.json`),
              runtimeContract: yield* observe(`${shell.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`),
            },
            validity: Duration.minutes(15),
          });
          const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
          const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
          yield* database.transaction(
            Effect.fn('ServerOwnerRelayNative.drainPreviousAuthority')(function* drainPreviousAuthority(transaction) {
              yield* lockApplicationCompositionPublication(transaction);
              const previous = yield* transaction.query.applicationCompositionAuthority.findFirst({
                where: { authorityKey: 'active' },
              });
              if (previous !== undefined && previous.revision !== approved.composition.revision) {
                yield* closeApplicationCompositionDurableAdmission(transaction, previous.revision);
                yield* drainApplicationCompositionAuthority(transaction, previous.revision);
              }
            }),
          );
          yield* publishTestApplicationCompositionAuthority(database, approved);
          encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
          const response = yield* client.get(compositionUrl);
          expect(response.status).toBe(200);
          const received = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)),
          );
          const current = yield* validateActiveApplicationCompositionSnapshot(received);
          expect(current.composition.revision).toBe(approved.composition.revision);
          expect(current.composition.shell.deployment).toEqual({
            appId: 'shell-super-app',
            buildMarker: shell.compiled.buildMarker,
          });
          expect(current.composition.modules).toHaveLength(2);
          expect(current.composition.modules).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                backend: { baseUrl: `${party.origin}/`, transport: 'node-http' },
                deployment: { appId: 'party-registry', buildMarker: party.compiled.buildMarker },
                federation: expect.objectContaining({ execution: 'browser' }),
              }),
              expect.objectContaining({
                backend: { baseUrl: `${catalog.origin}/`, transport: 'node-http' },
                deployment: { appId: 'catalog', buildMarker: catalog.compiled.buildMarker },
                federation: expect.objectContaining({ execution: 'browser' }),
              }),
            ]),
          );
          const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
          const runtimeDatabase = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
          const authority = yield* runtimeDatabase.query.applicationCompositionAuthority.findFirst({
            where: { authorityKey: 'active' },
          });
          expect(authority?.revision).toBe(current.composition.revision);
          expect(authority?.phase).toBe('active');
          expect(authority?.durableWorkAdmission).toBe('open');

          yield* grantNativeIdentityAdministration(fixture.core);
          const crypto = yield* Crypto.Crypto;
          const signIn = yield* client.post(`${fixture.origin}${shell.apiPrefix}/auth/sign-in`, {
            body: yield* HttpBody.json({ email: fixture.email, password: Redacted.value(fixture.password) }),
            headers: { origin: fixture.origin },
          });
          expect(signIn.status).toBe(200);
          const cookie = Redacted.make(Cookies.toCookieHeader(signIn.cookies));
          const sessionResponse = yield* client.get(`${fixture.origin}${shell.apiPrefix}/auth/session`, {
            headers: { cookie: Redacted.value(cookie), origin: fixture.origin },
          });
          expect(sessionResponse.status).toBe(200);
          const sessionView = yield* sessionResponse.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AuthenticatedSessionSchema)),
          );
          expect(sessionView.identity.principalId).toBe(fixture.core.manager.principalId);
          const realSession = yield* fixture.persistence.executor.query.session.findFirst({
            columns: { id: true },
            where: { userId: fixture.core.manager.authBindingId },
          });
          if (realSession === undefined) {
            return yield* new PackagedOwnerStartupError({ reason: 'Actual manager session was not persisted' });
          }
          const realAuthContextRef = `better-auth-session:${realSession.id}`;
          expect(realAuthContextRef === fixture.core.manager.authContextRef).toBe(false);
          const create = yield* client.post(`${fixture.origin}${shell.apiPrefix}/auth/identity/principals`, {
            body: yield* HttpBody.json({ displayName: 'Native source workload', kind: 'service' }),
            headers: {
              cookie: Redacted.value(cookie),
              'idempotency-key': yield* crypto.randomUUIDv4(),
              origin: fixture.origin,
              'x-correlation-id': yield* crypto.randomUUIDv4(),
            },
          });
          yield* Effect.logInfo('Real managed fixture principal HTTP result', { status: create.status });
          expect(create.status).toBe(200);
          const created = yield* create.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PrincipalMutationResponseSchema)),
          );
          const serviceId = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema.fields.principalId)(
            created.principalId,
          );
          expect(serviceId).not.toBe(fixture.core.manager.principalId);
          const issue = yield* client.post(`${fixture.origin}${shell.apiPrefix}/auth/identity/api-keys/managed`, {
            body: yield* HttpBody.json({ name: 'Native source relay', principalId: serviceId }),
            headers: {
              cookie: Redacted.value(cookie),
              'idempotency-key': yield* crypto.randomUUIDv4(),
              origin: fixture.origin,
              'x-correlation-id': yield* crypto.randomUUIDv4(),
            },
          });
          yield* Effect.logInfo('Real managed fixture key HTTP result', { status: issue.status });
          if (issue.status !== 200) {
            const failure = yield* issue.json;
            const mergedCookies = Cookies.merge(Cookies.merge(signIn.cookies, sessionResponse.cookies), create.cookies);
            const sameSession = yield* client.get(`${fixture.origin}${shell.apiPrefix}/auth/session`, {
              headers: { cookie: Redacted.value(cookie), origin: fixture.origin },
            });
            yield* Effect.logInfo('Sanitized managed provider authentication diagnostic', {
              declaredShellAuthenticationRequired: Schema.is(ShellAuthenticationRequiredProblemSchema)(failure),
              providerExpectedSessionCookieName: getCookies({ baseURL: fixture.configuration.baseUrl }).sessionToken
                .name,
              receivedCookieNames: Object.keys(signIn.cookies.cookies),
              responseCookieUpdatesChanged: Cookies.toCookieHeader(mergedCookies) !== Redacted.value(cookie),
              sameCookieSessionHttpStatus: sameSession.status,
              secureCookieConfiguration: fixture.configuration.secureCookies,
              status: issue.status,
            });
          }
          expect(issue.status).toBe(200);
          const issued = yield* issue.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(ApiKeyIssueResponseSchema))),
            Effect.mapError(
              () => new PackagedOwnerStartupError({ reason: 'Managed key response failed its public JSON codec' }),
            ),
          );
          const keys = yield* makeApiKeyService().pipe(
            Effect.provideService(AuthConfig, fixture.configuration),
            Effect.provideService(AuthDatabase, fixture.persistence),
          );
          const provider = yield* keys.verify(Redacted.value(issued.secret));
          const service = yield* fixture.resolver.resolveBetterAuthApiKey(provider.providerKeyId);
          expect(service.principalId).toBe(serviceId);
          expect(service.authBindingId).toBe(issued.authBindingId);
          expect(service.tenantId).toBe(fixture.core.tenantId);
          expect(fixture.resolver.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
          const principal = yield* database.query.principals.findFirst({ where: { principalId: serviceId } });
          expect(principal?.kind).toBe('service');
          expect(principal?.status).toBe('active');
          const binding = yield* database.query.principalAuthBindings.findFirst({
            where: { principalAuthBindingId: issued.authBindingId },
          });
          expect(binding?.principalId).toBe(serviceId);
          expect(binding?.subjectType).toBe('api_key');
          expect(binding?.providerSubjectId === provider.providerKeyId).toBe(true);
          expect(binding?.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
          const invocations = yield* database.query.actionInvocations.findMany({
            where: { tenantId: fixture.core.tenantId },
          });
          for (const actionKey of ['core.identity.create-non-human-principal', 'core.identity.bind-managed-api-key']) {
            const invocation = invocations.find((entry) => entry.actionKey === actionKey);
            expect(invocation?.status).toBe('succeeded');
            expect(invocation?.principalId).toBe(fixture.core.manager.principalId);
            expect(invocation?.authContextRef === realAuthContextRef).toBe(true);
          }
          yield* Effect.logInfo('Real managed service credential independently verified', {
            actionCount: invocations.length,
            compositionRevision: approved.composition.revision,
            namespaceMatches: true,
            originalActorPreservedInCanonicalActions: true,
            serviceDistinctFromActor: true,
          });
          return yield* Effect.void;
        }),
      ),
    );
    for (const child of children) {
      expect(yield* child.isRunning).toBe(false);
    }
    if (Exit.isFailure(result)) {
      yield* Effect.failCause(result.cause);
    }
  }).pipe(
    Effect.timeout('60 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Reactivity.layer)),
  ),
);
