import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import {
  issueApiKeyGatewayContext,
  issueRelayedGatewayContext,
} from '@app/shared-contracts/server/gateway-context-api-key';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import {
  ActiveApplicationCompositionSnapshotSchema,
  ApplicationCompositionAuthorityError,
  CoreSearchResourceRefSchema,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
  validateActiveApplicationCompositionSnapshot,
  TrustedPrincipalContextSchema,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  makePrincipalResolver,
  makeContextAccessLive,
  makeContextPermissionRelationshipMutationLive,
  PrincipalResolver,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '@app/core-runtime';
import {
  createPartyWithAuthorization,
  executePartyContactPointDetailWithAuthorization,
  executePartyDetailWithAuthorization,
  PartyContactPointDetailAuthenticationProblemSchema,
} from '@app/party-registry/api/client';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  deleteTestCoreOutbox,
  makeLiveOperationFixture,
  publishTestApplicationCompositionAuthority,
  testCoreDatabase,
} from '@app/core-runtime/testing/owner-evidence';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { v1 } from '@authzed/authzed-node';
import { getCookies } from 'better-auth/cookies';
import { Brand, Config, Crypto, DateTime, Duration, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Cookies, HttpBody, HttpClient } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
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

const PARTY_MODULE_KEY = 'party.registry';
type PartySubjectKey = NonNullable<
  Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
>[number]['subjectKey'];
const nativeManufacturerSubjectKey = Brand.nominal<PartySubjectKey>()('manufacturer-subject');

// Catalog's emitted public product-detail contract declares this shared Problem Details schema.
const CatalogProductAuthenticationProblemSchema = makeProblemDetailsSchema('ProductDetailAuthenticationProblem', 401);

const makePackagedShellUserFixture = Effect.fn('ServerOwnerRelayNative.makePackagedShellUserFixture')(
  function* makePackagedShellUserFixture(
    compositionUrl?: string,
    additionalActionKeys: readonly string[] = [],
    gatewayMaterial?: { readonly privateJwk: Redacted.Redacted; readonly publicJwks: string },
  ) {
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
        actionKeys: [
          'core.identity.create-non-human-principal',
          'core.identity.bind-managed-api-key',
          ...additionalActionKeys,
        ],
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
    if (gatewayMaterial !== undefined) {
      Object.assign(applicationInput, {
        gateway: { issuer: origin, privateJwk: gatewayMaterial.privateJwk, publicJwks: gatewayMaterial.publicJwks },
      });
    }
    const application = yield* startPackagedApplication(applicationInput);
    return {
      application,
      authentication: applicationInput.authentication,
      configuration,
      core,
      email,
      origin,
      password,
      persistence,
      resolver,
    };
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

const openNativeSpiceClient = Effect.fn('ServerOwnerRelayNative.openSpiceClient')(function* openNativeSpiceClient() {
  const settings = yield* Config.all({
    certificate: Config.String('SPICEDB_CA_CERT'),
    endpoint: Config.String('SPICEDB_ENDPOINT'),
    key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      v1.NewClientWithCustomCert(Redacted.value(settings.key), settings.endpoint, Buffer.from(settings.certificate)),
    ),
    (client) => Effect.sync(() => client.close()),
  );
});

const setNativeTenantRole = Effect.fn('ServerOwnerRelayNative.setTenantRole')(function* setNativeTenantRole(
  input: {
    readonly principalId: string;
    readonly relation: string;
    readonly tenantId: string;
  },
  enabled: boolean,
) {
  const client = yield* openNativeSpiceClient();
  yield* Effect.tryPromise({
    catch: () => new PackagedOwnerStartupError({ reason: 'Native fixture tenant role update failed' }),
    try: () =>
      client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: [
            v1.RelationshipUpdate.create({
              operation: enabled ? v1.RelationshipUpdate_Operation.TOUCH : v1.RelationshipUpdate_Operation.DELETE,
              relationship: v1.Relationship.create({
                relation: input.relation,
                resource: { objectId: input.tenantId, objectType: 'tenant' },
                subject: { object: { objectId: input.principalId, objectType: 'principal' } },
              }),
            }),
          ],
        }),
      ),
  });
});

const checkNativeTenantPermission = Effect.fn('ServerOwnerRelayNative.checkTenantPermission')(
  function* checkNativeTenantPermission(input: {
    readonly permission: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) {
    const client = yield* openNativeSpiceClient();
    const result = yield* Effect.tryPromise({
      catch: () => new PackagedOwnerStartupError({ reason: 'Native fixture fully-consistent permission check failed' }),
      try: () =>
        client.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: v1.Consistency.create({
              requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
            }),
            permission: input.permission,
            resource: { objectId: input.tenantId, objectType: 'tenant' },
            subject: { object: { objectId: input.principalId, objectType: 'principal' } },
          }),
        ),
    });
    return result.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
  },
);

const grantNativeCatalogModuleAccess = Effect.fn('ServerOwnerRelayNative.grantCatalogModuleAccess')(
  function* grantNativeCatalogModuleAccess(core: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>) {
    const client = yield* openNativeSpiceClient();
    const moduleId = toModuleAccessObjectId(core.tenantId, core.legalEntityId, 'commerce.catalog');
    const entityId = toLegalEntityAccessObjectId(core.tenantId, core.legalEntityId);
    if (moduleId === undefined || entityId === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Actual Catalog module authorization scope invalid' });
    }
    const relationships = [
      v1.Relationship.create({
        relation: 'legal_entity',
        resource: { objectId: moduleId, objectType: 'module_access' },
        subject: { object: { objectId: entityId, objectType: 'legal_entity' } },
      }),
      v1.Relationship.create({
        relation: 'accessor',
        resource: { objectId: moduleId, objectType: 'module_access' },
        subject: { object: { objectId: core.manager.principalId, objectType: 'principal' } },
      }),
    ];
    const write = (operation: v1.RelationshipUpdate_Operation) =>
      Effect.tryPromise({
        catch: () => new PackagedOwnerStartupError({ reason: 'Actual Catalog module permission fixture write failed' }),
        try: () =>
          client.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
            }),
          ),
      });
    yield* Effect.acquireRelease(write(v1.RelationshipUpdate_Operation.TOUCH), () =>
      write(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie),
    );
    return yield* Effect.void;
  },
);

const issueNativeApiKeyGatewayAuthorization = Effect.fn('ServerOwnerRelayNative.issueApiKeyGatewayAuthorization')(
  function* issueNativeApiKeyGatewayAuthorization(input: {
    readonly apiKey: Redacted.Redacted;
    readonly audience: 'catalog' | 'party-registry';
    readonly authBindingId: string;
    readonly authContextRef: Redacted.Redacted;
    readonly buildMarker: string;
    readonly legalEntityId?: string;
    readonly origin: string;
    readonly principalId: string;
    readonly publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
    readonly revision: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const payload: Parameters<typeof issueApiKeyGatewayContext>[0] = {
      audience: input.audience,
      compositionRevision: input.revision,
    };
    if (input.legalEntityId !== undefined) {
      Object.assign(payload, { legalEntityId: input.legalEntityId });
    }
    const issued = yield* issueApiKeyGatewayContext(payload, {
      apiKey: input.apiKey,
      baseUrl: `${input.origin}/shell-super-app-api`,
      requestCorrelation: yield* crypto.randomUUIDv4(),
    }).pipe(
      Effect.tapError((error) =>
        Schema.is(Schema.Struct({ code: Schema.String, status: Schema.Number }))(error)
          ? Effect.logInfo('Declared public personal-key gateway issuance failure', {
              code: error.code,
              status: error.status,
            })
          : Effect.logInfo('Public personal-key gateway issuance failure', { declaredProblem: false }),
      ),
      Effect.mapError(
        () => new PackagedOwnerStartupError({ reason: 'Actual public personal-key gateway issuance failed' }),
      ),
    );
    yield* Effect.logInfo('Real native personal-key gateway issued', { audience: input.audience });
    const token = Redacted.make(issued.token);
    const verified = yield* Effect.tryPromise({
      catch: () => new PackagedOwnerStartupError({ reason: 'Actual issued gateway signature verification failed' }),
      try: () => jwtVerify(Redacted.value(token), input.publicKey, { audience: input.audience, issuer: input.origin }),
    });
    const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload).pipe(
      Effect.mapError(
        () => new PackagedOwnerStartupError({ reason: 'Actual gateway claims failed the public v2 contract' }),
      ),
    );
    expect(claims.sub).toBe(input.principalId);
    expect(claims.principal.authBindingId).toBe(input.authBindingId);
    expect(claims.principal.authMethod).toBe('api_key');
    expect(claims.principal.legalEntityId).toBe(input.legalEntityId);
    expect(claims.principal.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
    expect(claims.compositionRevision).toBe(input.revision);
    expect(claims.targetBuildMarker).toBe(input.buildMarker);
    expect(issued.compositionRevision).toBe(input.revision);
    return {
      apiUrl: new URL(issued.apiBaseUrl, input.origin),
      authorization: Redacted.make(`Bearer ${Redacted.value(token)}`),
      compositionRevision: issued.compositionRevision,
      sourceAssertion: token,
      sourceJti: claims.jti,
    };
  },
);

const OutsideRelayProblemSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  status: Schema.Number,
  title: Schema.String,
  type: Schema.String,
});
type OutsideRelayFailure =
  | Effect.Error<ReturnType<typeof issueRelayedGatewayContext>>
  | Effect.Error<ReturnType<typeof executePartyDetailWithAuthorization>>;
const observeOutsideRelayFailure = (
  error: OutsideRelayFailure,
  stage: 'issuer' | 'provider' | 'provider-with-explicit-real-le',
) =>
  Schema.is(OutsideRelayProblemSchema)(error)
    ? Effect.logInfo('Diagnostic outside-Action public failure', {
        code: error.code,
        stage,
        status: error.status,
        title: error.title,
        type: error.type,
      })
    : Effect.logInfo('Diagnostic outside-Action unproven response', { declaredProblem: false, stage });

interface ExplicitPartyScopeDiagnostic {
  readonly apiKey: Redacted.Redacted;
  readonly authBindingId: string;
  readonly authContextRef: Redacted.Redacted;
  readonly buildMarker: string;
  readonly database: NativeCoreDatabase;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
}
const diagnoseExplicitPartyLegalEntity = Effect.fn('ServerOwnerRelayNative.diagnoseExplicitPartyLegalEntity')(
  function* diagnoseExplicitPartyLegalEntity(input: {
    readonly actor: ExplicitPartyScopeDiagnostic;
    readonly partyRef: Parameters<typeof executePartyDetailWithAuthorization>[0]['partyRef'];
    readonly requestCorrelation: string;
    readonly revision: string;
    readonly shellOrigin: string;
  }) {
    const { actor } = input;
    const before = yield* actor.database.query.dataAccessEvents.findMany({
      where: { servingModuleKey: PARTY_MODULE_KEY, tenantId: input.partyRef.tenantId },
    });
    const existingIds = new Set(before.map((row) => row.dataAccessEventId));
    // Existing public P-key producer validates this real LE; original Catalog proof and relay scope stay tenant-only.
    const authorization = yield* issueNativeApiKeyGatewayAuthorization({
      apiKey: actor.apiKey,
      audience: 'party-registry',
      authBindingId: actor.authBindingId,
      authContextRef: actor.authContextRef,
      buildMarker: actor.buildMarker,
      legalEntityId: actor.legalEntityId,
      origin: input.shellOrigin,
      principalId: actor.principalId,
      publicKey: actor.publicKey,
      revision: input.revision,
    });
    yield* executePartyDetailWithAuthorization(
      { partyRef: input.partyRef },
      Redacted.value(authorization.authorization),
      input.requestCorrelation,
      { baseUrl: authorization.apiUrl, compositionRevision: authorization.compositionRevision },
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) => observeOutsideRelayFailure(error, 'provider-with-explicit-real-le'),
        onSuccess: (detail) =>
          Effect.gen(function* recordExplicitScopeDiagnostic() {
            expect(detail.party.partyRef).toEqual(input.partyRef);
            const after = yield* actor.database.query.dataAccessEvents.findMany({
              where: { servingModuleKey: PARTY_MODULE_KEY, tenantId: input.partyRef.tenantId },
            });
            const matchingAudit = after.some(
              (row) =>
                !existingIds.has(row.dataAccessEventId) &&
                row.outcomeCode === 'read_allowed' &&
                row.outcome === 'allowed' &&
                row.principalId === actor.principalId &&
                row.authBindingId === actor.authBindingId &&
                row.authContextRef === Redacted.value(actor.authContextRef) &&
                row.authMethod === 'api_key',
            );
            yield* Effect.logInfo('Diagnostic explicit real Party LE result', {
              acceptanceEvidence: false,
              actorAndPersonalReferencePreservedInAudit: matchingAudit,
              exactIssuerDestinationUsed: true,
              originalCatalogScopeUnchanged: true,
              providerSucceeded: true,
              signedLegalEntityMatchesFixture: true,
            });
          }),
      }),
    );
  },
);

const diagnoseOutsideManufacturerTransaction = Effect.fn(
  'ServerOwnerRelayNative.diagnoseOutsideManufacturerTransaction',
)(function* diagnoseOutsideManufacturerTransaction(input: {
  readonly compositionRevision: string;
  readonly explicitPartyScope: ExplicitPartyScopeDiagnostic;
  readonly partyRef: Parameters<typeof executePartyDetailWithAuthorization>[0]['partyRef'];
  readonly requestCorrelation: string;
  readonly shellOrigin: string;
  readonly sourceAssertion: Redacted.Redacted;
  readonly sourceWorkloadApiKey: Redacted.Redacted;
}) {
  const crypto = yield* Crypto.Crypto;
  const issued = yield* issueRelayedGatewayContext(
    {
      audience: 'party-registry',
      compositionRevision: input.compositionRevision,
      exchangeId: yield* crypto.randomUUIDv4(),
      operationKey: 'party.registry.api.party-detail',
      sourceAssertion: Redacted.value(input.sourceAssertion),
    },
    {
      apiKey: input.sourceWorkloadApiKey,
      baseUrl: `${input.shellOrigin}/shell-super-app-api`,
      requestCorrelation: input.requestCorrelation,
    },
  ).pipe(
    Effect.matchEffect({
      onFailure: (error) => observeOutsideRelayFailure(error, 'issuer').pipe(Effect.as(null)),
      onSuccess: (response) => Effect.succeed(response),
    }),
  );
  if (issued === null) {
    return yield* Effect.void;
  }
  expect(issued.compositionRevision).toBe(input.compositionRevision);
  yield* Effect.logInfo('Diagnostic outside-Action relay issuer succeeded', {
    acceptanceEvidence: false,
    sourceWorkloadAttestation: true,
  });
  const authorization = Redacted.make(`Bearer ${issued.token}`);
  // This is exactly the issuer-governed Shell destination, never a test proxy or substituted owner URL.
  const apiUrl = new URL(issued.apiBaseUrl, input.shellOrigin);
  yield* executePartyDetailWithAuthorization(
    { partyRef: input.partyRef },
    Redacted.value(authorization),
    input.requestCorrelation,
    {
      baseUrl: apiUrl,
      compositionRevision: issued.compositionRevision,
    },
  ).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        observeOutsideRelayFailure(error, 'provider').pipe(
          Effect.andThen(
            diagnoseExplicitPartyLegalEntity({
              actor: input.explicitPartyScope,
              partyRef: input.partyRef,
              requestCorrelation: input.requestCorrelation,
              revision: input.compositionRevision,
              shellOrigin: input.shellOrigin,
            }),
          ),
        ),
      onSuccess: (detail) =>
        Effect.sync(() => {
          expect(detail.party.partyRef).toEqual(input.partyRef);
          expect(detail.party.revision).toBeGreaterThan(0);
        }).pipe(
          Effect.andThen(
            Effect.logInfo('Diagnostic outside-Action real Party Detail succeeded', {
              acceptanceEvidence: false,
              exactIssuerDestinationUsed: true,
              issuedPartyCredentialConsumedByActualRead: true,
            }),
          ),
        ),
    }),
  );
  return yield* Effect.void;
});

const logCatalogActionProblem = Effect.fn('ServerOwnerRelayNative.logCatalogActionProblem')(
  function* logCatalogActionProblem(
    response: HttpClientResponse.HttpClientResponse,
    diagnostics: readonly Redacted.Redacted[],
    action: 'create-product' | 'set-product-manufacturer' | 'manufacturer-relation-current',
  ) {
    const problem = yield* response.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            code: Schema.optionalKey(Schema.String),
            status: Schema.Number,
            title: Schema.String,
            type: Schema.String,
          }),
        ),
      ),
    );
    const diagnostic = diagnostics.map((line) => Redacted.value(line)).join('\n');
    const categories = [
      'ConfigError',
      'DatabaseConfigError',
      'ActionTransactionError',
      'OperationContextUnavailable',
      'Service not found',
      'Cannot find module',
      'ERR_MODULE_NOT_FOUND',
      'ReferenceError',
      'TypeError',
      'PERMISSION_DENIED',
    ].filter((category) => diagnostic.includes(category));
    const configurationKeys = [
      ...new Set(
        [
          ...diagnostic.matchAll(
            /\b(?:APP_ENV_PATH|(?:BETTER_AUTH|DATABASE|SHELL_GATEWAY|ONTOS_GATEWAY|SPICEDB|ULTRAMODERN|ONTOS_ACTIVE)[A-Z0-9_]*)\b/gu,
          ),
        ].map((match) => match[0]),
      ),
    ];
    const missingServices = [
      ...new Set(
        [
          ...diagnostic.matchAll(
            /Service not found: (?<service>(?:effect|@app|@effect|@modern-js)\/[A-Za-z0-9@_./:-]{1,200})/gu,
          ),
        ]
          .map((match) => match.groups?.['service'])
          .filter((service) => service !== undefined),
      ),
    ];
    yield* Effect.logInfo('Sanitized actual Catalog Action failure', {
      action,
      categories,
      code: problem.code,
      keys: configurationKeys,
      missingServices,
      status: problem.status,
      title: problem.title,
      type: problem.type,
    });
  },
);

type NativeCoreDatabase = Effect.Success<typeof testCoreDatabase>;
const assertNativeManagedIdentityActions = Effect.fn('ServerOwnerRelayNative.assertManagedIdentityActions')(
  function* assertNativeManagedIdentityActions(
    database: NativeCoreDatabase,
    input: {
      readonly authContextRef: Redacted.Redacted;
      readonly principalId: string;
      readonly tenantId: string;
    },
  ) {
    const invocations = yield* database.query.actionInvocations.findMany({ where: { tenantId: input.tenantId } });
    for (const actionKey of ['core.identity.create-non-human-principal', 'core.identity.bind-managed-api-key']) {
      const invocation = invocations.find((entry) => entry.actionKey === actionKey);
      expect(invocation?.status).toBe('succeeded');
      expect(invocation?.principalId).toBe(input.principalId);
      expect(invocation?.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
    }
    return invocations.length;
  },
);

const assertNativeManufacturerMutationAudit = Effect.fn('ServerOwnerRelayNative.assertManufacturerMutationAudit')(
  function* assertNativeManufacturerMutationAudit(
    database: NativeCoreDatabase,
    input: {
      readonly authBindingId: string;
      readonly authContextRef: Redacted.Redacted;
      readonly principalId: string;
      readonly productResourceId: string;
      readonly tenantId: string;
    },
  ) {
    const invocation = yield* database.query.actionInvocations.findFirst({
      where: { actionKey: 'commerce.catalog.set-product-manufacturer', tenantId: input.tenantId },
    });
    expect(invocation?.status).toBe('succeeded');
    expect(invocation?.legalEntityId).toBeNull();
    expect(invocation?.authBindingId).toBe(input.authBindingId);
    expect(invocation?.authMethod).toBe('api_key');
    expect(invocation?.targetResourceId).toBe(input.productResourceId);
    expect(invocation?.principalId).toBe(input.principalId);
    expect(invocation?.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
  },
);

type NativeShellUserFixture = Effect.Success<ReturnType<typeof makePackagedShellUserFixture>>;
const grantNativeManufacturerReadPermissions = Effect.fn('ServerOwnerRelayNative.grantManufacturerReadPermissions')(
  function* grantNativeManufacturerReadPermissions(fixture: NativeShellUserFixture, servicePrincipalId: string) {
    const { spice } = fixture.authentication;
    const settings = {
      caCertificate: spice.caCertificate,
      endpoint: spice.endpoint,
      get preSharedKey() {
        return Redacted.value(spice.preSharedKey);
      },
    };
    const mutation = yield* makeContextPermissionRelationshipMutationLive(undefined, () => Effect.succeed(settings));
    const access = yield* makeContextAccessLive(undefined, () => Effect.succeed(settings));
    const check = access.contextPermissions;
    if (check === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Real scoped context permission reader is unavailable' });
    }
    const scopes = [
      {
        label: 'party-tenant-module',
        legalEntityId: null,
        target: { moduleId: PARTY_MODULE_KEY, permission: 'module.access' },
      },
      {
        label: 'catalog-selected-le-current-read',
        legalEntityId: fixture.core.legalEntityId,
        target: { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.manufacturer-relation-current' },
      },
    ];
    for (const scoped of scopes) {
      const binding = {
        principal: { principalId: fixture.core.manager.principalId, tenantId: fixture.core.tenantId },
        target: scoped.target,
        tenantId: fixture.core.tenantId,
      };
      const originalActorRequest = {
        principalId: fixture.core.manager.principalId,
        targets: [scoped.target],
        tenantId: fixture.core.tenantId,
      };
      const serviceActorRequest = {
        principalId: servicePrincipalId,
        targets: [scoped.target],
        tenantId: fixture.core.tenantId,
      };
      if (scoped.legalEntityId !== null) {
        Object.assign(binding, { legalEntityId: scoped.legalEntityId });
        Object.assign(originalActorRequest, { legalEntityId: scoped.legalEntityId });
        Object.assign(serviceActorRequest, { legalEntityId: scoped.legalEntityId });
      }
      // Register each exact P-only scoped revoke before its real grant. Workload S receives no grant.
      yield* Effect.addFinalizer(() =>
        mutation.mutate({ operation: 'revoke', ...binding }).pipe(
          Effect.andThen(check(originalActorRequest)),
          Effect.tap((decisions) =>
            Effect.sync(() => {
              expect(decisions).toHaveLength(1);
              expect(decisions[0]?.decision).toBe('denied');
            }),
          ),
          Effect.andThen(
            Effect.logInfo('Native exact scoped read grant cleanup verified', {
              originalActorDeniedAfterExactRevoke: true,
              scope: scoped.label,
            }),
          ),
          Effect.orDie,
        ),
      );
      yield* mutation.mutate({ operation: 'grant', ...binding });
      const originalActor = yield* check(originalActorRequest);
      const serviceActor = yield* check(serviceActorRequest);
      expect(originalActor).toHaveLength(1);
      expect(originalActor[0]?.decision).toBe('allowed');
      expect(serviceActor).toHaveLength(1);
      expect(serviceActor[0]?.decision).toBe('denied');
      yield* Effect.logInfo('Native exact scoped read grant verified', {
        originalActorAllowed: true,
        scope: scoped.label,
        sourceWorkloadIndependentlyDenied: true,
      });
    }
    return yield* Effect.void;
  },
);

const issueNativeOriginalHumanKey = Effect.fn('ServerOwnerRelayNative.issueOriginalHumanKey')(
  function* issueNativeOriginalHumanKey(
    fixture: NativeShellUserFixture,
    database: NativeCoreDatabase,
    keys: Effect.Success<ReturnType<typeof makeApiKeyService>>,
    input: {
      readonly cookie: Redacted.Redacted;
      readonly sessionAuthContextRef: Redacted.Redacted;
      readonly workloadBindingId: string;
      readonly workloadPrincipalId: string;
    },
  ) {
    const client = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const personalIssue = yield* client.post(
      `${fixture.origin}${fixture.application.apiPrefix}/auth/identity/api-keys/self`,
      {
        body: yield* HttpBody.json({ name: 'Native original human' }),
        headers: {
          cookie: Redacted.value(input.cookie),
          'idempotency-key': yield* crypto.randomUUIDv4(),
          origin: fixture.origin,
          'x-correlation-id': yield* crypto.randomUUIDv4(),
        },
      },
    );
    yield* Effect.logInfo('Real original-human personal key HTTP result', { status: personalIssue.status });
    expect(personalIssue.status).toBe(200);
    const personalKey = yield* personalIssue.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(ApiKeyIssueResponseSchema))),
      Effect.mapError(
        () => new PackagedOwnerStartupError({ reason: 'Personal key response failed its public JSON codec' }),
      ),
    );
    const personalProvider = yield* keys.verify(Redacted.value(personalKey.secret));
    const originalHuman = yield* fixture.resolver.resolveBetterAuthApiKey(personalProvider.providerKeyId);
    expect(originalHuman.principalId).toBe(fixture.core.manager.principalId);
    expect(originalHuman.principalId).not.toBe(input.workloadPrincipalId);
    expect(originalHuman.authBindingId).toBe(personalKey.authBindingId);
    expect(originalHuman.authBindingId).not.toBe(input.workloadBindingId);
    expect(originalHuman.tenantId).toBe(fixture.core.tenantId);
    const personalBinding = yield* database.query.principalAuthBindings.findFirst({
      where: { principalAuthBindingId: personalKey.authBindingId },
    });
    expect(personalBinding?.principalId).toBe(fixture.core.manager.principalId);
    expect(personalBinding?.subjectType).toBe('api_key');
    expect(personalBinding?.providerSubjectId === personalProvider.providerKeyId).toBe(true);
    expect(personalBinding?.authenticationNamespaceId).toBe(STAFF_AUTHENTICATION_NAMESPACE_ID);
    const personalAuthContextRef = Redacted.make(`better-auth-api-key:${personalProvider.providerKeyId}`);
    expect(Redacted.value(personalAuthContextRef) === Redacted.value(input.sessionAuthContextRef)).toBe(false);
    const personalInvocation = yield* database.query.actionInvocations.findFirst({
      where: { actionKey: 'core.identity.bind-self-api-key', tenantId: fixture.core.tenantId },
    });
    expect(personalInvocation?.status).toBe('succeeded');
    expect(personalInvocation?.principalId).toBe(fixture.core.manager.principalId);
    expect(personalInvocation?.authContextRef === Redacted.value(input.sessionAuthContextRef)).toBe(true);
    yield* Effect.logInfo('Original human personal key independently verified', {
      actorUnchanged: true,
      bindingDistinctFromWorkload: true,
      sessionOnlyProvisionsThePersonalKey: true,
    });

    return { personalAuthContextRef, personalKey };
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

it.live('completes the real Catalog to Party Manufacturer happy path with the original authenticated actor', () =>
  Effect.gen(function* realManufacturerHappyPath() {
    const children: ChildProcessHandle[] = [];
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* completeRealManufacturerHappyPath() {
          const signingKeyPair = yield* Effect.tryPromise(() =>
            generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
          );
          const signingCrypto = yield* Crypto.Crypto;
          const signingKid = `native-${yield* signingCrypto.randomUUIDv4()}`;
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
          const fixture = yield* makePackagedShellUserFixture(
            compositionUrl,
            [
              'core.identity.bind-self-api-key',
              'party.registry.create-party',
              'commerce.catalog.create-product',
              'commerce.catalog.set-product-manufacturer',
            ],
            gatewayMaterial,
          );
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'initial-shell-fixture-returned' });
          const cleanupConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'cleanup-config-loaded' });
          const releaseDisposableManufacturerQueue = Effect.fn(
            'ServerOwnerRelayNative.releaseDisposableManufacturerQueue',
          )(function* releaseDisposableManufacturerQueue() {
            yield* Effect.logInfo('Disposable Manufacturer queue release started', { tenantId: fixture.core.tenantId });
            const cleanupAdmin = yield* PgClient.make({
              url: Redacted.make(cleanupConnections.admin.connectionString),
            });
            const cleanupDatabase = yield* testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, cleanupAdmin),
            );
            yield* deleteTestCoreOutbox(cleanupAdmin, fixture.core.tenantId);
            const remaining = yield* cleanupDatabase.query.outboxMessages.findMany({
              where: { tenantId: fixture.core.tenantId },
            });
            expect(remaining).toHaveLength(0);
            yield* Effect.logInfo('Disposable Manufacturer fixture dispatch queue released', {
              queueCount: 0,
              tenantId: fixture.core.tenantId,
            });
          });
          // Receivers stop before this fresh scoped cleanup; canonical/domain/access evidence remains retained.
          yield* Effect.addFinalizer(() =>
            releaseDisposableManufacturerQueue().pipe(Effect.scoped, Effect.timeout('10 seconds'), Effect.orDie),
          );
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'cleanup-finalizer-registered' });

          const shell = fixture.application;
          children.push(shell.child);
          const party = yield* startPackagedApplication({
            appId: 'party-registry',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            relativeDirectory: '../../verticals/party-registry',
          });
          children.push(party.child);
          const catalog = yield* startPackagedApplication({
            appId: 'catalog',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            relativeDirectory: '../../verticals/catalog',
          });
          children.push(catalog.child);
          const client = yield* HttpClient.HttpClient;
          const observe = Effect.fn('ServerOwnerRelayNative.observeCompositionArtifact')(
            function* observeCompositionArtifact(url: string) {
              yield* Effect.logInfo('Native Manufacturer artifact observation', { phase: 'request', url });
              const response = yield* client
                .get(url, { headers: { 'cache-control': 'no-cache' } })
                .pipe(Effect.timeout('10 seconds'));
              yield* Effect.logInfo('Native Manufacturer artifact observation', {
                phase: 'headers',
                status: response.status,
                url,
              });
              expect(response.status).toBe(200);
              const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.timeout('10 seconds')));
              yield* Effect.logInfo('Native Manufacturer artifact observation', {
                byteCount: bytes.length,
                phase: 'body',
                url,
              });
              return { bytes, url };
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
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'snapshot-derived' });
          const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'snapshot-validated' });
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
          const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'authority-publication-start' });
          yield* database
            .transaction(
              Effect.fn('ServerOwnerRelayNative.drainPreviousAuthority')(function* drainPreviousAuthority(transaction) {
                yield* lockApplicationCompositionPublication(transaction);
                const previous = yield* transaction.query.applicationCompositionAuthority.findFirst({
                  where: { authorityKey: 'active' },
                });
                if (previous !== undefined && previous.revision !== approved.composition.revision) {
                  if (
                    previous.phase !== 'active' &&
                    !(previous.phase === 'draining' && previous.durableWorkAdmission === 'closed')
                  ) {
                    return yield* new PackagedOwnerStartupError({
                      reason:
                        'Previous fixture authority is outside the supported active or closed-draining lifecycle states',
                    });
                  }
                  if (previous.phase === 'active') {
                    yield* closeApplicationCompositionDurableAdmission(transaction, previous.revision);
                  }
                  yield* drainApplicationCompositionAuthority(transaction, previous.revision);
                }
                return yield* Effect.void;
              }),
            )
            .pipe(
              Effect.tapError((error) =>
                Schema.is(ApplicationCompositionAuthorityError)(error)
                  ? Effect.logInfo('Declared native Composition lifecycle failure before cleanup', {
                      code: error.code,
                      reason: error.reason,
                    })
                  : Effect.logInfo('Native Composition lifecycle failure before cleanup', {
                      declaredAuthorityError: false,
                    }),
              ),
            );
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'previous-authority-drained' });
          yield* publishTestApplicationCompositionAuthority(database, approved).pipe(
            Effect.tapError((error) =>
              Schema.is(ApplicationCompositionAuthorityError)(error)
                ? Effect.logInfo('Declared native Composition lifecycle failure before cleanup', {
                    code: error.code,
                    reason: error.reason,
                  })
                : Effect.logInfo('Native Composition lifecycle failure before cleanup', {
                    declaredAuthorityError: false,
                  }),
            ),
          );
          yield* Effect.logInfo('Native Manufacturer setup phase', { phase: 'authority-published' });
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
          const identityActionCount = yield* assertNativeManagedIdentityActions(database, {
            authContextRef: Redacted.make(realAuthContextRef),
            principalId: fixture.core.manager.principalId,
            tenantId: fixture.core.tenantId,
          });
          yield* Effect.logInfo('Real managed service credential independently verified', {
            actionCount: identityActionCount,
            compositionRevision: approved.composition.revision,
            namespaceMatches: true,
            originalActorPreservedInCanonicalActions: true,
            serviceDistinctFromActor: true,
          });

          const { personalAuthContextRef, personalKey } = yield* issueNativeOriginalHumanKey(fixture, database, keys, {
            cookie,
            sessionAuthContextRef: Redacted.make(realAuthContextRef),
            workloadBindingId: issued.authBindingId,
            workloadPrincipalId: serviceId,
          });

          expect(yield* shell.child.isRunning).toBe(true);
          yield* shell.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
          expect(yield* shell.child.isRunning).toBe(false);
          const enrolledShell = yield* startPackagedApplication({
            appId: 'shell-super-app',
            authentication: fixture.authentication,
            compositionUrl,
            gateway: {
              issuer: fixture.origin,
              privateJwk: gatewayMaterial.privateJwk,
              publicJwks: gatewayMaterial.publicJwks,
            },
            relativeDirectory: '.',
            sourceBindings: Redacted.make(
              JSON.stringify([
                {
                  compositionRevision: approved.composition.revision,
                  providerKeyId: provider.providerKeyId,
                  sourceAppId: 'catalog',
                  sourceBuildMarker: catalog.compiled.buildMarker,
                },
              ]),
            ),
          });
          children.push(enrolledShell.child);
          expect(enrolledShell.origin).toBe(shell.origin);
          expect(enrolledShell.compiled).toEqual(shell.compiled);
          expect(yield* catalog.child.isRunning).toBe(true);
          yield* catalog.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
          expect(yield* catalog.child.isRunning).toBe(false);
          const enrolledCatalog = yield* startPackagedApplication({
            appId: 'catalog',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            port: Number(new URL(catalog.origin).port),
            relativeDirectory: '../../verticals/catalog',
            relaySource: { apiKey: issued.secret, shellBaseUrl: `${fixture.origin}/shell-super-app-api` },
          });
          children.push(enrolledCatalog.child);
          expect(enrolledCatalog.origin).toBe(catalog.origin);
          expect(enrolledCatalog.compiled).toEqual(catalog.compiled);
          yield* grantNativeCatalogModuleAccess(fixture.core);
          const partyAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
            apiKey: personalKey.secret,
            audience: 'party-registry',
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            buildMarker: party.compiled.buildMarker,
            origin: fixture.origin,
            principalId: fixture.core.manager.principalId,
            publicKey: signingKeyPair.publicKey,
            revision: approved.composition.revision,
          });
          yield* Effect.logInfo('Native Manufacturer Party seed started', { phase: 'actual-public-party-create' });
          const createdParty = yield* createPartyWithAuthorization(
            {
              candidate: {
                displayName: 'Native manufacturer organization',
                evidenceRefs: ['native/manufacturer'],
                officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
                partyType: 'ORGANIZATION',
                provenance: { method: 'DOCUMENT', source: 'native-manufacturer-proof' },
                subjectEvidence: [
                  {
                    basis: 'REVIEWED_DOCUMENT',
                    evidenceRef: 'native/manufacturer',
                    kind: 'ACTOR_ATTESTATION',
                    observedSubject: 'ORGANIZATION',
                    statement: 'Reviewed this concrete external organization',
                    subjectKey: nativeManufacturerSubjectKey,
                  },
                ],
                validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
              },
            },
            Redacted.value(partyAuthorization.authorization),
            {
              baseUrl: `${party.origin}${party.apiPrefix}`,
              compositionRevision: approved.composition.revision,
              correlationId: yield* crypto.randomUUIDv4(),
              idempotencyKey: yield* crypto.randomUUIDv4(),
            },
          );
          expect(createdParty.outcome).toBe('CREATED');
          if (createdParty.outcome !== 'CREATED') {
            return yield* new PackagedOwnerStartupError({
              reason: 'Actual verified Party seed did not create a fresh identity',
            });
          }
          const { partyRef } = createdParty;
          yield* setNativeTenantRole(
            {
              principalId: fixture.core.manager.principalId,
              relation: 'party_identity_manager',
              tenantId: fixture.core.tenantId,
            },
            false,
          );
          yield* Effect.acquireRelease(
            setNativeTenantRole(
              {
                principalId: fixture.core.manager.principalId,
                relation: 'party_identity_reader',
                tenantId: fixture.core.tenantId,
              },
              true,
            ),
            () =>
              setNativeTenantRole(
                {
                  principalId: fixture.core.manager.principalId,
                  relation: 'party_identity_reader',
                  tenantId: fixture.core.tenantId,
                },
                false,
              ).pipe(Effect.scoped, Effect.orDie),
          );
          expect(
            yield* checkNativeTenantPermission({
              permission: 'manage_party_identity',
              principalId: fixture.core.manager.principalId,
              tenantId: fixture.core.tenantId,
            }),
          ).toBe(false);
          expect(
            yield* checkNativeTenantPermission({
              permission: 'read_party_identity',
              principalId: fixture.core.manager.principalId,
              tenantId: fixture.core.tenantId,
            }),
          ).toBe(true);
          expect(
            yield* checkNativeTenantPermission({
              permission: 'read_party_identity',
              principalId: serviceId,
              tenantId: fixture.core.tenantId,
            }),
          ).toBe(false);
          yield* grantNativeManufacturerReadPermissions(fixture, serviceId);
          const createAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
            apiKey: personalKey.secret,
            audience: 'catalog',
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            buildMarker: catalog.compiled.buildMarker,
            origin: fixture.origin,
            principalId: fixture.core.manager.principalId,
            publicKey: signingKeyPair.publicKey,
            revision: approved.composition.revision,
          });
          const productResponse = yield* client.post(
            `${catalog.origin}${catalog.apiPrefix}/catalog/actions/create-product`,
            {
              body: yield* HttpBody.json({
                classification: { kind: 'INDEPENDENT_PRODUCT' },
                reason: 'Native manufacturer proof',
              }),
              headers: {
                authorization: Redacted.value(createAuthorization.authorization),
                'idempotency-key': yield* crypto.randomUUIDv4(),
                'x-correlation-id': yield* crypto.randomUUIDv4(),
                'x-ontos-composition-revision': approved.composition.revision,
              },
            },
          );
          yield* Effect.logInfo('Native Manufacturer Catalog product creation HTTP result', {
            status: productResponse.status,
          });
          if (productResponse.status !== 200) {
            yield* logCatalogActionProblem(productResponse, enrolledCatalog.diagnostics, 'create-product');
          }
          expect(productResponse.status).toBe(200);
          const productResult = yield* productResponse.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ product: Schema.Struct({ productRef: CoreSearchResourceRefSchema }) }),
              ),
            ),
          );
          const { productRef } = productResult.product;
          expect(productRef.moduleId).toBe('commerce.catalog');
          expect(productRef.resourceType).toBe('commerce.catalog.product');
          expect(productRef.tenantId).toBe(fixture.core.tenantId);
          yield* fixture.core.grantResourceAccess(productRef, fixture.core.manager.principalId, 'writer');
          yield* fixture.core.grantResourceAccess(productRef, fixture.core.manager.principalId, 'reader');
          const readsBefore = yield* database.query.dataAccessEvents.findMany({
            where: { servingModuleKey: PARTY_MODULE_KEY, tenantId: fixture.core.tenantId },
          });
          const previousReads = new Set(readsBefore.map((row) => row.dataAccessEventId));
          const relationId = yield* crypto.randomUUIDv4();
          const setAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
            apiKey: personalKey.secret,
            audience: 'catalog',
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            buildMarker: catalog.compiled.buildMarker,
            origin: fixture.origin,
            principalId: fixture.core.manager.principalId,
            publicKey: signingKeyPair.publicKey,
            revision: approved.composition.revision,
          });
          const setCorrelation = yield* crypto.randomUUIDv4();
          const setResponse = yield* client.post(
            `${catalog.origin}${catalog.apiPrefix}/catalog/actions/set-product-manufacturer`,
            {
              body: yield* HttpBody.json({
                effectivePeriod: {},
                evidenceRefs: ['native/manufacturer'],
                reason: 'Manufacturer identity verified through Party',
                relationId,
                subject: productRef,
                target: { kind: 'PARTY', partyRef },
              }),
              headers: {
                authorization: Redacted.value(setAuthorization.authorization),
                'idempotency-key': yield* crypto.randomUUIDv4(),
                'x-correlation-id': setCorrelation,
                'x-ontos-composition-revision': approved.composition.revision,
              },
            },
          );
          yield* Effect.logInfo('Native Manufacturer real server adapter HTTP result', { status: setResponse.status });
          const sourceExchange = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
            where: { sourceJti: setAuthorization.sourceJti },
          });
          yield* Effect.logInfo('Native Manufacturer relay stage evidence', {
            sourceExchangeRecorded: sourceExchange !== undefined,
          });
          if (setResponse.status !== 200) {
            yield* logCatalogActionProblem(
              setResponse,
              [...enrolledCatalog.diagnostics, ...enrolledShell.diagnostics],
              'set-product-manufacturer',
            );
            yield* diagnoseOutsideManufacturerTransaction({
              compositionRevision: approved.composition.revision,
              explicitPartyScope: {
                apiKey: personalKey.secret,
                authBindingId: personalKey.authBindingId,
                authContextRef: personalAuthContextRef,
                buildMarker: party.compiled.buildMarker,
                database,
                legalEntityId: fixture.core.legalEntityId,
                principalId: fixture.core.manager.principalId,
                publicKey: signingKeyPair.publicKey,
              },
              partyRef,
              requestCorrelation: setCorrelation,
              shellOrigin: fixture.origin,
              sourceAssertion: setAuthorization.sourceAssertion,
              sourceWorkloadApiKey: issued.secret,
            }).pipe(Effect.timeout('20 seconds'));
          }

          expect(setResponse.status).toBe(200);
          const mutation = yield* setResponse.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  relationId: CoreSearchResourceRefSchema.fields.resourceId,
                  revision: Schema.Literal(1),
                  subject: CoreSearchResourceRefSchema,
                }),
              ),
            ),
          );
          expect(mutation.relationId).toBe(relationId);
          expect(mutation.subject).toEqual(productRef);
          const readAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
            apiKey: personalKey.secret,
            audience: 'catalog',
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            buildMarker: catalog.compiled.buildMarker,
            legalEntityId: fixture.core.legalEntityId,
            origin: fixture.origin,
            principalId: fixture.core.manager.principalId,
            publicKey: signingKeyPair.publicKey,
            revision: approved.composition.revision,
          });
          const readResponse = yield* client.post(
            `${catalog.origin}${catalog.apiPrefix}/reads/manufacturer-relation-current`,
            {
              body: yield* HttpBody.json({ subject: productRef }),
              headers: {
                authorization: Redacted.value(readAuthorization.authorization),
                'x-correlation-id': yield* crypto.randomUUIDv4(),
                'x-ontos-composition-revision': approved.composition.revision,
              },
            },
          );
          if (readResponse.status !== 200) {
            yield* logCatalogActionProblem(readResponse, enrolledCatalog.diagnostics, 'manufacturer-relation-current');
          }
          expect(readResponse.status).toBe(200);
          const relationView = yield* readResponse.json;
          expect(relationView).toMatchObject({
            claim: {
              evidenceRefs: ['native/manufacturer'],
              relationId,
              revision: 1,
              subject: productRef,
              target: { kind: 'PARTY', partyRef },
            },
            owner: { canonicalTarget: { kind: 'PARTY', partyRef }, kind: 'PARTY', state: 'CURRENT' },
          });
          yield* assertNativeManufacturerMutationAudit(database, {
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            principalId: fixture.core.manager.principalId,
            productResourceId: productRef.resourceId,
            tenantId: fixture.core.tenantId,
          });
          expect(sourceExchange !== undefined).toBe(true);
          const readsAfter = yield* database.query.dataAccessEvents.findMany({
            where: { servingModuleKey: PARTY_MODULE_KEY, tenantId: fixture.core.tenantId },
          });
          const providerReads = readsAfter.filter(
            (row) =>
              !previousReads.has(row.dataAccessEventId) &&
              row.outcomeCode === 'read_allowed' &&
              row.outcome === 'allowed',
          );
          expect(providerReads.length).toBeGreaterThan(0);
          expect(providerReads.some((row) => row.legalEntityId === null)).toBe(true);
          expect(providerReads.some((row) => row.legalEntityId === fixture.core.legalEntityId)).toBe(true);
          expect(
            providerReads.every(
              (row) =>
                row.principalId === fixture.core.manager.principalId &&
                row.authBindingId === personalKey.authBindingId &&
                row.authContextRef === Redacted.value(personalAuthContextRef) &&
                row.authMethod === 'api_key',
            ),
          ).toBe(true);
          yield* Effect.logInfo('Native Manufacturer happy path verified', {
            actualProviderReadAuditRows: providerReads.length,
            catalogSourceDurablyGrantRedeemed: false,
            compositionRevision: approved.composition.revision,
            defaultServerFactoryAndGovernedPartyDestinationUsed: true,
            originalActorAuthMethod: 'api_key',
            originalActorPreserved: true,
            originalPersonalKeyReferencePreserved: true,
            partyReaderServicePrincipalDenied: true,
            sameOriginsAfterEnrolledRestarts: true,
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
    Effect.timeout('120 seconds'),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Reactivity.layer)),
  ),
);
