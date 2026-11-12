/**
 * CRM's Party intake as its registered workload, with the key the platform issues, through packaged roots only: the
 * Shell and Party Registry run from their built `.output`, CRM runs the way the app host serves its owners
 * (`scripts/zerops/serve-units.mts`, holding its keys from its private handover channel). Build and run it exactly as
 * `server-owner-relay-native.test.ts` describes, plus CRM's build and its in-process entry
 * (`node scripts/zerops/owner-entry.mts verticals/crm`, the step `scripts/zerops/build-app.sh` runs after a build).
 *
 * The test seeds only the operator's data (the workload principal, its binding and the company it acts for); the real
 * `provisionModuleCredentials` issues every key, and the real CRM, Shell and Party Registry decide every admission.
 */
import {
  ActiveApplicationCompositionSnapshotSchema,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  makeDatabaseIdentityEnrollmentLive,
  makePrincipalResolver,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  PrincipalResolver,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { AccessCatalogModulesSchema, buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { makeAccessChangesDrizzleStore } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { SHARED_RUNTIME_IDENTITY } from '@app/core-runtime/db/database-identity-manifest';
import {
  deleteTestCoreOutbox,
  makeLiveOperationFixture,
  publishTestApplicationCompositionAuthority,
  testCoreDatabase,
} from '@app/core-runtime/testing/owner-evidence';
import { grantTestTenantOwnerAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { createPartyWithAuthorization } from '@app/party-registry/api/client';
import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import {
  issueApiKeyGatewayContext,
  issueDelegatedGatewayContext,
} from '@app/shared-contracts/server/gateway-context-api-key';
import { v1 } from '@authzed/authzed-node';
import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, inArray } from 'drizzle-orm';
import {
  Brand,
  Config,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  flow,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from 'effect';
import { Cookies, HttpBody, HttpClient } from 'effect/http';
import type { ChildProcessHandle } from 'effect/process/ChildProcessSpawner';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';

import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  principals,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeTestTenantRoleAccess } from '../../../../packages/core-runtime/src/testing/tenant-access-roles.ts';
import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../../../../scripts/active-application-composition.mts';
import {
  encodeModuleCredentialHandover,
  MODULE_INTERNAL_WORKLOADS,
} from '../../../../scripts/zerops/module-credentials.mts';
import { ApiKeyService, makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { AuthConfig, parseAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, user } from '../../api/auth/db/schema.ts';
import { moduleCredentialReleaseOf } from '../../api/auth/module-credential-attestation.ts';
import {
  provisionModuleCredentials,
  retireOwnModuleCredentials,
} from '../../api/auth/module-credential-provisioning.service.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import { ApiKeyIssueResponseSchema, AuthenticatedSessionSchema } from '../../shared/browser-api.ts';
import { startNativeHttpServer } from '../support/native-http-server.ts';
import {
  allocateLoopbackPort,
  PackagedOwnerStartupError,
  startHostedOwnerWithHandover,
  startPackagedApplication,
} from '../support/server-owner-relay-native-fixture.ts';
import { shellTestAuthentication } from '../support/shell-authentication.ts';

/** CRM's own internal workload (O73), registered by the operator per tenant. */
const INTAKE_WORKLOAD = 'demo.crm.party-intake';
/** The CRM client-write rights of the person in this test: create clients and read the CRM records it writes. */
const CRM_CLIENT_WRITE_CAPABILITIES = ['demo.crm.apply-command.write', 'demo.crm.api-records.read'] as const;
const SHELL_API = '/shell-super-app-api';
const CRM_API = '/crm-api';

type PartySubjectKey = NonNullable<
  NonNullable<Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']>[number]['subjectKey']
>;
const partySubjectKey = Brand.nominal<PartySubjectKey>()('workload-intake-subject');

const authorizationCatalogUrl = new URL('../../../../topology/authorization-catalog.json', import.meta.url);

const PartyIdSchema = Schema.String.pipe(Schema.brand('PartyId'));
const CounterpartyIdSchema = Schema.String.pipe(Schema.brand('CounterpartyId'));
const CrmEntityIdSchema = Schema.String.pipe(Schema.brand('CrmEntityId'));

/** The status a refused owner or Shell answer names; a refusal that names none fails the decode. */
const RefusalStatusSchema = Schema.Struct({ status: Schema.Number });
const refusalStatus = flow(
  Schema.decodeUnknownOption(RefusalStatusSchema),
  Option.match({ onNone: () => -1, onSome: ({ status }) => status }),
);

const CrmRecordsSchema = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({
    clients: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          id: CrmEntityIdSchema,
          name: Schema.String,
          partyRef: Schema.optionalKey(
            Schema.Struct({ counterpartyId: Schema.optionalKey(CounterpartyIdSchema), partyId: PartyIdSchema }),
          ),
        }),
      ),
    }),
  }),
  viewer: Schema.Struct({ writeAll: Schema.Boolean }),
});
const CrmCreateClientResponseSchema = Schema.Struct({
  clientPartySync: Schema.Struct({
    failed: Schema.optionalKey(Schema.Int),
    linked: Schema.optionalKey(Schema.Int),
    remaining: Schema.optionalKey(Schema.Int),
    review: Schema.optionalKey(Schema.Int),
    status: Schema.String,
  }),
  entityIds: Schema.Array(CrmEntityIdSchema),
  revision: Schema.Int,
});
const PendingIntakeSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: CrmEntityIdSchema, linked: Schema.Boolean })),
  revision: Schema.Int,
});
const PartyRowSchema = Schema.Array(Schema.Struct({ displayName: Schema.OptionFromNullOr(Schema.String) }));
const CounterpartyRowSchema = Schema.Array(Schema.Struct({ acceptedBy: Schema.String, partyId: PartyIdSchema }));

/** Only the shape of a child's warning or error line, never its content: a line may carry a token. */
const redactedLine = (line: Redacted.Redacted) =>
  Redacted.value(line)
    .replaceAll(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '<jwt>')
    .replaceAll(/(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{32,}/gu, '<opaque>')
    .slice(0, 400);
const logChildProblems = (name: string, diagnostics: readonly Redacted.Redacted[]) =>
  Effect.logInfo(`${name} warnings and errors`, {
    lines: diagnostics
      .filter((line) => /warn|error|fail|refus|denied|unavailable/iu.test(Redacted.value(line)))
      .slice(-40)
      .map(redactedLine),
  });

type NativeCoreDatabase = Effect.Success<typeof testCoreDatabase>;

/** Publishes the checked-in authorization catalog, so every Tenant pins the release of every module. */
const publishCatalogRelease = Effect.fn('CrmIntakeWorkloadNative.publishCatalogRelease')(
  function* publishCatalogRelease(database: NativeCoreDatabase) {
    const [filesystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
    const { modules } = yield* path.fromFileUrl(authorizationCatalogUrl).pipe(
      Effect.flatMap((catalogPath) => filesystem.readFileString(catalogPath)),
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema }))),
      ),
    );
    const release = yield* Effect.fromResult(
      buildAccessCatalogRelease({
        installedModuleKeys: modules.map(({ moduleId }) => moduleId),
        modules,
        publishedAt: DateTime.toDateUtc(yield* DateTime.now),
      }),
    );
    const store = makeAccessChangesDrizzleStore({ enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT, executor: database });
    yield* store.publishCatalog({ snapshot: release });
    const published = yield* store.loadPublishedCatalog();
    if (Option.isNone(published) || published.value.id !== release.id) {
      return yield* new PackagedOwnerStartupError({
        reason: 'A release other than the checked-in authorization catalog is published',
      });
    }
    return release.id;
  },
);

/**
 * A Tenant with Party Registry and CRM installed, its owner as a signed-up Shell user, and the packaged Shell serving
 * it with a gateway signing key. The owner starts with the full role; the test narrows it to CRM client writes.
 */
const makeCrmShellFixture = Effect.fn('CrmIntakeWorkloadNative.makeShellFixture')(function* makeCrmShellFixture(
  compositionUrl: string,
  gatewayMaterial: { readonly privateJwk: Redacted.Redacted; readonly publicJwks: string },
) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const issuerConfiguration = yield* loadDatabaseConfig({
    envPath: '/dev/null',
    identity: SHELL_GATEWAY_ISSUER_IDENTITY,
  });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
  const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
  const core = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        'core.identity.create-non-human-principal',
        'core.identity.bind-managed-api-key',
        'core.identity.bind-self-api-key',
      ],
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      // Seed-only configuration; no authority is published and core.layer is never provided.
      compositionRevision: 'a'.repeat(64),
      moduleKeys: ['party.registry', 'demo.crm'],
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }),
    (fixture) => fixture.close().pipe(Effect.orDie),
  );
  const accessTarget = {
    legalEntityIds: [core.legalEntityId] as const,
    spiceDb: yield* liveFixtureSpiceDb(core.permissionEnvironment),
    writerConnectionString: Redacted.make(connections.runtime.connectionString),
  };
  yield* publishCatalogRelease(database);
  yield* grantTestTenantOwnerAccess({ ...accessTarget, owner: core.manager });
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
  const persistence = yield* makeAuthDatabase({ ...configuration, expectedRole: SHARED_RUNTIME_IDENTITY.role });
  const resolver = makePrincipalResolver(
    { executor: database },
    { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
  );
  const authentication = yield* shellTestAuthentication({ allowFixtureSignUp: true }).pipe(
    Effect.provideService(AuthConfig, configuration),
    Effect.provideService(AuthDatabase, persistence),
    Effect.provideService(CoreDatabase, { executor: database }),
    Effect.provideService(PrincipalResolver, resolver),
  );
  const email = `crm-intake-${core.manager.authBindingId}@example.test`;
  const generatedId = yield* Effect.acquireRelease(
    authentication.createFixtureUser(email, 'CRM client writer', password),
    (id) =>
      persistence.executor
        .delete(user)
        .where(inArray(user.id, [id, core.manager.authBindingId]))
        .pipe(Effect.orDie),
  );
  // The Core binding of the fixture manager names its Auth user, so the generated user takes that id.
  yield* persistence.executor.transaction(
    Effect.fn('CrmIntakeWorkloadNative.alignAuthSubject')(function* alignAuthSubject(transaction) {
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
  const application = yield* startPackagedApplication({
    appId: 'shell-super-app',
    authentication: {
      baseUrl: origin,
      connectionString: Redacted.make(connections.runtime.connectionString),
      issuerConnectionString: Redacted.make(issuerConfiguration.connectionString),
      port,
      secret,
      spice,
    },
    compositionUrl,
    gateway: { issuer: origin, privateJwk: gatewayMaterial.privateJwk, publicJwks: gatewayMaterial.publicJwks },
    relativeDirectory: '.',
  });
  return {
    access: accessTarget,
    admin,
    application,
    configuration,
    core,
    database,
    email,
    origin,
    password,
    persistence,
  };
});

type CrmShellFixture = Effect.Success<ReturnType<typeof makeCrmShellFixture>>;

/** The owner administers identities of its Tenant, so it may issue itself a personal key. */
const grantIdentityAdministration = Effect.fn('CrmIntakeWorkloadNative.grantIdentityAdministration')(
  function* grantIdentityAdministration(fixture: CrmShellFixture) {
    const settings = yield* Config.all({
      certificate: Config.String('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    const spice = yield* Effect.acquireRelease(
      Effect.sync(() =>
        v1.NewClientWithCustomCert(Redacted.value(settings.key), settings.endpoint, Buffer.from(settings.certificate)),
      ),
      (client) => Effect.sync(() => client.close()),
    );
    const relationship = v1.Relationship.create({
      relation: 'identity_admin',
      resource: { objectId: fixture.core.tenantId, objectType: 'tenant' },
      subject: { object: { objectId: fixture.core.manager.principalId, objectType: 'principal' } },
    });
    const write = (operation: v1.RelationshipUpdate_Operation) =>
      Effect.tryPromise({
        catch: () => new PackagedOwnerStartupError({ reason: 'Identity administration permission write failed' }),
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
  },
);

/** Signs the person in to the packaged Shell and issues its personal key through the Shell's own endpoint. */
const issuePersonalKey = Effect.fn('CrmIntakeWorkloadNative.issuePersonalKey')(function* issuePersonalKey(
  fixture: CrmShellFixture,
) {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const prefix = fixture.application.apiPrefix;
  const signIn = yield* client.post(`${fixture.origin}${prefix}/auth/sign-in`, {
    body: yield* HttpBody.json({ email: fixture.email, password: Redacted.value(fixture.password) }),
    headers: { origin: fixture.origin },
  });
  expect(signIn.status).toBe(200);
  const cookie = Redacted.make(Cookies.toCookieHeader(signIn.cookies));
  const session = yield* client.get(`${fixture.origin}${prefix}/auth/session`, {
    headers: { cookie: Redacted.value(cookie), origin: fixture.origin },
  });
  expect(session.status).toBe(200);
  const view = yield* session.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AuthenticatedSessionSchema)));
  expect(view.identity.principalId).toBe(fixture.core.manager.principalId);
  const issued = yield* client.post(`${fixture.origin}${prefix}/auth/identity/api-keys/self`, {
    body: yield* HttpBody.json({ name: 'CRM client writer' }),
    headers: {
      cookie: Redacted.value(cookie),
      'idempotency-key': yield* crypto.randomUUIDv4(),
      origin: fixture.origin,
      'x-correlation-id': yield* crypto.randomUUIDv4(),
    },
  });
  expect(issued.status).toBe(200);
  const personalKey = yield* issued.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(ApiKeyIssueResponseSchema))),
  );
  return personalKey.secret;
});

/**
 * The Shell's `/auth/api-key/gateway-context` answer for one key: the issued assertion, or the HTTP status the Shell
 * refused it with.
 */
const issueKeyContext = Effect.fn('CrmIntakeWorkloadNative.issueKeyContext')(function* issueKeyContext(
  fixture: CrmShellFixture,
  input: {
    readonly apiKey: Redacted.Redacted;
    readonly audience: 'crm' | 'party-registry';
    readonly compositionRevision: string;
  },
) {
  const crypto = yield* Crypto.Crypto;
  return yield* issueApiKeyGatewayContext(
    {
      audience: input.audience,
      compositionRevision: input.compositionRevision,
      legalEntityId: fixture.core.legalEntityId,
    },
    {
      apiKey: input.apiKey,
      baseUrl: `${fixture.origin}${SHELL_API}`,
      requestCorrelation: yield* crypto.randomUUIDv4(),
    },
  ).pipe(
    Effect.map((issued) => ({ token: Redacted.make(issued.token) })),
    Effect.catch((error) => Effect.succeed({ refused: refusalStatus(error) })),
  );
});

/** A context the test needs: its absence fails the test with the status the Shell refused it with. */
const requireIssued = (issued: { readonly token: Redacted.Redacted } | { readonly refused: number }) =>
  'token' in issued
    ? Effect.succeed(issued.token)
    : Effect.fail(
        new PackagedOwnerStartupError({ reason: `The Shell refused the context (status ${String(issued.refused)})` }),
      );

/** A value the flow must have produced; its absence fails the test with what was missing. */
const present = <Value>(value: Value | undefined, what: string) =>
  value === undefined
    ? Effect.fail(new PackagedOwnerStartupError({ reason: `Missing: ${what}` }))
    : Effect.succeed(value);

const bearer = (token: Redacted.Redacted) => `Bearer ${Redacted.value(token)}`;

/** A generic Party create candidate, the request a Party create would carry. */
const genericPartyCandidate = (name: string) => ({
  candidate: {
    businessName: name,
    evidenceRefs: ['native/crm-intake-workload'],
    officialIdentifiers: [],
    partyType: 'ORGANIZATION' as const,
    provenance: { method: 'DOCUMENT' as const, source: 'crm-intake-workload-proof' },
    subjectEvidence: [
      {
        basis: 'REVIEWED_DOCUMENT' as const,
        evidenceRef: 'native/crm-intake-workload',
        kind: 'ACTOR_ATTESTATION' as const,
        observedSubject: 'ORGANIZATION' as const,
        statement: 'Reviewed this concrete external organization',
        subjectKey: partySubjectKey,
      },
    ],
    validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
  },
});

it.live(
  'creates the Party of a new CRM client as the registered intake workload with the platform-issued key, admits that key only where declared, and rotates it in the running CRM',
  () =>
    Effect.gen(function* crmIntakeWorkload() {
      const children: ChildProcessHandle[] = [];
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* proveCrmIntakeWorkload() {
            const crypto = yield* Crypto.Crypto;
            const client = yield* HttpClient.HttpClient;
            const signingKeyPair = yield* Effect.tryPromise(() =>
              generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
            );
            const signingKid = `crm-intake-${yield* crypto.randomUUIDv4()}`;
            const privateJwk = yield* Effect.tryPromise(() => exportJWK(signingKeyPair.privateKey));
            const publicJwk = yield* Effect.tryPromise(() => exportJWK(signingKeyPair.publicKey));
            const gatewayMaterial = {
              privateJwk: Redacted.make(JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: signingKid, use: 'sig' })),
              publicJwks: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: signingKid, use: 'sig' }] }),
            };
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
            const fixture = yield* makeCrmShellFixture(compositionUrl, gatewayMaterial);
            const { core } = fixture;
            // No Outbox worker runs here, so the Tenant's CRM and Party events would block the next suite's release
            // promotion. They are released after the owners stop (finalizers run in reverse order).
            yield* Effect.addFinalizer(() => deleteTestCoreOutbox(fixture.admin, core.tenantId).pipe(Effect.orDie));
            const shell = fixture.application;
            children.push(shell.child);
            const party = yield* startPackagedApplication({
              appId: 'party-registry',
              compositionUrl,
              gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
              relativeDirectory: '../../verticals/party-registry',
            });
            children.push(party.child);
            // CRM as the app host serves it: claimed before it loads, its keys only ever on its private channel.
            const crm = yield* startHostedOwnerWithHandover({
              appId: 'crm',
              compositionUrl,
              gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
              relativeDirectory: '../../verticals/crm',
              shellGatewayBaseUrl: `${fixture.origin}${SHELL_API}`,
              workspaceDirectory: '../..',
            });
            children.push(crm.child);
            const crmPid = crm.child.pid;

            // The release: the packaged Shell, Party Registry and CRM, published as the active authority.
            const observe = Effect.fn('CrmIntakeWorkloadNative.observeArtifact')(function* observeArtifact(
              url: string,
            ) {
              const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
              expect(response.status).toBe(200);
              return { bytes: new Uint8Array(yield* response.arrayBuffer), url };
            });
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
                  appId: 'crm',
                  backend: { baseUrl: `${crm.origin}/`, transport: 'node-http' },
                  contract: yield* observe(`${crm.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                  federationManifest: yield* observe(`${crm.origin}/mf-manifest.json`),
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
            const { database } = fixture;
            yield* database.transaction(
              Effect.fn('CrmIntakeWorkloadNative.drainPreviousAuthority')(
                function* drainPreviousAuthority(transaction) {
                  yield* lockApplicationCompositionPublication(transaction);
                  const previous = yield* transaction.query.applicationCompositionAuthority.findFirst({
                    where: { authorityKey: 'active' },
                  });
                  if (previous !== undefined && previous.revision !== approved.composition.revision) {
                    if (previous.phase === 'active') {
                      yield* closeApplicationCompositionDurableAdmission(transaction, previous.revision);
                    }
                    yield* drainApplicationCompositionAuthority(transaction, previous.revision);
                  }
                },
              ),
            );
            yield* publishTestApplicationCompositionAuthority(database, approved);
            encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
            const served = yield* client.get(compositionUrl);
            expect(served.status).toBe(200);
            const current = yield* served.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)),
              Effect.flatMap(validateActiveApplicationCompositionSnapshot),
            );
            const { revision } = current.composition;
            expect(revision).toBe(approved.composition.revision);
            expect(current.composition.modules.map(({ deployment }) => deployment)).toEqual(
              expect.arrayContaining([
                { appId: 'crm', buildMarker: crm.buildMarker },
                { appId: 'party-registry', buildMarker: party.compiled.buildMarker },
              ]),
            );

            // The operator's data (ADR-0028): the principal registered for CRM's intake workload in this Tenant, its
            // binding and the one company it acts for. The platform never writes these; nobody issues it a key.
            const intakePrincipal = yield* crypto.randomUUIDv4();
            const intakeBinding = yield* crypto.randomUUIDv4();
            yield* database.insert(principals).values({
              displayName: 'CRM Party intake',
              kind: 'service',
              principalId: intakePrincipal,
              status: 'active',
              tenantId: core.tenantId,
            });
            yield* database.insert(accessWorkloadBindings).values({
              bindingId: intakeBinding,
              incarnation: yield* crypto.randomUUIDv4(),
              principalId: intakePrincipal,
              status: 'active',
              tenantId: core.tenantId,
              workloadKey: INTAKE_WORKLOAD,
            });
            yield* database.insert(accessWorkloadCompanyBindings).values({
              companyBindingId: yield* crypto.randomUUIDv4(),
              incarnation: yield* crypto.randomUUIDv4(),
              legalEntityId: core.legalEntityId,
              status: 'active',
              tenantId: core.tenantId,
              workloadBindingId: intakeBinding,
            });
            // The operator ends the registration when the suite ends, so later provisioning passes on this database
            // issue no key for this Tenant; the rows themselves stay, as Core retains access intent (D27).
            yield* Effect.addFinalizer(() =>
              DateTime.nowAsDate.pipe(
                Effect.flatMap((revokedAt) =>
                  database
                    .update(accessWorkloadBindings)
                    .set({ revokedAt, status: 'revoked' })
                    .where(eq(accessWorkloadBindings.bindingId, intakeBinding)),
                ),
                Effect.orDie,
              ),
            );

            // The platform's provisioning pass, exactly as a host boot runs it: CRM's and Party Registry's module
            // keys and the intake workload's key, for this Tenant only, attested for this release.
            const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
            const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
            const runtimeDatabase = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
            const keys = yield* makeApiKeyService().pipe(
              Effect.provideService(AuthConfig, fixture.configuration),
              Effect.provideService(AuthDatabase, fixture.persistence),
            );
            const platform = Layer.mergeAll(
              Layer.succeed(ApiKeyService, keys),
              Layer.succeed(AuthDatabase, fixture.persistence),
              Layer.succeed(CoreDatabase, { executor: runtimeDatabase }),
            );
            const release = moduleCredentialReleaseOf({
              composition: current.composition,
              contracts: current.composition.modules,
            });
            const hostId = 'crm-intake-workload-native';
            const provision = (bootId: string) =>
              crypto.randomUUIDv4().pipe(
                Effect.flatMap((operationId) =>
                  provisionModuleCredentials({
                    appIds: ['crm', 'party-registry'],
                    bootId,
                    hostId,
                    operationId,
                    release,
                    workloads: MODULE_INTERNAL_WORKLOADS,
                  }),
                ),
                Effect.provide(platform),
              );
            const entry = `crm/${INTAKE_WORKLOAD}/${core.tenantId}`;
            const handOver = Effect.fn('CrmIntakeWorkloadNative.handOver')(function* handOver(
              pass: Effect.Success<ReturnType<typeof provision>>,
            ) {
              yield* crm.handOver(
                yield* encodeModuleCredentialHandover(
                  Object.fromEntries(pass.credentials),
                  ['crm'],
                  Object.fromEntries(pass.workloadCredentials),
                ),
              );
              // The process names what it took from the channel: CRM's module key and its workload keys, by entry
              // (one per Tenant that registered the workload; this database may hold other suites' Tenants).
              const taken = (yield* crm.received).split(', ');
              expect(taken[0]).toBe('crm');
              expect(taken).toContain(entry);
              expect(taken.every((name) => name === 'crm' || name.startsWith(`crm/${INTAKE_WORKLOAD}/`))).toBe(true);
            });
            const bootOne = yield* crypto.randomUUIDv4();
            const first = yield* provision(bootOne);
            expect(first.failedAppIds).toEqual([]);
            expect([...first.workloadCredentials.keys()]).toContain(entry);
            const workloadKey = yield* present(first.workloadCredentials.get(entry), 'intake workload key');
            const crmModuleKey = yield* present(first.credentials.get('crm'), 'CRM module key');
            const partyModuleKey = yield* present(first.credentials.get('party-registry'), 'Party module key');
            const resolver = makePrincipalResolver(
              { executor: database },
              { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
            );
            const resolved = yield* resolver.resolveBetterAuthApiKey(
              (yield* keys.verify(Redacted.value(workloadKey))).providerKeyId,
            );
            expect(resolved.principalId).toBe(intakePrincipal);
            expect(resolved.tenantId).toBe(core.tenantId);
            yield* handOver(first);

            // The person: signed in, holding its own personal key, then left with CRM client writes only.
            yield* grantIdentityAdministration(fixture);
            const personalKey = yield* issuePersonalKey(fixture);
            const roles = yield* makeTestTenantRoleAccess({
              ...fixture.access,
              principalId: core.manager.principalId,
              tenantId: core.tenantId,
            });
            yield* roles.endHeldRoles();
            yield* (yield* roles.capabilityRole(CRM_CLIENT_WRITE_CAPABILITIES)).grant();

            const crmRequest = Effect.fn('CrmIntakeWorkloadNative.crmRequest')(function* crmRequest(
              route: string,
              token: Redacted.Redacted,
              body: HttpBody.HttpBody,
            ) {
              const headers = {
                authorization: bearer(token),
                'x-correlation-id': yield* crypto.randomUUIDv4(),
                'x-ontos-composition-revision': revision,
              };
              // Actions require an idempotency key; Reads take none.
              return yield* client.post(`${crm.origin}${CRM_API}${route}`, {
                body,
                headers: route.startsWith('/crm/actions/')
                  ? { ...headers, 'idempotency-key': yield* crypto.randomUUIDv4() }
                  : headers,
              });
            });
            const personContext = (audience: 'crm' | 'party-registry') =>
              issueKeyContext(fixture, { apiKey: personalKey, audience, compositionRevision: revision });
            const workloadContext = (audience: 'crm' | 'party-registry', apiKey = workloadKey) =>
              issueKeyContext(fixture, { apiKey, audience, compositionRevision: revision });
            const readRecords = Effect.fn('CrmIntakeWorkloadNative.readRecords')(function* readRecords() {
              const response = yield* crmRequest(
                '/reads/records',
                yield* requireIssued(yield* personContext('crm')),
                yield* HttpBody.json({}),
              );
              expect(response.status).toBe(200);
              return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CrmRecordsSchema)));
            });
            const createPartyAs = Effect.fn('CrmIntakeWorkloadNative.createPartyAs')(function* createPartyAs(
              authorization: string,
            ) {
              return yield* createPartyWithAuthorization(
                genericPartyCandidate(`Refused organization ${yield* crypto.randomUUIDv4()}`),
                authorization,
                {
                  baseUrl: `${party.origin}${party.apiPrefix}`,
                  compositionRevision: revision,
                  correlationId: yield* crypto.randomUUIDv4(),
                  idempotencyKey: yield* crypto.randomUUIDv4(),
                },
              ).pipe(
                Effect.map(() => 200),
                Effect.catch((error) => Effect.succeed(refusalStatus(error))),
              );
            });

            /** Which step of the intake refused, as its owner answers it (Problem Details carry no secret). */
            const diagnoseIntake = Effect.fn('CrmIntakeWorkloadNative.diagnoseIntake')(function* diagnoseIntake() {
              const context = yield* workloadContext('crm');
              if (!('token' in context)) {
                return yield* Effect.logInfo('Intake diagnosis', { workloadContextRefused: context.refused });
              }
              const pendingProbe = yield* crmRequest(
                '/reads/pending-client-intake',
                context.token,
                yield* HttpBody.json({}),
              );
              return yield* Effect.logInfo('Intake diagnosis', {
                pendingBody: (yield* pendingProbe.text).slice(0, 600),
                pendingStatus: pendingProbe.status,
                workloadContext: 'issued',
              });
            });

            /** One CRM client created by the person, linked by CRM's intake to the Party it created as the workload. */
            const createLinkedClient = Effect.fn('CrmIntakeWorkloadNative.createLinkedClient')(
              function* createLinkedClient(name: string) {
                const before = yield* readRecords();
                expect(before.viewer.writeAll).toBe(true);
                const response = yield* crmRequest(
                  '/crm/actions/apply-command',
                  yield* requireIssued(yield* personContext('crm')),
                  yield* HttpBody.json({
                    command: { _tag: 'CreateClient', kind: 'organization', name },
                    expectedRevision: before.revision,
                  }),
                );
                if (response.status !== 200) {
                  yield* logChildProblems('CRM', crm.diagnostics);
                }
                expect(response.status).toBe(200);
                const created = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(CrmCreateClientResponseSchema)),
                );
                if (created.clientPartySync.status !== 'complete') {
                  yield* logChildProblems('CRM', crm.diagnostics);
                  yield* logChildProblems('Party Registry', party.diagnostics);
                  yield* logChildProblems('Shell', shell.diagnostics);
                  yield* diagnoseIntake();
                }
                expect(created.clientPartySync).toEqual({
                  failed: 0,
                  linked: 1,
                  remaining: 0,
                  review: 0,
                  status: 'complete',
                });
                const clientId = yield* present(created.entityIds[0], 'created CRM client');
                const after = yield* readRecords();
                const linked = after.state.clients.items.find(({ id }) => id === clientId);
                expect(linked?.name).toBe(name);
                const partyId = yield* present(linked?.partyRef?.partyId, 'Party link on the CRM client');
                const counterpartyId = yield* present(linked?.partyRef?.counterpartyId, 'Counterparty link');
                // The Party Registry's own records: the Party and its CUSTOMER Counterparty, accepted from the
                // workload, never from the person.
                const parties = yield* Schema.decodeUnknownEffect(PartyRowSchema)(
                  yield* fixture.admin`select current_display_name as "displayName" from party.parties where tenant_id = ${core.tenantId}::uuid and party_id = ${partyId}::uuid`,
                );
                expect(parties).toEqual([{ displayName: Option.some(name) }]);
                const counterparties = yield* Schema.decodeUnknownEffect(CounterpartyRowSchema)(
                  yield* fixture.admin`select party_id::text as "partyId", accepted_by_principal_id::text as "acceptedBy" from party.counterparties where tenant_id = ${core.tenantId}::uuid and counterparty_id = ${counterpartyId}::uuid and legal_entity_id = ${core.legalEntityId}::uuid`,
                );
                expect(counterparties).toEqual([{ acceptedBy: intakePrincipal, partyId }]);
                return { clientId, counterpartyId, partyId };
              },
            );

            // 1. The person may write CRM clients and has no Party Registry right: it cannot create a Party itself.
            const personParty = yield* personContext('party-registry');
            if ('token' in personParty) {
              expect(yield* createPartyAs(bearer(personParty.token))).toBe(403);
            } else {
              expect(personParty.refused).toBe(403);
            }

            // 2. Where the workload key is accepted, another module's key is refused: the Shell admits it at the API-key
            // gateway context as an ordinary key of the registered principal, never a module credential.
            const accepted = yield* requireIssued(yield* workloadContext('crm'));
            const verified = yield* Effect.tryPromise(() =>
              jwtVerify(Redacted.value(accepted), signingKeyPair.publicKey, {
                audience: 'crm',
                issuer: fixture.origin,
              }),
            );
            const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload);
            expect(claims.sub).toBe(intakePrincipal);
            expect(claims.principal.tenantId).toBe(core.tenantId);
            expect(claims.principal.legalEntityId).toBe(core.legalEntityId);
            expect(claims.principal.authMethod).toBe('api_key');
            expect(yield* workloadContext('crm', partyModuleKey)).toEqual({ refused: 403 });
            expect(yield* workloadContext('crm', crmModuleKey)).toEqual({ refused: 403 });

            // 3. The workload key is refused on every endpoint other than the one it is for.
            // The delegated endpoint takes module credentials only: the workload key binds nothing there, while CRM's
            // module key delegates the same workload subject (the call CRM's own intake Action makes).
            const delegate = Effect.fn('CrmIntakeWorkloadNative.delegate')(function* delegate(
              apiKey: Redacted.Redacted,
              sourceKey: Redacted.Redacted,
            ) {
              const sourceAssertion = yield* requireIssued(yield* workloadContext('crm', sourceKey));
              return yield* issueDelegatedGatewayContext(
                {
                  audience: 'party-registry',
                  compositionRevision: revision,
                  exchangeId: yield* crypto.randomUUIDv4(),
                  legalEntityScope: 'subject',
                  subject: { _tag: 'Assertion', sourceAssertion: Redacted.value(sourceAssertion) },
                },
                { apiKey, baseUrl: `${fixture.origin}${SHELL_API}`, requestCorrelation: yield* crypto.randomUUIDv4() },
              ).pipe(
                Effect.map((issued) => ({ token: Redacted.make(issued.token) })),
                Effect.catch((error) => Effect.succeed({ refused: refusalStatus(error) })),
              );
            });
            expect(yield* delegate(workloadKey, workloadKey)).toEqual({ refused: 403 });
            const delegated = yield* requireIssued(yield* delegate(crmModuleKey, workloadKey));
            // An assertion of the workload is refused by a Party Action not declared for it, whether the workload
            // calls directly or through CRM's delegation.
            expect(yield* createPartyAs(bearer(yield* requireIssued(yield* workloadContext('party-registry'))))).toBe(
              403,
            );
            expect(yield* createPartyAs(bearer(delegated))).toBe(403);
            // CRM's own Action and Read not declared for the workload refuse it; the intake Read declared for it
            // admits it.
            const applyAsWorkload = yield* crmRequest(
              '/crm/actions/apply-command',
              yield* requireIssued(yield* workloadContext('crm')),
              yield* HttpBody.json({
                command: { _tag: 'CreateClient', kind: 'organization', name: 'Refused workload client' },
                expectedRevision: (yield* readRecords()).revision,
              }),
            );
            expect(applyAsWorkload.status).toBe(403);
            const recordsAsWorkload = yield* crmRequest(
              '/reads/records',
              yield* requireIssued(yield* workloadContext('crm')),
              yield* HttpBody.json({}),
            );
            expect(recordsAsWorkload.status).toBe(403);

            const pendingAsWorkload = yield* crmRequest(
              '/reads/pending-client-intake',
              yield* requireIssued(yield* workloadContext('crm')),
              yield* HttpBody.json({}),
            );
            expect(pendingAsWorkload.status).toBe(200);
            yield* pendingAsWorkload.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PendingIntakeSchema)));

            // 1 (continued). The person creates a CRM client; CRM's intake, acting as the workload with the key the
            // platform handed it, creates the client's Party and Counterparty and links them.
            const firstClient = yield* createLinkedClient(`Workload intake client ${yield* crypto.randomUUIDv4()}`);
            yield* Effect.logInfo('CRM client created by the person and linked by the intake workload', {
              linked: true,
            });
            const linkedNow = yield* crmRequest(
              '/reads/pending-client-intake',
              yield* requireIssued(yield* workloadContext('crm')),
              yield* HttpBody.json({ clientIds: [firstClient.clientId] }),
            );
            expect(linkedNow.status).toBe(200);
            const pending = yield* linkedNow.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PendingIntakeSchema)));
            expect(pending.items).toEqual([{ id: firstClient.clientId, linked: true }]);

            // 4. Rotation in the running CRM: the next pass of the host hands CRM fresh keys on the same channel, the
            // host retires the keys of its earlier boot, and the next client still links, in the same process.
            const bootTwo = yield* crypto.randomUUIDv4();
            const second = yield* provision(bootTwo);
            expect(second.failedAppIds).toEqual([]);
            const rotatedWorkloadKey = yield* present(second.workloadCredentials.get(entry), 'rotated workload key');
            expect(Redacted.value(rotatedWorkloadKey) === Redacted.value(workloadKey)).toBe(false);
            yield* handOver(second);
            const retired = yield* retireOwnModuleCredentials({
              bootId: bootTwo,
              compositionRevision: revision,
              earlierBoots: new Set([bootOne]),
              hostId,
              operationId: yield* crypto.randomUUIDv4(),
              replaced: new Set(),
            }).pipe(Effect.provide(platform));
            expect(retired.retired).toBe(first.providerKeyIds.size);
            expect(Exit.isFailure(yield* Effect.exit(keys.verify(Redacted.value(workloadKey))))).toBe(true);
            expect(yield* workloadContext('crm')).toEqual({ refused: 401 });
            expect(yield* delegate(crmModuleKey, rotatedWorkloadKey)).toEqual({ refused: 401 });
            const secondClient = yield* createLinkedClient(`Rotated intake client ${yield* crypto.randomUUIDv4()}`);
            expect(secondClient.partyId).not.toBe(firstClient.partyId);
            expect(yield* crm.child.isRunning).toBe(true);
            expect(crm.child.pid).toBe(crmPid);
            yield* Effect.logInfo('CRM intake workload proof complete', {
              clients: 2,
              rotatedInPlace: true,
            });
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
      Effect.timeout('240 seconds'),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          Reactivity.layer,
          makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
        ),
      ),
    ),
  300_000,
);
