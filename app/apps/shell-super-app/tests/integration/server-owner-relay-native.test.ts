import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import {
  executeAttributeGuestRetailCustomerWithAuthorization,
  executeBindRetailPortalProfileWithAuthorization,
  executeAddSavedAddressWithAuthorization,
  executeUpdateSavedAddressWithAuthorization,
  executeEnsureRetailCustomerProfileWithAuthorization,
} from '@app/commerce-customer-context/api/client';
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
  toSpiceDbActionObjectId,
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
  addContactPointWithAuthorization,
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
  PrincipalIdSchema,
  TenantIdSchema,
  ShellAuthenticationRequiredProblemSchema,
  SignInResponseSchema,
} from '../../shared/api.ts';
import {
  allocateLoopbackPort,
  PackagedOwnerStartupError,
  startPackagedApplication,
  loadPackagedRetailWorker,
  startPackagedRetailWorker,
} from '../support/server-owner-relay-native-fixture.ts';

const PARTY_MODULE_KEY = 'party.registry';
type PartySubjectKey = NonNullable<
  Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
>[number]['subjectKey'];
const nativeManufacturerSubjectKey = Brand.nominal<PartySubjectKey>()('manufacturer-subject');

// Catalog's emitted public product-detail contract declares this shared Problem Details schema.
const CatalogProductAuthenticationProblemSchema = makeProblemDetailsSchema('ProductDetailAuthenticationProblem', 401);
const CatalogManufacturerForbiddenProblemSchema = makeProblemDetailsSchema(
  'SetProductManufacturerActionForbiddenProblem',
  403,
  { code: Schema.Literal('manufacturer_target_forbidden') },
);

const makePackagedShellUserFixture = Effect.fn('ServerOwnerRelayNative.makePackagedShellUserFixture')(
  function* makePackagedShellUserFixture(
    compositionUrl?: string,
    additionalActionKeys: readonly string[] = [],
    gatewayMaterial?: { readonly privateJwk: Redacted.Redacted; readonly publicJwks: string },
    moduleKeys: readonly string[] = ['party.registry', 'commerce.catalog'],
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
        actionExecutor: 'manager-only',
        actionKeys: [
          'core.identity.create-non-human-principal',
          'core.identity.bind-managed-api-key',
          ...additionalActionKeys,
        ],
        adminConnectionString: Redacted.make(connections.admin.connectionString),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        // Seed-only configuration; no authority is published and core.layer is never provided.
        compositionRevision: 'a'.repeat(64),
        moduleKeys,
        runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
      }),
      (fixture) => fixture.close().pipe(Effect.orDie),
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
  function* grantNativeCatalogModuleAccess(
    core: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>,
    moduleKey = 'commerce.catalog',
  ) {
    const client = yield* openNativeSpiceClient();
    const moduleId = toModuleAccessObjectId(core.tenantId, core.legalEntityId, moduleKey);
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
    readonly audience: 'catalog' | 'party-registry' | 'commerce-customer-context';
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
    yield* Effect.logInfo('Real native API-key gateway issued', { audience: input.audience });
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
    fixture: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>,
    database: NativeCoreDatabase,
    input: {
      readonly authBindingId: string;
      readonly authContextRef: Redacted.Redacted;
      readonly correlationId: string;
      readonly principalId: string;
      readonly productRef: typeof CoreSearchResourceRefSchema.Type;
      readonly tenantId: string;
    },
  ) {
    const evidence = yield* fixture.evidence(database);
    const invocation = evidence.invocations.find(
      (row) =>
        row.actionKey === 'commerce.catalog.set-product-manufacturer' &&
        row.tenantId === input.tenantId &&
        row.correlationId === input.correlationId,
    );
    if (invocation === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Exact native Manufacturer invocation evidence missing' });
    }
    expect(invocation.status).toBe('succeeded');
    expect(invocation.legalEntityId).toBeNull();
    expect(invocation.authBindingId).toBe(input.authBindingId);
    expect(invocation.authMethod).toBe('api_key');
    // The declared Action target is Tenant-scoped; the product is linked execution evidence.
    expect(invocation.targetModuleKey).toBeNull();
    expect(invocation.targetResourceType).toBeNull();
    expect(invocation.targetResourceId).toBeNull();
    expect(invocation.principalId).toBe(input.principalId);
    expect(invocation.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
    const executedAudits = evidence.audits.filter(
      (row) => row.actionInvocationId === invocation.actionInvocationId && row.eventType === 'action.executed',
    );
    expect(executedAudits).toHaveLength(1);
    for (const audit of executedAudits) {
      expect(audit.tenantId).toBe(input.tenantId);
      expect(audit.legalEntityId).toBeNull();
      expect(audit.principalId).toBe(input.principalId);
      expect(audit.authBindingId).toBe(input.authBindingId);
      expect(audit.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
      expect(audit.authMethod).toBe('api_key');
      expect(audit.outcome).toBe('succeeded');
      expect(audit.outcomeCode).toBe('action_executed');
      expect(audit.outcomeStage).toBe('execution');
      expect(audit.targetModuleKey).toBeNull();
      expect(audit.targetResourceType).toBeNull();
      expect(audit.targetResourceId).toBeNull();
      expect(
        Schema.is(Schema.Struct({ actionKey: Schema.Literal('commerce.catalog.set-product-manufacturer') }))(
          audit.evidenceJson,
        ),
      ).toBe(true);
    }
    const accesses = evidence.accesses.filter(
      (row) => row.actionInvocationId === invocation.actionInvocationId && row.servingModuleKey === 'commerce.catalog',
    );
    expect(accesses).toHaveLength(1);
    for (const access of accesses) {
      expect(access.tenantId).toBe(input.tenantId);
      expect(access.tenantId).toBe(input.productRef.tenantId);
      expect(access.legalEntityId).toBeNull();
      expect(access.principalId).toBe(input.principalId);
      expect(access.authBindingId).toBe(input.authBindingId);
      expect(access.authContextRef === Redacted.value(input.authContextRef)).toBe(true);
      expect(access.authMethod).toBe('api_key');
      expect(access.outcome).toBe('allowed');
      expect(access.outcomeCode).toBe('action_read_allowed');
      expect(access.outcomeStage).toBe('execution');
      expect(access.accessKind).toBe('read');
      expect(access.targetModuleKey).toBe(input.productRef.moduleId);
      expect(access.targetResourceType).toBe(input.productRef.resourceType);
      expect(access.targetResourceId).toBe(input.productRef.resourceId);
      expect(access.queryHash).toBe(
        `catalog-manufacturer-subject:${input.productRef.resourceType}:${input.productRef.resourceId}`,
      );
      expect(access.resultCount).toBe(1);
    }
    return yield* Effect.void;
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
    return { check, mutation };
  },
);

const assertNativeLegalEntityWithPartyStopped = Effect.fn('ServerOwnerRelayNative.legalEntityWithPartyStopped')(
  function* legalEntityWithPartyStopped(input: {
    readonly catalog: Effect.Success<ReturnType<typeof startPackagedApplication>>;
    readonly database: NativeCoreDatabase;
    readonly fixture: NativeShellUserFixture;
    readonly gateway: Omit<
      Parameters<typeof issueNativeApiKeyGatewayAuthorization>[0],
      'audience' | 'buildMarker' | 'legalEntityId' | 'principalId'
    >;
    readonly party: Effect.Success<ReturnType<typeof startPackagedApplication>>;
  }) {
    const { catalog, database, fixture, party } = input;
    const client = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const legalEntityRef = {
      moduleId: 'core.identity',
      resourceId: fixture.core.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: fixture.core.tenantId,
    };
    const entity = yield* database.query.legalEntities.findFirst({
      columns: { legalEntityId: true, status: true, tenantId: true },
      where: { legalEntityId: legalEntityRef.resourceId, tenantId: legalEntityRef.tenantId },
    });
    expect(
      Schema.is(
        Schema.Struct({
          legalEntityId: Schema.Literal(legalEntityRef.resourceId),
          status: Schema.Literal('active'),
          tenantId: Schema.Literal(legalEntityRef.tenantId),
        }),
      )(entity),
    ).toBe(true);
    const entityObjectId = toLegalEntityAccessObjectId(fixture.core.tenantId, fixture.core.legalEntityId);
    if (entityObjectId === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Actual Core Legal Entity permission scope missing' });
    }
    const permissions = yield* openNativeSpiceClient();
    const entityAccess = yield* Effect.tryPromise({
      catch: () => new PackagedOwnerStartupError({ reason: 'Actual Core Legal Entity permission check failed' }),
      try: () =>
        permissions.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: v1.Consistency.create({
              requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
            }),
            permission: 'access',
            resource: { objectId: entityObjectId, objectType: 'legal_entity' },
            subject: { object: { objectId: fixture.core.manager.principalId, objectType: 'principal' } },
          }),
        ),
    });
    expect(entityAccess.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
    const before = yield* fixture.core.evidence(database);
    const previousPartyReads = new Set(
      before.accesses.filter((row) => row.servingModuleKey === PARTY_MODULE_KEY).map((row) => row.dataAccessEventId),
    );
    const previousCoreReads = new Set(before.accesses.map((row) => row.dataAccessEventId));
    expect(yield* party.child.isRunning).toBe(true);
    yield* party.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
    expect(yield* party.child.isRunning).toBe(false);
    const unavailableParty = yield* Effect.exit(client.get(`${party.origin}${ONTOS_MODULE_CONTRACT_PATH}`));
    expect(Exit.isFailure(unavailableParty)).toBe(true);
    const gateway: Parameters<typeof issueNativeApiKeyGatewayAuthorization>[0] = {
      ...input.gateway,
      audience: 'catalog',
      buildMarker: catalog.compiled.buildMarker,
      principalId: fixture.core.manager.principalId,
    };
    const createAuthorization = yield* issueNativeApiKeyGatewayAuthorization(gateway);
    const created = yield* client.post(`${catalog.origin}${catalog.apiPrefix}/catalog/actions/create-product`, {
      body: yield* HttpBody.json({
        classification: { kind: 'INDEPENDENT_PRODUCT' },
        reason: 'Native Core manufacturer',
      }),
      headers: {
        authorization: Redacted.value(createAuthorization.authorization),
        'idempotency-key': yield* crypto.randomUUIDv4(),
        'x-correlation-id': yield* crypto.randomUUIDv4(),
        'x-ontos-composition-revision': input.gateway.revision,
      },
    });
    if (created.status !== 200) {
      yield* logCatalogActionProblem(created, catalog.diagnostics, 'create-product');
    }
    expect(created.status).toBe(200);
    const product = yield* created.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ product: Schema.Struct({ productRef: CoreSearchResourceRefSchema }) }),
        ),
      ),
    );
    const { productRef } = product.product;
    expect(productRef.moduleId).toBe('commerce.catalog');
    expect(productRef.resourceType).toBe('commerce.catalog.product');
    expect(productRef.tenantId).toBe(fixture.core.tenantId);
    yield* fixture.core.grantResourceAccess(productRef, fixture.core.manager.principalId, 'reader');
    const relationId = yield* crypto.randomUUIDv4();
    const correlationId = yield* crypto.randomUUIDv4();
    const setAuthorization = yield* issueNativeApiKeyGatewayAuthorization(gateway);
    const set = yield* client.post(`${catalog.origin}${catalog.apiPrefix}/catalog/actions/set-product-manufacturer`, {
      body: yield* HttpBody.json({
        effectivePeriod: {},
        evidenceRefs: ['native/legal-entity-manufacturer'],
        reason: 'Current Core identity while Party receiver is stopped',
        relationId,
        subject: productRef,
        target: { kind: 'LEGAL_ENTITY', legalEntityRef },
      }),
      headers: {
        authorization: Redacted.value(setAuthorization.authorization),
        'idempotency-key': yield* crypto.randomUUIDv4(),
        'x-correlation-id': correlationId,
        'x-ontos-composition-revision': input.gateway.revision,
      },
    });
    yield* Effect.logInfo('Native Legal Entity Manufacturer with Party stopped HTTP outcome', { status: set.status });
    if (set.status !== 200) {
      yield* logCatalogActionProblem(set, catalog.diagnostics, 'set-product-manufacturer');
    }
    expect(set.status).toBe(200);
    expect(yield* set.json).toMatchObject({ relationId, revision: 1, subject: productRef });
    const readAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
      ...gateway,
      legalEntityId: fixture.core.legalEntityId,
    });
    const current = yield* client.post(`${catalog.origin}${catalog.apiPrefix}/reads/manufacturer-relation-current`, {
      body: yield* HttpBody.json({ subject: productRef }),
      headers: {
        authorization: Redacted.value(readAuthorization.authorization),
        'x-correlation-id': yield* crypto.randomUUIDv4(),
        'x-ontos-composition-revision': input.gateway.revision,
      },
    });
    if (current.status !== 200) {
      yield* logCatalogActionProblem(current, catalog.diagnostics, 'manufacturer-relation-current');
    }
    expect(current.status).toBe(200);
    expect(yield* current.json).toMatchObject({
      claim: {
        evidenceRefs: ['native/legal-entity-manufacturer'],
        relationId,
        revision: 1,
        subject: productRef,
        target: { kind: 'LEGAL_ENTITY', legalEntityRef },
      },
      owner: { canonicalTarget: { kind: 'LEGAL_ENTITY', legalEntityRef }, kind: 'LEGAL_ENTITY', state: 'CURRENT' },
    });
    yield* assertNativeManufacturerMutationAudit(fixture.core, database, {
      authBindingId: input.gateway.authBindingId,
      authContextRef: input.gateway.authContextRef,
      correlationId,
      principalId: fixture.core.manager.principalId,
      productRef,
      tenantId: fixture.core.tenantId,
    });
    for (const authorization of [setAuthorization, readAuthorization]) {
      const exchange = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
        where: { sourceJti: authorization.sourceJti },
      });
      expect(exchange).toBeUndefined();
    }
    const after = yield* fixture.core.evidence(database);
    expect(
      after.accesses
        .filter((row) => row.servingModuleKey === PARTY_MODULE_KEY)
        .every((row) => previousPartyReads.has(row.dataAccessEventId)),
    ).toBe(true);
    const coreReads = after.accesses.filter(
      (row) =>
        !previousCoreReads.has(row.dataAccessEventId) &&
        row.servingModuleKey === 'core.identity' &&
        row.outcome === 'allowed' &&
        row.outcomeCode === 'read_allowed',
    );
    expect(coreReads.length).toBeGreaterThanOrEqual(2);
    expect(coreReads.some((row) => row.legalEntityId === null)).toBe(true);
    expect(coreReads.some((row) => row.legalEntityId === fixture.core.legalEntityId)).toBe(true);
    expect(
      coreReads.every(
        (row) =>
          row.principalId === fixture.core.manager.principalId &&
          row.authBindingId === input.gateway.authBindingId &&
          row.authContextRef === Redacted.value(input.gateway.authContextRef) &&
          row.authMethod === 'api_key',
      ),
    ).toBe(true);
    expect(yield* party.child.isRunning).toBe(false);
    yield* Effect.logInfo('Native Legal Entity Manufacturer independent of stopped Party verified', {
      actualCoreReadAudits: coreReads.length,
      compositionRevision: input.gateway.revision,
      originalActorAndReferencePreserved: true,
      partyProcessStoppedAndUnreachable: true,
      partyProviderAuditRowsUnchangedForThisBranch: true,
      sourceJwtRelayExchangeAbsentForWriteAndReadback: true,
    });
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
            moduleKeys: ['party.registry', 'commerce.catalog'],
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.andThen(recordFixtureClosed), Effect.orDie),
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

it.live(
  'completes the real Catalog to Party Manufacturer happy path and provider permission controls with the original authenticated actor',
  () =>
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
              yield* Effect.logInfo('Disposable Manufacturer queue release started', {
                tenantId: fixture.core.tenantId,
              });
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
                Effect.fn('ServerOwnerRelayNative.drainPreviousAuthority')(
                  function* drainPreviousAuthority(transaction) {
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
                  },
                ),
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
              const mergedCookies = Cookies.merge(
                Cookies.merge(signIn.cookies, sessionResponse.cookies),
                create.cookies,
              );
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
            expect(
              Schema.is(
                Schema.Struct({
                  kind: Schema.Literal('service'),
                  status: Schema.Literal('active'),
                  tenantId: Schema.Literal(fixture.core.tenantId),
                }),
              )(principal),
            ).toBe(true);
            const binding = yield* database.query.principalAuthBindings.findFirst({
              where: { principalAuthBindingId: issued.authBindingId },
            });
            expect(binding?.principalId).toBe(serviceId);
            expect(
              Schema.is(
                Schema.Struct({ status: Schema.Literal('active'), tenantId: Schema.Literal(fixture.core.tenantId) }),
              )(binding),
            ).toBe(true);
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

            const { personalAuthContextRef, personalKey } = yield* issueNativeOriginalHumanKey(
              fixture,
              database,
              keys,
              {
                cookie,
                sessionAuthContextRef: Redacted.make(realAuthContextRef),
                workloadBindingId: issued.authBindingId,
                workloadPrincipalId: serviceId,
              },
            );

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
            const providerPermissions = yield* grantNativeManufacturerReadPermissions(fixture, serviceId);
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
            yield* Effect.logInfo('Native Manufacturer real server adapter HTTP result', {
              status: setResponse.status,
            });
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
              yield* logCatalogActionProblem(
                readResponse,
                enrolledCatalog.diagnostics,
                'manufacturer-relation-current',
              );
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
            yield* assertNativeManufacturerMutationAudit(fixture.core, database, {
              authBindingId: personalKey.authBindingId,
              authContextRef: personalAuthContextRef,
              correlationId: setCorrelation,
              principalId: fixture.core.manager.principalId,
              productRef,
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
            expect(providerReads.every((row) => row.principalId !== serviceId)).toBe(true);
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
            const serviceMembership = {
              principalId: serviceId,
              relation: 'member',
              tenantId: fixture.core.tenantId,
            };
            expect(
              yield* checkNativeTenantPermission({
                permission: 'access',
                principalId: serviceId,
                tenantId: fixture.core.tenantId,
              }),
            ).toBe(false);
            yield* Effect.addFinalizer(() =>
              setNativeTenantRole(serviceMembership, false).pipe(
                Effect.andThen(
                  checkNativeTenantPermission({
                    permission: 'access',
                    principalId: serviceId,
                    tenantId: fixture.core.tenantId,
                  }),
                ),
                Effect.map((allowed) => expect(allowed).toBe(false)),
                Effect.scoped,
                Effect.orDie,
              ),
            );
            yield* setNativeTenantRole(serviceMembership, true);
            expect(
              yield* checkNativeTenantPermission({
                permission: 'access',
                principalId: serviceId,
                tenantId: fixture.core.tenantId,
              }),
            ).toBe(true);
            const executionClient = yield* openNativeSpiceClient();
            for (const actionKey of [
              'core.identity.create-non-human-principal',
              'core.identity.bind-managed-api-key',
              'core.identity.bind-self-api-key',
              'commerce.catalog.create-product',
              'commerce.catalog.set-product-manufacturer',
            ]) {
              for (const principalId of [fixture.core.manager.principalId, serviceId]) {
                const execution = yield* Effect.tryPromise({
                  catch: () => new PackagedOwnerStartupError({ reason: 'Exact fixture Action execution check failed' }),
                  try: () =>
                    executionClient.promises.checkPermission(
                      v1.CheckPermissionRequest.create({
                        consistency: v1.Consistency.create({
                          requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
                        }),
                        permission: 'execute',
                        resource: { objectId: toSpiceDbActionObjectId(actionKey), objectType: 'action' },
                        subject: { object: { objectId: principalId, objectType: 'principal' } },
                      }),
                    ),
                });
                expect(execution.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION).toBe(
                  principalId === fixture.core.manager.principalId,
                );
              }
            }
            const serviceReader = {
              principalId: serviceId,
              relation: 'party_identity_reader',
              tenantId: fixture.core.tenantId,
            };
            yield* Effect.addFinalizer(() =>
              setNativeTenantRole(serviceReader, false).pipe(
                Effect.andThen(
                  checkNativeTenantPermission({
                    permission: 'read_party_identity',
                    principalId: serviceId,
                    tenantId: fixture.core.tenantId,
                  }),
                ),
                Effect.map((allowed) => expect(allowed).toBe(false)),
                Effect.scoped,
                Effect.orDie,
              ),
            );
            yield* setNativeTenantRole(serviceReader, true);
            const partyModuleTarget = { moduleId: PARTY_MODULE_KEY, permission: 'module.access' };
            const serviceModuleGrant = {
              principal: { principalId: serviceId, tenantId: fixture.core.tenantId },
              target: partyModuleTarget,
              tenantId: fixture.core.tenantId,
            };
            const serviceModuleRequest = {
              principalId: serviceId,
              targets: [partyModuleTarget],
              tenantId: fixture.core.tenantId,
            };
            yield* Effect.addFinalizer(() =>
              providerPermissions.mutation.mutate({ ...serviceModuleGrant, operation: 'revoke' }).pipe(
                Effect.andThen(providerPermissions.check(serviceModuleRequest)),
                Effect.map((decisions) => expect(decisions[0]?.decision).toBe('denied')),
                Effect.orDie,
              ),
            );
            yield* providerPermissions.mutation.mutate({ ...serviceModuleGrant, operation: 'grant' });
            expect((yield* providerPermissions.check(serviceModuleRequest))[0]?.decision).toBe('allowed');
            expect(
              yield* checkNativeTenantPermission({
                permission: 'read_party_identity',
                principalId: serviceId,
                tenantId: fixture.core.tenantId,
              }),
            ).toBe(true);
            const serviceAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
              apiKey: issued.secret,
              audience: 'party-registry',
              authBindingId: service.authBindingId,
              authContextRef: Redacted.make(`better-auth-api-key:${provider.providerKeyId}`),
              buildMarker: party.compiled.buildMarker,
              origin: fixture.origin,
              principalId: serviceId,
              publicKey: signingKeyPair.publicKey,
              revision: approved.composition.revision,
            });
            const serviceParty = yield* executePartyDetailWithAuthorization(
              { partyRef },
              Redacted.value(serviceAuthorization.authorization),
              yield* crypto.randomUUIDv4(),
              {
                baseUrl: serviceAuthorization.apiUrl,
                compositionRevision: serviceAuthorization.compositionRevision,
              },
            ).pipe(
              Effect.tapError((error) => observeOutsideRelayFailure(error, 'provider')),
              Effect.mapError(
                () => new PackagedOwnerStartupError({ reason: 'Actual broader service Party read failed' }),
              ),
            );
            expect(serviceParty.party.partyRef).toEqual(partyRef);
            for (const gate of ['tenant-read', 'tenant-module-access'] as const) {
              yield* Effect.scoped(
                Effect.gen(function* deniedManufacturerAttempt() {
                  const originalModuleGrant = {
                    principal: { principalId: fixture.core.manager.principalId, tenantId: fixture.core.tenantId },
                    target: partyModuleTarget,
                    tenantId: fixture.core.tenantId,
                  };
                  const changeOriginalGate = Effect.fn('ServerOwnerRelayNative.changeOriginalProviderGate')(
                    function* changeOriginalProviderGate(enabled: boolean) {
                      if (gate === 'tenant-read') {
                        return yield* setNativeTenantRole(
                          {
                            principalId: fixture.core.manager.principalId,
                            relation: 'party_identity_reader',
                            tenantId: fixture.core.tenantId,
                          },
                          enabled,
                        ).pipe(Effect.scoped);
                      }
                      return yield* providerPermissions.mutation.mutate({
                        ...originalModuleGrant,
                        operation: enabled ? 'grant' : 'revoke',
                      });
                    },
                  );
                  // Restore the exact original P grant even if the denied-request assertion fails.
                  yield* Effect.addFinalizer(() => changeOriginalGate(true).pipe(Effect.orDie));
                  yield* changeOriginalGate(false);
                  expect(
                    yield* checkNativeTenantPermission({
                      permission: 'read_party_identity',
                      principalId: fixture.core.manager.principalId,
                      tenantId: fixture.core.tenantId,
                    }),
                  ).toBe(gate !== 'tenant-read');
                  const originalModule = yield* providerPermissions.check({
                    principalId: fixture.core.manager.principalId,
                    targets: [partyModuleTarget],
                    tenantId: fixture.core.tenantId,
                  });
                  expect(originalModule[0]?.decision).toBe(gate === 'tenant-read' ? 'allowed' : 'denied');
                  expect((yield* providerPermissions.check(serviceModuleRequest))[0]?.decision).toBe('allowed');
                  expect(
                    yield* checkNativeTenantPermission({
                      permission: 'read_party_identity',
                      principalId: serviceId,
                      tenantId: fixture.core.tenantId,
                    }),
                  ).toBe(true);
                  const beforeDenial = yield* fixture.core.evidence(database);
                  const previousAccesses = new Set(beforeDenial.accesses.map((row) => row.dataAccessEventId));
                  const deniedAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
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
                  const deniedCorrelation = yield* crypto.randomUUIDv4();
                  const deniedResponse = yield* client.post(
                    `${catalog.origin}${catalog.apiPrefix}/catalog/actions/set-product-manufacturer`,
                    {
                      body: yield* HttpBody.json({
                        effectivePeriod: {},
                        evidenceRefs: ['native/manufacturer'],
                        reason: 'Current provider permission control',
                        relationId,
                        subject: productRef,
                        target: { kind: 'PARTY', partyRef },
                      }),
                      headers: {
                        authorization: Redacted.value(deniedAuthorization.authorization),
                        'idempotency-key': yield* crypto.randomUUIDv4(),
                        'x-correlation-id': deniedCorrelation,
                        'x-ontos-composition-revision': approved.composition.revision,
                      },
                    },
                  );
                  const deniedBody = yield* deniedResponse.json;
                  if (Schema.is(OutsideRelayProblemSchema)(deniedBody)) {
                    yield* Effect.logInfo('Native Manufacturer current permission public outcome', {
                      code: deniedBody.code,
                      gate,
                      status: deniedResponse.status,
                      title: deniedBody.title,
                      type: deniedBody.type,
                    });
                  }
                  expect(deniedResponse.status).toBe(403);
                  expect(Schema.is(CatalogManufacturerForbiddenProblemSchema)(deniedBody)).toBe(true);
                  const deniedEvidence = yield* fixture.core.evidence(database);
                  const deniedInvocation = deniedEvidence.invocations.find(
                    (row) =>
                      row.actionKey === 'commerce.catalog.set-product-manufacturer' &&
                      row.correlationId === deniedCorrelation,
                  );
                  expect(deniedInvocation?.principalId).toBe(fixture.core.manager.principalId);
                  expect(deniedInvocation?.principalId === serviceId).toBe(false);
                  expect(deniedInvocation?.tenantId).toBe(fixture.core.tenantId);
                  expect(deniedInvocation?.legalEntityId).toBeNull();
                  expect(deniedInvocation?.authBindingId).toBe(personalKey.authBindingId);
                  expect(deniedInvocation?.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                  expect(deniedInvocation?.authMethod).toBe('api_key');
                  expect(deniedInvocation?.status === 'succeeded').toBe(false);
                  expect(
                    deniedEvidence.audits.some(
                      (row) =>
                        row.actionInvocationId === deniedInvocation?.actionInvocationId &&
                        row.eventType === 'action.executed',
                    ),
                  ).toBe(false);
                  const providerDenials = deniedEvidence.accesses.filter(
                    (row) =>
                      !previousAccesses.has(row.dataAccessEventId) &&
                      row.servingModuleKey === PARTY_MODULE_KEY &&
                      row.outcome === 'denied',
                  );
                  expect(providerDenials).toHaveLength(1);
                  for (const denial of providerDenials) {
                    expect(denial.principalId).toBe(fixture.core.manager.principalId);
                    expect(denial.principalId === serviceId).toBe(false);
                    expect(denial.authBindingId).toBe(personalKey.authBindingId);
                    expect(denial.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                    expect(denial.authMethod).toBe('api_key');
                    expect(denial.tenantId).toBe(fixture.core.tenantId);
                    expect(denial.legalEntityId).toBeNull();
                  }
                  yield* Effect.logInfo('Native Manufacturer current permission denial verified', {
                    actualCanonicalStatus: deniedInvocation?.status,
                    gate,
                    originalActorPreserved: true,
                    providerDeniedAuditRows: providerDenials.length,
                    sourceWorkloadWasAllowedButNeverSubstituted: true,
                  });
                  return yield* Effect.void;
                }),
              );
            }
            const restoredAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
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
            const unchangedResponse = yield* client.post(
              `${catalog.origin}${catalog.apiPrefix}/reads/manufacturer-relation-current`,
              {
                body: yield* HttpBody.json({ subject: productRef }),
                headers: {
                  authorization: Redacted.value(restoredAuthorization.authorization),
                  'x-correlation-id': yield* crypto.randomUUIDv4(),
                  'x-ontos-composition-revision': approved.composition.revision,
                },
              },
            );
            if (unchangedResponse.status !== 200) {
              yield* logCatalogActionProblem(
                unchangedResponse,
                enrolledCatalog.diagnostics,
                'manufacturer-relation-current',
              );
            }
            expect(unchangedResponse.status).toBe(200);
            expect(yield* unchangedResponse.json).toMatchObject({
              claim: {
                evidenceRefs: ['native/manufacturer'],
                relationId,
                revision: 1,
                subject: productRef,
                target: { kind: 'PARTY', partyRef },
              },
              owner: { canonicalTarget: { kind: 'PARTY', partyRef }, kind: 'PARTY', state: 'CURRENT' },
            });
            yield* Effect.logInfo('Native Manufacturer provider revocation controls verified', {
              actualBroaderServiceReadSucceeded: true,
              independentTenantReadAndModuleAccessGatesDeniedOriginalActor: true,
              savedRelationAndRevisionUnchangedAfterRestoringOriginalGrants: true,
            });

            yield* assertNativeLegalEntityWithPartyStopped({
              catalog: enrolledCatalog,
              database,
              fixture,
              gateway: {
                apiKey: personalKey.secret,
                authBindingId: personalKey.authBindingId,
                authContextRef: personalAuthContextRef,
                origin: fixture.origin,
                publicKey: signingKeyPair.publicKey,
                revision: approved.composition.revision,
              },
              party,
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

it.live('completes the real CCC Guest attribution through Party with the original authenticated actor', () =>
  Effect.gen(function* realGuestAttribution() {
    const children: ChildProcessHandle[] = [];
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* completeRealGuestAttribution() {
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
              'commerce.customer-context.attribute-guest-retail-customer',
            ],
            gatewayMaterial,
            ['party.registry', 'commerce.customer-context'],
          );
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'initial-shell-fixture-returned' });
          const cleanupConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'cleanup-config-loaded' });
          const releaseDisposableGuestQueue = Effect.fn('ServerOwnerRelayNative.releaseDisposableGuestQueue')(
            function* releaseDisposableGuestQueue() {
              yield* Effect.logInfo('Disposable Guest queue release started', {
                tenantId: fixture.core.tenantId,
              });
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
              yield* Effect.logInfo('Disposable Guest fixture dispatch queue released', {
                queueCount: 0,
                tenantId: fixture.core.tenantId,
              });
            },
          );
          // Receivers stop before this fresh scoped cleanup; canonical/domain/access evidence remains retained.
          yield* Effect.addFinalizer(() =>
            releaseDisposableGuestQueue().pipe(Effect.scoped, Effect.timeout('10 seconds'), Effect.orDie),
          );
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'cleanup-finalizer-registered' });

          const shell = fixture.application;
          children.push(shell.child);
          const party = yield* startPackagedApplication({
            appId: 'party-registry',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            relativeDirectory: '../../verticals/party-registry',
          });
          children.push(party.child);
          const customerContext = yield* startPackagedApplication({
            appId: 'commerce-customer-context',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            relativeDirectory: '../../verticals/commerce-customer-context',
          });
          children.push(customerContext.child);
          const client = yield* HttpClient.HttpClient;
          const observe = Effect.fn('ServerOwnerRelayNative.observeCompositionArtifact')(
            function* observeCompositionArtifact(url: string) {
              yield* Effect.logInfo('Native Guest artifact observation', { phase: 'request', url });
              const response = yield* client
                .get(url, { headers: { 'cache-control': 'no-cache' } })
                .pipe(Effect.timeout('10 seconds'));
              yield* Effect.logInfo('Native Guest artifact observation', {
                phase: 'headers',
                status: response.status,
                url,
              });
              expect(response.status).toBe(200);
              const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.timeout('10 seconds')));
              yield* Effect.logInfo('Native Guest artifact observation', {
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
                appId: 'commerce-customer-context',
                backend: { baseUrl: `${customerContext.origin}/`, transport: 'node-http' },
                contract: yield* observe(`${customerContext.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
              },
            ],
            observedAt: yield* DateTime.now,
            shell: {
              federationManifest: yield* observe(`${shell.origin}/mf-manifest.json`),
              runtimeContract: yield* observe(`${shell.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`),
            },
            validity: Duration.minutes(15),
          });
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'snapshot-derived' });
          const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'snapshot-validated' });
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
          const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'authority-publication-start' });
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
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'previous-authority-drained' });
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
          yield* Effect.logInfo('Native Guest setup phase', { phase: 'authority-published' });
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
                backend: { baseUrl: `${customerContext.origin}/`, transport: 'node-http' },
                deployment: { appId: 'commerce-customer-context', buildMarker: customerContext.compiled.buildMarker },
                federation: expect.objectContaining({ execution: 'server' }),
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
          expect(
            Schema.is(
              Schema.Struct({
                kind: Schema.Literal('service'),
                status: Schema.Literal('active'),
                tenantId: Schema.Literal(fixture.core.tenantId),
              }),
            )(principal),
          ).toBe(true);
          const binding = yield* database.query.principalAuthBindings.findFirst({
            where: { principalAuthBindingId: issued.authBindingId },
          });
          expect(binding?.principalId).toBe(serviceId);
          expect(
            Schema.is(
              Schema.Struct({ status: Schema.Literal('active'), tenantId: Schema.Literal(fixture.core.tenantId) }),
            )(binding),
          ).toBe(true);
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
                  sourceAppId: 'commerce-customer-context',
                  sourceBuildMarker: customerContext.compiled.buildMarker,
                },
              ]),
            ),
          });
          children.push(enrolledShell.child);
          expect(enrolledShell.origin).toBe(shell.origin);
          expect(enrolledShell.compiled).toEqual(shell.compiled);
          expect(yield* customerContext.child.isRunning).toBe(true);
          yield* customerContext.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
          expect(yield* customerContext.child.isRunning).toBe(false);
          const enrolledCustomerContext = yield* startPackagedApplication({
            appId: 'commerce-customer-context',
            compositionUrl,
            gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
            port: Number(new URL(customerContext.origin).port),
            relativeDirectory: '../../verticals/commerce-customer-context',
            relaySource: { apiKey: issued.secret, shellBaseUrl: `${fixture.origin}/shell-super-app-api` },
          });
          children.push(enrolledCustomerContext.child);
          expect(enrolledCustomerContext.origin).toBe(customerContext.origin);
          expect(enrolledCustomerContext.compiled).toEqual(customerContext.compiled);

          yield* grantNativeCatalogModuleAccess(fixture.core, 'commerce.customer-context');
          const guestEvidenceRef = `native/guest/${yield* crypto.randomUUIDv4()}`;
          const correlationRoot = yield* crypto.randomUUIDv4();
          const sellingLegalEntityRef: Parameters<
            typeof executeAttributeGuestRetailCustomerWithAuthorization
          >[0]['sellingLegalEntityRef'] = {
            moduleId: 'core.identity',
            resourceId: fixture.core.legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId: fixture.core.tenantId,
          };
          const partyAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
            apiKey: personalKey.secret,
            audience: 'party-registry',
            authBindingId: personalKey.authBindingId,
            authContextRef: personalAuthContextRef,
            buildMarker: party.compiled.buildMarker,
            legalEntityId: fixture.core.legalEntityId,
            origin: fixture.origin,
            principalId: fixture.core.manager.principalId,
            publicKey: signingKeyPair.publicKey,
            revision: approved.composition.revision,
          });
          yield* Effect.logInfo('Native Guest Party seed started', { phase: 'actual-public-party-create' });
          const createdParty = yield* createPartyWithAuthorization(
            {
              candidate: {
                displayName: 'Native Guest organization',
                evidenceRefs: [guestEvidenceRef],
                officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
                partyType: 'ORGANIZATION',
                provenance: { method: 'DOCUMENT', source: 'native-guest-proof' },
                subjectEvidence: [
                  {
                    basis: 'REVIEWED_DOCUMENT',
                    evidenceRef: guestEvidenceRef,
                    guestBinding: { correlationRoot, legalEntityRef: sellingLegalEntityRef },
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

          const correlationId = yield* crypto.randomUUIDv4();
          const issueGuestAuthorization = Effect.fn('ServerOwnerRelayNative.issueGuestAuthorization')(
            function* issueGuestAuthorization() {
              return yield* issueNativeApiKeyGatewayAuthorization({
                apiKey: personalKey.secret,
                audience: 'commerce-customer-context',
                authBindingId: personalKey.authBindingId,
                authContextRef: personalAuthContextRef,
                buildMarker: customerContext.compiled.buildMarker,
                legalEntityId: fixture.core.legalEntityId,
                origin: fixture.origin,
                principalId: fixture.core.manager.principalId,
                publicKey: signingKeyPair.publicKey,
                revision: approved.composition.revision,
              });
            },
          );
          const authorization = yield* issueGuestAuthorization();
          const attributed = yield* executeAttributeGuestRetailCustomerWithAuthorization(
            {
              correlationRoot,
              guestEvidenceRef,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
              sellingLegalEntityRef,
            },
            Redacted.value(authorization.authorization),
            correlationId,
            {
              baseUrl: `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}`,
              compositionRevision: approved.composition.revision,
              idempotencyKey: yield* crypto.randomUUIDv4(),
            },
          ).pipe(
            Effect.tapError((error) =>
              Schema.is(OutsideRelayProblemSchema)(error)
                ? Effect.logInfo('Native Guest declared public failure', {
                    code: error.code,
                    status: error.status,
                    title: error.title,
                    type: error.type,
                  })
                : Effect.logInfo('Native Guest failure', { declaredProblem: false }),
            ),
          );
          expect(attributed.outcome).toBe('ATTRIBUTED');
          if (attributed.outcome !== 'ATTRIBUTED') {
            return yield* new PackagedOwnerStartupError({
              reason: 'Real Guest Action did not attribute accepted Party evidence',
            });
          }
          expect(attributed.partyRef).toEqual(partyRef);
          expect(attributed.profileRef.tenantId).toBe(fixture.core.tenantId);
          const evidence = yield* fixture.core.evidence(database);
          const invocations = evidence.invocations.filter(
            (row) =>
              row.actionKey === 'commerce.customer-context.attribute-guest-retail-customer' &&
              row.correlationId === correlationId,
          );
          expect(invocations).toHaveLength(1);
          const [invocation] = invocations;
          if (invocation === undefined) {
            return yield* new PackagedOwnerStartupError({ reason: 'Guest canonical invocation absent' });
          }
          expect(invocation.status).toBe('succeeded');
          expect(invocation.principalId).toBe(fixture.core.manager.principalId);
          expect(invocation.authBindingId).toBe(personalKey.authBindingId);
          expect(invocation.authMethod).toBe('api_key');
          expect(invocation.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
          expect(invocation.legalEntityId).toBe(fixture.core.legalEntityId);
          const audits = evidence.audits.filter(
            (row) => row.actionInvocationId === invocation.actionInvocationId && row.eventType === 'action.executed',
          );
          expect(audits).toHaveLength(1);
          for (const audit of audits) {
            expect(audit.outcome).toBe('succeeded');
            expect(audit.principalId).toBe(fixture.core.manager.principalId);
            expect(audit.principalId === serviceId).toBe(false);
            expect(audit.authBindingId).toBe(personalKey.authBindingId);
            expect(audit.authMethod).toBe('api_key');
            expect(audit.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
            expect(audit.legalEntityId).toBe(fixture.core.legalEntityId);
          }
          expect(
            evidence.events.filter(
              (row) =>
                row.eventType === 'commerce.customer-context.guest-retail-customer-attributed.v1' &&
                row.subjectResourceId === attributed.profileRef.resourceId,
            ),
          ).toHaveLength(1);
          const providerReads = evidence.accesses.filter(
            (row) => row.servingModuleKey === PARTY_MODULE_KEY && row.outcomeCode === 'read_allowed',
          );
          expect(providerReads.length).toBeGreaterThan(0);
          for (const read of providerReads) {
            expect(read.principalId).toBe(fixture.core.manager.principalId);
            expect(read.principalId === serviceId).toBe(false);
            expect(read.authBindingId).toBe(personalKey.authBindingId);
            expect(read.authMethod).toBe('api_key');
            expect(read.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
            expect(read.legalEntityId).toBe(fixture.core.legalEntityId);
          }
          const exchange = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
            where: { sourceJti: authorization.sourceJti },
          });
          expect(exchange !== undefined).toBe(true);
          const readAuthorization = yield* issueGuestAuthorization();
          const readback = yield* client.post(
            `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}/reads/guest-attribution-status`,
            {
              body: yield* HttpBody.json({ attributionCorrelationId: correlationRoot, sellingLegalEntityRef }),
              headers: {
                authorization: Redacted.value(readAuthorization.authorization),
                'x-correlation-id': yield* crypto.randomUUIDv4(),
                'x-ontos-composition-revision': approved.composition.revision,
              },
            },
          );
          const saved = yield* readback.json;
          if (readback.status !== 200 && Schema.is(OutsideRelayProblemSchema)(saved)) {
            yield* Effect.logInfo('Native Guest readback public failure', {
              code: saved.code,
              status: saved.status,
              title: saved.title,
              type: saved.type,
            });
          }
          if (readback.status !== 200) {
            // Give the scoped stdout/stderr collectors one bounded delivery window; do not retry HTTP.
            yield* Effect.sleep(Duration.millis(100));
            const lines = enrolledCustomerContext.diagnostics.map((line) => Redacted.value(line));
            const diagnostic = lines.join('\n');
            const coreFailureEntries = lines.flatMap((line, index) =>
              line.includes('Governed-read HTTP Core failure') ? [lines.slice(index, index + 8).join('\n')] : [],
            );
            const permittedFailures = [
              {
                categoryPattern: /["']?failureCategory["']?\s*[:=]\s*["']?evidence_validation\b/u,
                failureCategory: 'evidence_validation',
                reasonCode: 'read_evidence_invalid',
                reasonPattern: /["']?reasonCode["']?\s*[:=]\s*["']?read_evidence_invalid\b/u,
              },
              {
                categoryPattern: /["']?failureCategory["']?\s*[:=]\s*["']?core_execution\b/u,
                failureCategory: 'core_execution',
                reasonCode: 'read_handler_execution_failed',
                reasonPattern: /["']?reasonCode["']?\s*[:=]\s*["']?read_handler_execution_failed\b/u,
              },
              {
                categoryPattern: /["']?failureCategory["']?\s*[:=]\s*["']?result_validation\b/u,
                failureCategory: 'result_validation',
                reasonCode: 'read_result_invalid',
                reasonPattern: /["']?reasonCode["']?\s*[:=]\s*["']?read_result_invalid\b/u,
              },
            ];
            const recognizedCoreFailures = permittedFailures
              .filter(({ categoryPattern, reasonPattern }) =>
                coreFailureEntries.some((entry) => categoryPattern.test(entry) && reasonPattern.test(entry)),
              )
              .map(({ failureCategory, reasonCode }) => ({ failureCategory, reasonCode }));
            yield* Effect.logInfo('Safe native Guest status failure from combined captured diagnostics', {
              missingCryptoService: diagnostic.includes('Service not found: effect/Crypto'),
              recognizedCoreFailures,
              unexpectedGovernedReadHttpDefect: diagnostic.includes('Unexpected governed-read HTTP defect'),
            });
          }
          expect(readback.status).toBe(200);
          expect(saved).toMatchObject({
            attributionCorrelationId: correlationRoot,
            outcome: {
              canAcceptOrder: true,
              outcome: 'ATTRIBUTION_COMPLETED',
              partyRef,
              portalAccessGranted: false,
              profile: attributed.profileRef,
            },
            partyRef,
            profileRef: attributed.profileRef,
            sellingLegalEntityRef,
          });
          yield* Effect.logInfo('Actual Guest attribution persisted with original authenticated actor', {
            actionSucceeded: true,
            compositionRevision: approved.composition.revision,
            originalActorPreserved: true,
            profileReadbackMatches: true,
            providerReadCount: providerReads.length,
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

it.live(
  'completes the real CCC Retail Ensure and fresh state readback through Party with the original authenticated actor',
  () =>
    Effect.gen(function* realRetailEnsure() {
      const children: ChildProcessHandle[] = [];
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* completeRealRetailEnsure() {
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
                'commerce.customer-context.ensure-retail-customer-profile',
                'commerce.customer-context.bind-retail-portal-profile',
                'commerce.customer-context.add-saved-address',
                'commerce.customer-context.update-saved-address',
                'party.registry.add-contact-point',
              ],
              gatewayMaterial,
              ['party.registry', 'commerce.customer-context'],
            );
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'initial-shell-fixture-returned' });
            const cleanupConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'cleanup-config-loaded' });
            const releaseDisposableRetailQueue = Effect.fn('ServerOwnerRelayNative.releaseDisposableRetailQueue')(
              function* releaseDisposableRetailQueue() {
                yield* Effect.logInfo('Disposable Retail queue release started', {
                  tenantId: fixture.core.tenantId,
                });
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
                yield* Effect.logInfo('Disposable Retail fixture dispatch queue released', {
                  queueCount: 0,
                  tenantId: fixture.core.tenantId,
                });
              },
            );
            // Receivers stop before this fresh scoped cleanup; canonical/domain/access evidence remains retained.
            yield* Effect.addFinalizer(() =>
              releaseDisposableRetailQueue().pipe(Effect.scoped, Effect.timeout('10 seconds'), Effect.orDie),
            );
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'cleanup-finalizer-registered' });

            const shell = fixture.application;
            children.push(shell.child);
            const party = yield* startPackagedApplication({
              appId: 'party-registry',
              compositionUrl,
              gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
              relativeDirectory: '../../verticals/party-registry',
            });
            children.push(party.child);
            const customerContext = yield* startPackagedApplication({
              appId: 'commerce-customer-context',
              compositionUrl,
              gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
              relativeDirectory: '../../verticals/commerce-customer-context',
            });
            children.push(customerContext.child);
            const packagedWorker = yield* loadPackagedRetailWorker({
              expected: customerContext.compiled,
              relativeDirectory: '../../.zerops/runtime/commerce-customer-context-worker',
            });
            const client = yield* HttpClient.HttpClient;
            const observe = Effect.fn('ServerOwnerRelayNative.observeCompositionArtifact')(
              function* observeCompositionArtifact(url: string) {
                yield* Effect.logInfo('Native Retail artifact observation', { phase: 'request', url });
                const response = yield* client
                  .get(url, { headers: { 'cache-control': 'no-cache' } })
                  .pipe(Effect.timeout('10 seconds'));
                yield* Effect.logInfo('Native Retail artifact observation', {
                  phase: 'headers',
                  status: response.status,
                  url,
                });
                expect(response.status).toBe(200);
                const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.timeout('10 seconds')));
                yield* Effect.logInfo('Native Retail artifact observation', {
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
                  appId: 'commerce-customer-context',
                  backend: { baseUrl: `${customerContext.origin}/`, transport: 'node-http' },
                  contract: yield* observe(`${customerContext.origin}${ONTOS_MODULE_CONTRACT_PATH}`),
                },
              ],
              observedAt: yield* DateTime.now,
              shell: {
                federationManifest: yield* observe(`${shell.origin}/mf-manifest.json`),
                runtimeContract: yield* observe(`${shell.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`),
              },
              validity: Duration.minutes(15),
            });
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'snapshot-derived' });
            const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'snapshot-validated' });
            const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
            const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
            const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'authority-publication-start' });
            yield* database
              .transaction(
                Effect.fn('ServerOwnerRelayNative.drainPreviousAuthority')(
                  function* drainPreviousAuthority(transaction) {
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
                  },
                ),
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
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'previous-authority-drained' });
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
            yield* Effect.logInfo('Native Retail setup phase', { phase: 'authority-published' });
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
                  backend: { baseUrl: `${customerContext.origin}/`, transport: 'node-http' },
                  deployment: { appId: 'commerce-customer-context', buildMarker: customerContext.compiled.buildMarker },
                  federation: expect.objectContaining({ execution: 'server' }),
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
            const createdService = yield* create.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(PrincipalMutationResponseSchema)),
            );
            const serviceId = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema.fields.principalId)(
              createdService.principalId,
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
              const mergedCookies = Cookies.merge(
                Cookies.merge(signIn.cookies, sessionResponse.cookies),
                create.cookies,
              );
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
            expect(
              Schema.is(
                Schema.Struct({
                  kind: Schema.Literal('service'),
                  status: Schema.Literal('active'),
                  tenantId: Schema.Literal(fixture.core.tenantId),
                }),
              )(principal),
            ).toBe(true);
            const binding = yield* database.query.principalAuthBindings.findFirst({
              where: { principalAuthBindingId: issued.authBindingId },
            });
            expect(binding?.principalId).toBe(serviceId);
            expect(
              Schema.is(
                Schema.Struct({ status: Schema.Literal('active'), tenantId: Schema.Literal(fixture.core.tenantId) }),
              )(binding),
            ).toBe(true);
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

            const { personalAuthContextRef, personalKey } = yield* issueNativeOriginalHumanKey(
              fixture,
              database,
              keys,
              {
                cookie,
                sessionAuthContextRef: Redacted.make(realAuthContextRef),
                workloadBindingId: issued.authBindingId,
                workloadPrincipalId: serviceId,
              },
            );

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
                    sourceAppId: 'commerce-customer-context',
                    sourceBuildMarker: customerContext.compiled.buildMarker,
                  },
                ]),
              ),
            });
            children.push(enrolledShell.child);
            expect(enrolledShell.origin).toBe(shell.origin);
            expect(enrolledShell.compiled).toEqual(shell.compiled);
            expect(yield* customerContext.child.isRunning).toBe(true);
            yield* customerContext.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
            expect(yield* customerContext.child.isRunning).toBe(false);
            const enrolledCustomerContext = yield* startPackagedApplication({
              appId: 'commerce-customer-context',
              compositionUrl,
              gateway: { issuer: fixture.origin, publicJwks: gatewayMaterial.publicJwks },
              port: Number(new URL(customerContext.origin).port),
              relativeDirectory: '../../verticals/commerce-customer-context',
              relaySource: { apiKey: issued.secret, shellBaseUrl: `${fixture.origin}/shell-super-app-api` },
            });
            children.push(enrolledCustomerContext.child);
            expect(enrolledCustomerContext.origin).toBe(customerContext.origin);
            expect(enrolledCustomerContext.compiled).toEqual(customerContext.compiled);

            yield* grantNativeCatalogModuleAccess(fixture.core, 'commerce.customer-context');
            const retailEvidenceRef = `native/retail/${yield* crypto.randomUUIDv4()}`;
            const sellingLegalEntityRef: Parameters<
              typeof executeEnsureRetailCustomerProfileWithAuthorization
            >[0]['subject']['sellingLegalEntityRef'] = {
              moduleId: 'core.identity',
              resourceId: fixture.core.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: fixture.core.tenantId,
            };
            const partyAuthorization = yield* issueNativeApiKeyGatewayAuthorization({
              apiKey: personalKey.secret,
              audience: 'party-registry',
              authBindingId: personalKey.authBindingId,
              authContextRef: personalAuthContextRef,
              buildMarker: party.compiled.buildMarker,
              legalEntityId: fixture.core.legalEntityId,
              origin: fixture.origin,
              principalId: fixture.core.manager.principalId,
              publicKey: signingKeyPair.publicKey,
              revision: approved.composition.revision,
            });
            yield* Effect.logInfo('Native Retail Party seed started', { phase: 'actual-public-party-create' });
            const createdParty = yield* createPartyWithAuthorization(
              {
                candidate: {
                  displayName: 'Native Retail organization',
                  evidenceRefs: [retailEvidenceRef],
                  officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
                  partyType: 'ORGANIZATION',
                  provenance: { method: 'DOCUMENT', source: 'native-retail-proof' },
                  subjectEvidence: [
                    {
                      basis: 'REVIEWED_DOCUMENT',
                      evidenceRef: retailEvidenceRef,
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

            const payload: Parameters<typeof executeEnsureRetailCustomerProfileWithAuthorization>[0] = {
              effectiveAt: DateTime.formatIso(yield* DateTime.now),
              subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
              trigger: 'AUTHORIZED_ONBOARDING',
            };
            const ensure = Effect.fn('ServerOwnerRelayNative.ensureRetailWithFreshProof')(
              function* ensureRetailWithFreshProof() {
                const authorization = yield* issueNativeApiKeyGatewayAuthorization({
                  apiKey: personalKey.secret,
                  audience: 'commerce-customer-context',
                  authBindingId: personalKey.authBindingId,
                  authContextRef: personalAuthContextRef,
                  buildMarker: customerContext.compiled.buildMarker,
                  legalEntityId: fixture.core.legalEntityId,
                  origin: fixture.origin,
                  principalId: fixture.core.manager.principalId,
                  publicKey: signingKeyPair.publicKey,
                  revision: approved.composition.revision,
                });
                const correlationId = yield* crypto.randomUUIDv4();
                const idempotencyKey = yield* crypto.randomUUIDv4();
                const ensureResult = yield* executeEnsureRetailCustomerProfileWithAuthorization(
                  payload,
                  Redacted.value(authorization.authorization),
                  correlationId,
                  {
                    baseUrl: `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}`,
                    compositionRevision: approved.composition.revision,
                    idempotencyKey,
                  },
                ).pipe(
                  Effect.tapError((error) =>
                    Schema.is(OutsideRelayProblemSchema)(error)
                      ? Effect.logInfo('Native Retail Ensure declared public failure', {
                          code: error.code,
                          status: error.status,
                          title: error.title,
                          type: error.type,
                        })
                      : Effect.logInfo('Native Retail Ensure failure', { declaredProblem: false }),
                  ),
                );
                return { authorization, correlationId, idempotencyKey, result: ensureResult };
              },
            );
            const created = yield* ensure();
            expect(created.result.outcome).toBe('PROFILE_CREATED');
            expect(created.result.state).toBe('ACTIVE');
            expect(created.result.revision).toBe(1);
            expect(created.result.profileRef.tenantId).toBe(fixture.core.tenantId);
            const repeated = yield* ensure();
            expect(repeated.result.outcome).toBe('PROFILE_ALREADY_EXISTS_ACTIVE');
            expect(repeated.result.state).toBe('ACTIVE');
            expect(repeated.result.profileRef).toEqual(created.result.profileRef);
            expect(repeated.result.revision).toBe(created.result.revision);
            expect(created.idempotencyKey === repeated.idempotencyKey).toBe(false);
            expect(created.correlationId === repeated.correlationId).toBe(false);
            expect(created.authorization.sourceJti === repeated.authorization.sourceJti).toBe(false);
            const evidence = yield* fixture.core.evidence(database);
            const invocations = evidence.invocations.filter(
              (row) => row.actionKey === 'commerce.customer-context.ensure-retail-customer-profile',
            );
            expect(invocations).toHaveLength(2);
            for (const call of [created, repeated]) {
              const matches = invocations.filter((row) => row.correlationId === call.correlationId);
              expect(matches).toHaveLength(1);
              const [invocation] = matches;
              if (invocation === undefined) {
                return yield* new PackagedOwnerStartupError({ reason: 'Retail Ensure canonical invocation absent' });
              }
              expect(invocation.status).toBe('succeeded');
              expect(invocation.principalId).toBe(fixture.core.manager.principalId);
              expect(invocation.authBindingId).toBe(personalKey.authBindingId);
              expect(invocation.authMethod).toBe('api_key');
              expect(invocation.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
              expect(invocation.legalEntityId).toBe(fixture.core.legalEntityId);
              const audits = evidence.audits.filter(
                (row) =>
                  row.actionInvocationId === invocation.actionInvocationId && row.eventType === 'action.executed',
              );
              expect(audits).toHaveLength(1);
              for (const audit of audits) {
                expect(audit.outcome).toBe('succeeded');
                expect(audit.tenantId).toBe(fixture.core.tenantId);
                expect(audit.principalId).toBe(fixture.core.manager.principalId);
                expect(audit.principalId === serviceId).toBe(false);
                expect(audit.authBindingId).toBe(personalKey.authBindingId);
                expect(audit.authMethod).toBe('api_key');
                expect(audit.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                expect(audit.legalEntityId).toBe(fixture.core.legalEntityId);
              }
              const lookups = evidence.accesses.filter(
                (row) =>
                  row.actionInvocationId === invocation.actionInvocationId && row.outcomeCode === 'action_read_allowed',
              );
              expect(lookups).toHaveLength(2);
              expect(
                lookups.some(
                  (row) =>
                    row.targetResourceId === partyRef.resourceId &&
                    row.queryHash === `retail-profile-subject:${partyRef.resourceId}:${created.result.revision}`,
                ),
              ).toBe(true);
              expect(
                lookups.some(
                  (row) =>
                    row.targetResourceId === created.result.profileRef.resourceId &&
                    row.queryHash ===
                      `retail-profile-current:${created.result.profileRef.resourceId}:${created.result.revision}`,
                ),
              ).toBe(true);
              const exchange = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
                where: { sourceJti: call.authorization.sourceJti },
              });
              expect(exchange !== undefined).toBe(true);
            }
            const events = evidence.events.filter(
              (row) =>
                row.eventType === 'commerce.customer-context.retail-customer-profile-created.v1' &&
                row.subjectResourceId === created.result.profileRef.resourceId,
            );
            expect(events).toHaveLength(1);
            const providerReads = evidence.accesses.filter(
              (row) => row.servingModuleKey === PARTY_MODULE_KEY && row.outcomeCode === 'read_allowed',
            );
            expect(providerReads).toHaveLength(2);
            for (const read of providerReads) {
              expect(read.principalId).toBe(fixture.core.manager.principalId);
              expect(read.principalId === serviceId).toBe(false);
              expect(read.authBindingId).toBe(personalKey.authBindingId);
              expect(read.authMethod).toBe('api_key');
              expect(read.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
              expect(read.legalEntityId).toBe(fixture.core.legalEntityId);
            }
            yield* Effect.logInfo('Actual Retail Ensure persisted and independently read back by fresh Ensure', {
              canonicalInvocationCount: invocations.length,
              compositionRevision: approved.composition.revision,
              originalActorPreserved: true,
              profileCreatedThenAlreadyExists: true,
              providerReadCount: providerReads.length,
              sameProfileAndRevision: true,
              sourceExchangeCount: 2,
            });

            const activateBinding = Effect.fn('ServerOwnerRelayNative.activateRealRetailBinding')(
              function* activateRealRetailBinding() {
                const recordedEnsure = invocations.find((row) => row.correlationId === created.correlationId);
                if (recordedEnsure === undefined) {
                  return yield* new PackagedOwnerStartupError({
                    reason: 'Recorded Ensure evidence absent before binding',
                  });
                }
                const bindingEvidenceRef = `core-action-invocation:${recordedEnsure.actionInvocationId}`;
                const bindingCorrelation = yield* crypto.randomUUIDv4();
                const issueBindingProof = Effect.fn('ServerOwnerRelayNative.issueBindingProof')(
                  function* issueBindingProof() {
                    return yield* issueNativeApiKeyGatewayAuthorization({
                      apiKey: personalKey.secret,
                      audience: 'commerce-customer-context',
                      authBindingId: personalKey.authBindingId,
                      authContextRef: personalAuthContextRef,
                      buildMarker: customerContext.compiled.buildMarker,
                      legalEntityId: fixture.core.legalEntityId,
                      origin: fixture.origin,
                      principalId: fixture.core.manager.principalId,
                      publicKey: signingKeyPair.publicKey,
                      revision: approved.composition.revision,
                    });
                  },
                );
                const bindProof = yield* issueBindingProof();
                const bound = yield* executeBindRetailPortalProfileWithAuthorization(
                  {
                    effectiveAt: DateTime.formatIso(yield* DateTime.now),
                    enrollmentEvidenceRef: bindingEvidenceRef,
                    expectedRevision: null,
                    expectedState: null,
                    principalRef: {
                      moduleId: 'core.identity',
                      resourceId: yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(
                        fixture.core.manager.principalId,
                      ),
                      resourceType: 'core.identity.principal',
                      tenantId: yield* Schema.decodeUnknownEffect(TenantIdSchema)(fixture.core.tenantId),
                    },
                    profileRef: created.result.profileRef,
                    reason: 'Bind current authenticated native Principal to its actual Retail profile',
                    sellingLegalEntityRef,
                  },
                  Redacted.value(bindProof.authorization),
                  bindingCorrelation,
                  {
                    baseUrl: `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}`,
                    compositionRevision: approved.composition.revision,
                    idempotencyKey: yield* crypto.randomUUIDv4(),
                  },
                ).pipe(
                  Effect.tapError((error) =>
                    Schema.is(OutsideRelayProblemSchema)(error)
                      ? Effect.logInfo('Native binding declared public failure', {
                          code: error.code,
                          status: error.status,
                          title: error.title,
                          type: error.type,
                        })
                      : Effect.logInfo('Native binding failure', { declaredProblem: false }),
                  ),
                );
                expect(bound.outcome).toBe('BINDING_ACTIVATED');
                expect(bound.state).toBe('ACTIVE');
                expect(bound.revision).toBe(1);
                expect(bound.authorizationOperation).toBe('grant');
                expect(bound.authorizationState).toBe('PENDING_GRANT');
                expect(bound.permissionMutations?.length).toBeGreaterThan(0);
                expect(
                  bound.permissionMutations?.every((mutation) => mutation.operation === 'grant' && mutation.staged),
                ).toBe(true);
                const probeJtis = new Set<string>();
                const readBinding = Effect.fn('ServerOwnerRelayNative.readBindingWithFreshProof')(
                  function* readBindingWithFreshProof() {
                    const proof = yield* issueBindingProof();
                    expect(probeJtis.has(proof.sourceJti)).toBe(false);
                    probeJtis.add(proof.sourceJti);
                    const bindingResponse = yield* client.post(
                      `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}/reads/retail-portal-profile-binding-read`,
                      {
                        body: yield* HttpBody.json({
                          bindingRef: bound.bindingRef,
                          profileRef: created.result.profileRef,
                        }),
                        headers: {
                          authorization: Redacted.value(proof.authorization),
                          'x-correlation-id': yield* crypto.randomUUIDv4(),
                          'x-ontos-composition-revision': approved.composition.revision,
                        },
                      },
                    );
                    return { body: yield* bindingResponse.json, status: bindingResponse.status };
                  },
                );
                const pending = yield* readBinding();
                if (pending.status !== 403 && Schema.is(OutsideRelayProblemSchema)(pending.body)) {
                  yield* Effect.logInfo('Native preworker binding read problem', {
                    code: pending.body.code,
                    status: pending.body.status,
                    title: pending.body.title,
                    type: pending.body.type,
                  });
                }
                expect(pending.status).toBe(403);
                expect(Schema.is(OutsideRelayProblemSchema)(pending.body)).toBe(true);
                const worker = yield* startPackagedRetailWorker({ compositionUrl, packaged: packagedWorker });
                children.push(worker.child);
                const activeBindingProjection = Schema.Struct({
                  _tag: Schema.Literal('BINDING_AVAILABLE'),
                  authorizationFreshness: Schema.Struct({ status: Schema.Literal('CURRENT') }),
                  binding: Schema.Struct({
                    authorizationState: Schema.Literal('ACTIVE'),
                    bindingRef: Schema.Struct({ resourceId: Schema.Literal(bound.bindingRef.resourceId) }),
                    enrollmentEvidenceRef: Schema.Literal(bindingEvidenceRef),
                    principalRef: Schema.Struct({
                      resourceId: Schema.Literal(fixture.core.manager.principalId),
                      tenantId: Schema.Literal(fixture.core.tenantId),
                    }),
                    profileRef: Schema.Struct({
                      resourceId: Schema.Literal(created.result.profileRef.resourceId),
                      tenantId: Schema.Literal(fixture.core.tenantId),
                    }),
                    sellingLegalEntityRef: Schema.Struct({ resourceId: Schema.Literal(fixture.core.legalEntityId) }),
                    state: Schema.Literal('ACTIVE'),
                  }),
                  completeness: Schema.Literal('FULL'),
                  grantedPermissions: Schema.Array(Schema.String),
                  permissionsFreshness: Schema.Struct({ status: Schema.Literal('CURRENT') }),
                });
                const awaitBinding = Effect.fn('ServerOwnerRelayNative.awaitRealBindingActivation')(
                  function* awaitRealBindingActivation() {
                    for (let attempt = 0; attempt < 40; attempt += 1) {
                      expect(yield* worker.child.isRunning).toBe(true);
                      const bindingProbe = yield* readBinding();
                      if (bindingProbe.status === 200 && Schema.is(activeBindingProjection)(bindingProbe.body)) {
                        return bindingProbe.body;
                      }
                      if (bindingProbe.status !== 200 && bindingProbe.status !== 403) {
                        if (Schema.is(OutsideRelayProblemSchema)(bindingProbe.body)) {
                          yield* Effect.logInfo('Native worker binding poll public failure', {
                            code: bindingProbe.body.code,
                            status: bindingProbe.body.status,
                            title: bindingProbe.body.title,
                            type: bindingProbe.body.type,
                          });
                        }
                        return yield* new PackagedOwnerStartupError({
                          reason: 'Binding activation polling received an unexpected public response',
                        });
                      }
                      yield* Effect.sleep(Duration.millis(250));
                    }
                    return yield* new PackagedOwnerStartupError({
                      reason: 'Actual registered worker did not activate binding within the bounded polling window',
                    });
                  },
                );
                const activeBinding = yield* awaitBinding().pipe(Effect.timeout('30 seconds'));
                expect(activeBinding.grantedPermissions).toEqual(
                  expect.arrayContaining(bound.permissionMutations?.map((mutation) => mutation.permission) ?? []),
                );
                const accessProof = yield* issueBindingProof();
                expect(probeJtis.has(accessProof.sourceJti)).toBe(false);
                probeJtis.add(accessProof.sourceJti);
                const accessResponse = yield* client.post(
                  `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}/reads/retail-access-decision`,
                  {
                    body: yield* HttpBody.json({
                      profileRef: created.result.profileRef,
                      requiredPermission: 'retail.profile.read',
                    }),
                    headers: {
                      authorization: Redacted.value(accessProof.authorization),
                      'x-correlation-id': yield* crypto.randomUUIDv4(),
                      'x-ontos-composition-revision': approved.composition.revision,
                    },
                  },
                );
                const access = yield* accessResponse.json;
                if (accessResponse.status !== 200 && Schema.is(OutsideRelayProblemSchema)(access)) {
                  yield* Effect.logInfo('Native activated Retail access public failure', {
                    code: access.code,
                    status: access.status,
                    title: access.title,
                    type: access.type,
                  });
                }
                expect(accessResponse.status).toBe(200);
                expect(access).toMatchObject({
                  authorizationFreshness: { status: 'CURRENT' },
                  bindingRef: bound.bindingRef,
                  bindingState: 'ACTIVE',
                  decision: { allowed: true, outcome: 'ALLOWED' },
                  profileRef: created.result.profileRef,
                  requiredPermission: 'retail.profile.read',
                });
                const bindingEvidence = yield* fixture.core.evidence(database);
                const bindingInvocations = bindingEvidence.invocations.filter(
                  (row) =>
                    row.actionKey === 'commerce.customer-context.bind-retail-portal-profile' &&
                    row.correlationId === bindingCorrelation,
                );
                expect(bindingInvocations).toHaveLength(1);
                const [bindingInvocation] = bindingInvocations;
                if (bindingInvocation === undefined) {
                  return yield* new PackagedOwnerStartupError({ reason: 'Actual binding canonical invocation absent' });
                }
                expect(bindingInvocation.status).toBe('succeeded');
                expect(bindingInvocation.principalId).toBe(fixture.core.manager.principalId);
                expect(bindingInvocation.authBindingId).toBe(personalKey.authBindingId);
                expect(bindingInvocation.authMethod).toBe('api_key');
                expect(bindingInvocation.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                expect(bindingInvocation.legalEntityId).toBe(fixture.core.legalEntityId);
                const bindingAudits = bindingEvidence.audits.filter(
                  (row) =>
                    row.actionInvocationId === bindingInvocation.actionInvocationId &&
                    row.eventType === 'action.executed',
                );
                expect(bindingAudits).toHaveLength(1);
                for (const audit of bindingAudits) {
                  expect(audit.outcome).toBe('succeeded');
                  expect(audit.principalId).toBe(fixture.core.manager.principalId);
                  expect(audit.authBindingId).toBe(personalKey.authBindingId);
                  expect(audit.authMethod).toBe('api_key');
                  expect(audit.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                  expect(audit.legalEntityId).toBe(fixture.core.legalEntityId);
                }
                const activationTopic =
                  'commerce.customer-context.retail-portal-profile-binding-activation-authorization-mutation-requested.v1';
                const activationEvents = bindingEvidence.events.filter(
                  (row) => row.eventType === activationTopic && row.subjectResourceId === bound.bindingRef.resourceId,
                );
                expect(activationEvents).toHaveLength(1);
                const [activationEvent] = activationEvents;
                if (activationEvent === undefined) {
                  return yield* new PackagedOwnerStartupError({ reason: 'Binding authorization event absent' });
                }
                const messages = bindingEvidence.outbox.filter(
                  (row) => row.topic === activationTopic && row.domainEventId === activationEvent.domainEventId,
                );
                expect(messages).toHaveLength(1);
                const [message] = messages;
                if (message === undefined) {
                  return yield* new PackagedOwnerStartupError({
                    reason: 'Actual binding activation outbox message absent',
                  });
                }
                let delivered = false;
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  const deliveries = yield* database.query.outboxDeliveries.findMany({
                    where: { consumerModuleKey: 'commerce.customer-context', outboxMessageId: message.outboxMessageId },
                  });
                  expect(deliveries.length).toBeLessThanOrEqual(1);
                  const [delivery] = deliveries;
                  if (delivery?.status === 'done') {
                    expect(delivery.workerKey).toBe(
                      'commerce.customer-context.reconcile-retail-portal-profile-binding-activation-authorization-mutation',
                    );
                    expect(delivery.attemptsCount).toBeGreaterThan(0);
                    delivered = true;
                    break;
                  }
                  if (delivery !== undefined) {
                    expect(['pending', 'processing']).toContain(delivery.status);
                  }
                  yield* Effect.sleep(Duration.millis(250));
                }
                expect(delivered).toBe(true);
                yield* worker.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
                expect(yield* worker.child.exitCode).toBe(0);
                expect(yield* worker.child.isRunning).toBe(false);
                yield* Effect.logInfo('Actual Retail binding activated by registered production worker', {
                  authorizationCurrent: true,
                  bindingFull: true,
                  compositionRevision: approved.composition.revision,
                  originalActorPreserved: true,
                  permissionAccessAllowed: true,
                  registeredDeliveryDone: true,
                  workerGracefullyStopped: true,
                });
                return yield* Effect.void;
              },
            );
            yield* activateBinding();
            const exerciseSavedAddresses = Effect.fn('ServerOwnerRelayNative.exerciseActualSavedAddresses')(
              function* exerciseActualSavedAddresses() {
                const issuePostalProof = Effect.fn('ServerOwnerRelayNative.issuePostalProof')(
                  function* issuePostalProof(
                    audience: 'commerce-customer-context' | 'party-registry',
                    buildMarker: string,
                  ) {
                    return yield* issueNativeApiKeyGatewayAuthorization({
                      apiKey: personalKey.secret,
                      audience,
                      authBindingId: personalKey.authBindingId,
                      authContextRef: personalAuthContextRef,
                      buildMarker,
                      legalEntityId: fixture.core.legalEntityId,
                      origin: fixture.origin,
                      principalId: fixture.core.manager.principalId,
                      publicKey: signingKeyPair.publicKey,
                      revision: approved.composition.revision,
                    });
                  },
                );
                const producerAuthority = {
                  principalId: fixture.core.manager.principalId,
                  relation: 'party_identity_manager' as const,
                  tenantId: fixture.core.tenantId,
                };
                yield* Effect.acquireRelease(setNativeTenantRole(producerAuthority, true), () =>
                  setNativeTenantRole(producerAuthority, false).pipe(Effect.scoped, Effect.orDie),
                );
                expect(
                  yield* checkNativeTenantPermission({
                    permission: 'manage_party_identity',
                    principalId: fixture.core.manager.principalId,
                    tenantId: fixture.core.tenantId,
                  }),
                ).toBe(true);
                const contactProof = yield* issuePostalProof('party-registry', party.compiled.buildMarker);
                const contactCorrelation = yield* crypto.randomUUIDv4();
                const contact = yield* addContactPointWithAuthorization(
                  {
                    contactPoint: {
                      address: {
                        addressLine1: 'Native postal fixture 1',
                        city: 'Praha',
                        countryCode: 'CZ',
                        postalCode: '11000',
                      },
                      purposes: [
                        { preferred: false, purpose: 'BILLING' },
                        { preferred: false, purpose: 'DELIVERY' },
                      ],
                      type: 'ADDRESS',
                    },
                    partyRef,
                    privacyClassification: 'BUSINESS_SENSITIVE',
                    provenance: { authoritative: false, method: 'MANUAL_CONFIRMATION', source: 'USER_ASSERTION' },
                    validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
                    verification: { state: 'UNVERIFIED' },
                  },
                  Redacted.value(contactProof.authorization),
                  {
                    baseUrl: `${party.origin}${party.apiPrefix}`,
                    compositionRevision: approved.composition.revision,
                    correlationId: contactCorrelation,
                    idempotencyKey: yield* crypto.randomUUIDv4(),
                  },
                );
                expect(contact.partyRef).toEqual(partyRef);
                expect(contact.contactPointRef.tenantId).toBe(fixture.core.tenantId);
                expect(contact.revision).toBeGreaterThan(0);
                yield* setNativeTenantRole(producerAuthority, false);
                expect(
                  yield* checkNativeTenantPermission({
                    permission: 'manage_party_identity',
                    principalId: fixture.core.manager.principalId,
                    tenantId: fixture.core.tenantId,
                  }),
                ).toBe(false);
                const postalBefore = yield* fixture.core.evidence(database);
                const priorPartyReads = new Set(
                  postalBefore.accesses
                    .filter((row) => row.servingModuleKey === PARTY_MODULE_KEY)
                    .map((row) => row.dataAccessEventId),
                );
                const profileSelector: Parameters<typeof executeAddSavedAddressWithAuthorization>[0]['profile'] = {
                  kind: 'RETAIL',
                  profileRef: created.result.profileRef,
                };
                const partyOrigin: Parameters<typeof executeAddSavedAddressWithAuthorization>[0]['origin'] = {
                  contactPointRef: contact.contactPointRef,
                  kind: 'PARTY_BACKED',
                  partyRef,
                  sourceRevision: contact.revision,
                };
                const observePostalAddFailure = (
                  error: Effect.Error<ReturnType<typeof executeAddSavedAddressWithAuthorization>>,
                ) =>
                  Schema.is(OutsideRelayProblemSchema)(error)
                    ? Effect.logInfo('Native saved-address Add public failure', {
                        code: error.code,
                        status: error.status,
                        title: error.title,
                        type: error.type,
                      })
                    : Effect.logInfo('Native saved-address Add failure', { declaredProblem: false });
                const addAddress = Effect.fn('ServerOwnerRelayNative.addAddressWithFreshProof')(
                  function* addAddressWithFreshProof(
                    addressPayload: Parameters<typeof executeAddSavedAddressWithAuthorization>[0],
                  ) {
                    const proof = yield* issuePostalProof(
                      'commerce-customer-context',
                      customerContext.compiled.buildMarker,
                    );
                    const requestCorrelation = yield* crypto.randomUUIDv4();
                    const addressResult = yield* executeAddSavedAddressWithAuthorization(
                      addressPayload,
                      Redacted.value(proof.authorization),
                      requestCorrelation,
                      {
                        baseUrl: `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}`,
                        compositionRevision: approved.composition.revision,
                        idempotencyKey: yield* crypto.randomUUIDv4(),
                      },
                    ).pipe(Effect.tapError(observePostalAddFailure));
                    return { addressResult, proof, requestCorrelation };
                  },
                );
                const partyAddress = yield* addAddress({
                  label: 'Native Party-backed address',
                  origin: partyOrigin,
                  profile: profileSelector,
                  purposes: ['BILLING', 'DELIVERY'],
                  reason: 'Save actual Party-produced postal source',
                });
                expect(partyAddress.addressResult.outcome).toBe('ADDED');
                expect(partyAddress.addressResult.address.revision).toBe(1);
                expect(partyAddress.addressResult.address.origin).toEqual(partyOrigin);
                const updateProof = yield* issuePostalProof(
                  'commerce-customer-context',
                  customerContext.compiled.buildMarker,
                );
                const updateCorrelation = yield* crypto.randomUUIDv4();
                const updatedAddress = yield* executeUpdateSavedAddressWithAuthorization(
                  {
                    expectedRevision: partyAddress.addressResult.address.revision,
                    label: 'Native Party-backed address revalidated',
                    origin: partyOrigin,
                    profile: profileSelector,
                    reason: 'Revalidate the complete actual Party origin',
                    savedAddressRef: partyAddress.addressResult.address.savedAddressRef,
                  },
                  Redacted.value(updateProof.authorization),
                  updateCorrelation,
                  {
                    baseUrl: `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}`,
                    compositionRevision: approved.composition.revision,
                    idempotencyKey: yield* crypto.randomUUIDv4(),
                  },
                ).pipe(
                  Effect.tapError((error) =>
                    Schema.is(OutsideRelayProblemSchema)(error)
                      ? Effect.logInfo('Native saved-address Update public failure', {
                          code: error.code,
                          status: error.status,
                          title: error.title,
                          type: error.type,
                        })
                      : Effect.logInfo('Native saved-address Update failure', { declaredProblem: false }),
                  ),
                );
                expect(updatedAddress.outcome).toBe('UPDATED');
                expect(updatedAddress.address.revision).toBe(2);
                expect(updatedAddress.address.savedAddressRef).toEqual(
                  partyAddress.addressResult.address.savedAddressRef,
                );
                expect(updatedAddress.address.origin).toEqual(partyOrigin);
                const listAddresses = Effect.fn('ServerOwnerRelayNative.listAddressesWithFreshProof')(
                  function* listAddressesWithFreshProof() {
                    const proof = yield* issuePostalProof(
                      'commerce-customer-context',
                      customerContext.compiled.buildMarker,
                    );
                    const listResponse = yield* client.post(
                      `${enrolledCustomerContext.origin}${enrolledCustomerContext.apiPrefix}/reads/saved-address-list`,
                      {
                        body: yield* HttpBody.json({ profile: profileSelector }),
                        headers: {
                          authorization: Redacted.value(proof.authorization),
                          'x-correlation-id': yield* crypto.randomUUIDv4(),
                          'x-ontos-composition-revision': approved.composition.revision,
                        },
                      },
                    );
                    const listed = yield* listResponse.json;
                    if (listResponse.status !== 200 && Schema.is(OutsideRelayProblemSchema)(listed)) {
                      yield* Effect.logInfo('Native saved-address List public failure', {
                        code: listed.code,
                        status: listed.status,
                        title: listed.title,
                        type: listed.type,
                      });
                    }
                    expect(listResponse.status).toBe(200);
                    return { listed, proof };
                  },
                );
                const partyList = yield* listAddresses();
                expect(partyList.listed).toMatchObject({ addresses: expect.arrayContaining([updatedAddress.address]) });
                const postalValidated = yield* fixture.core.evidence(database);
                const postalProviderReads = postalValidated.accesses.filter(
                  (row) =>
                    row.servingModuleKey === PARTY_MODULE_KEY &&
                    !priorPartyReads.has(row.dataAccessEventId) &&
                    row.outcomeCode === 'read_allowed',
                );
                expect(postalProviderReads).toHaveLength(2);
                for (const postalRead of postalProviderReads) {
                  expect(postalRead.principalId).toBe(fixture.core.manager.principalId);
                  expect(postalRead.principalId === serviceId).toBe(false);
                  expect(postalRead.authBindingId).toBe(personalKey.authBindingId);
                  expect(postalRead.authMethod).toBe('api_key');
                  expect(postalRead.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                  expect(postalRead.legalEntityId).toBe(fixture.core.legalEntityId);
                }
                for (const proof of [partyAddress.proof, updateProof]) {
                  const claimed = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
                    where: { sourceJti: proof.sourceJti },
                  });
                  expect(claimed !== undefined).toBe(true);
                }
                expect(yield* party.child.isRunning).toBe(true);
                yield* party.child.kill({ forceKillAfter: '3 seconds', killSignal: 'SIGTERM' });
                expect(yield* party.child.isRunning).toBe(false);
                const partyTransport = yield* Effect.exit(client.get(`${party.origin}${ONTOS_MODULE_CONTRACT_PATH}`));
                expect(Exit.isFailure(partyTransport)).toBe(true);
                const commerceOrigin: Parameters<typeof executeAddSavedAddressWithAuthorization>[0]['origin'] = {
                  kind: 'COMMERCE_ONLY',
                  postalAddress: {
                    addressLine1: 'Commerce fixture 2',
                    city: 'Praha',
                    countryCode: 'CZ',
                    postalCode: '11000',
                  },
                };
                const commerceAddress = yield* addAddress({
                  label: 'Native Commerce-only address',
                  origin: commerceOrigin,
                  profile: profileSelector,
                  purposes: ['BILLING', 'DELIVERY'],
                  reason: 'Persist owner postal data while actual Party receiver is down',
                });
                expect(commerceAddress.addressResult.outcome).toBe('ADDED');
                expect(commerceAddress.addressResult.address.revision).toBe(1);
                expect(commerceAddress.addressResult.address.origin).toEqual(commerceOrigin);
                const commerceList = yield* listAddresses();
                expect(commerceList.listed).toMatchObject({
                  addresses: expect.arrayContaining([updatedAddress.address, commerceAddress.addressResult.address]),
                });
                for (const proof of [commerceAddress.proof, commerceList.proof]) {
                  const claimed = yield* fixture.persistence.executor.query.gatewayRelayExchanges.findFirst({
                    where: { sourceJti: proof.sourceJti },
                  });
                  expect(claimed).toBeUndefined();
                }
                const postalAfter = yield* fixture.core.evidence(database);
                expect(
                  postalAfter.accesses
                    .filter((row) => row.servingModuleKey === PARTY_MODULE_KEY)
                    .map((row) => row.dataAccessEventId),
                ).toEqual(
                  postalValidated.accesses
                    .filter((row) => row.servingModuleKey === PARTY_MODULE_KEY)
                    .map((row) => row.dataAccessEventId),
                );
                for (const operation of [
                  { actionKey: 'party.registry.add-contact-point', correlation: contactCorrelation },
                  {
                    actionKey: 'commerce.customer-context.add-saved-address',
                    correlation: partyAddress.requestCorrelation,
                  },
                  { actionKey: 'commerce.customer-context.update-saved-address', correlation: updateCorrelation },
                  {
                    actionKey: 'commerce.customer-context.add-saved-address',
                    correlation: commerceAddress.requestCorrelation,
                  },
                ]) {
                  const actions = postalAfter.invocations.filter(
                    (row) => row.actionKey === operation.actionKey && row.correlationId === operation.correlation,
                  );
                  expect(actions).toHaveLength(1);
                  const [postalInvocation] = actions;
                  if (postalInvocation === undefined) {
                    return yield* new PackagedOwnerStartupError({ reason: 'Postal canonical invocation absent' });
                  }
                  expect(postalInvocation.status).toBe('succeeded');
                  expect(postalInvocation.principalId).toBe(fixture.core.manager.principalId);
                  expect(postalInvocation.authBindingId).toBe(personalKey.authBindingId);
                  expect(postalInvocation.authMethod).toBe('api_key');
                  expect(postalInvocation.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                  expect(postalInvocation.legalEntityId).toBe(fixture.core.legalEntityId);
                  const executed = postalAfter.audits.filter(
                    (row) =>
                      row.actionInvocationId === postalInvocation.actionInvocationId &&
                      row.eventType === 'action.executed',
                  );
                  expect(executed).toHaveLength(1);
                  for (const audit of executed) {
                    expect(audit.outcome).toBe('succeeded');
                    expect(audit.principalId).toBe(fixture.core.manager.principalId);
                    expect(audit.authBindingId).toBe(personalKey.authBindingId);
                    expect(audit.authMethod).toBe('api_key');
                    expect(audit.authContextRef === Redacted.value(personalAuthContextRef)).toBe(true);
                    expect(audit.legalEntityId).toBe(fixture.core.legalEntityId);
                  }
                }
                yield* Effect.logInfo('Actual saved-address Party-backed and Commerce-only branches verified', {
                  commerceOnlyPartyDown: true,
                  commerceOnlySourceExchangeAbsent: true,
                  currentRevision: approved.composition.revision,
                  exactSavedReferencePreserved: true,
                  originalActorPreserved: true,
                  partyBackedProviderReads: postalProviderReads.length,
                  savedAddressAddAndUpdateRevisions: [1, 2],
                  savedListMatches: true,
                });
                return yield* Effect.void;
              },
            );
            yield* exerciseSavedAddresses();

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
