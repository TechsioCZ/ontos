import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { RetailPortalProfileBindingReadRequestSchema } from '../../shared/apis/retail-portal-profile-binding-read.ts';
import {
  ProfileRetailPermissionReaderFactory,
  profileRetailPermissionReaderFactoryLive,
} from '../../src/integrations/retail-permission-reader.ts';
import type { ProfileRetailPermissionReaderFactoryService } from '../../src/integrations/retail-permission-reader.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import type { ActiveApplicationCompositionServiceContract } from '@app/core-runtime/modules/active-application-composition';
import type { PartyRegistryRetailPartyResolverFactoryInput } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { moduleReleaseApiBaseUrl } from '@app/core-runtime/unit-service-fetch';
import { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { RESEND_EMAILS_ENDPOINT } from '@app/email-delivery/resend';
import { localEmailDeliveryLive } from './local-email-delivery.ts';
import {
  PartyRegistryRetailPartyResolverFactory,
  makePartyRegistryRetailPartyResolver,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
} from '../../src/persistence/profile-persistence.ts';
import {
  ActionAuthorizationPreflightDatabaseLive,
  CorePersistenceLive,
  ContextAccessLive,
  DatabaseConfigLive,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  SHARED_RUNTIME_IDENTITY,
} from '@app/core-runtime';
import type { RuntimeDatabaseConfigValue } from '@app/core-runtime';
import { extractOutboxWorkerSubscriptions } from '@app/core-runtime/outbox/worker';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeHttpServer,
  NodeRuntime,
  NodeServices,
  NodeSocket,
} from '@effect/platform-node';
import { HttpApiBuilder, createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import {
  Array as EffectArray,
  Config,
  Context,
  Crypto,
  FileSystem,
  Path,
  Effect,
  Layer,
  Logger,
  Option,
  Order,
  Redacted,
  Ref,
  References,
  Result,
  Schema,
  Stream,
} from 'effect';
import { Socket } from 'effect/socket';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import {
  makeCommerceCustomerContextApiRuntime,
  commerceCustomerContextActionRuntimeAwaitingOwnerPreparation,
  productionReadRuntimeLive,
  commercePortalAuthRealmLive,
  commercePortalAuthVerificationHttpExecutorLive,
  commercePortalAuthVerificationProviderLive,
} from '../../api/index.ts';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
  gatewayAssertionRedemptionPgClient,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { CommerceCoreIdentityClientConfigLive } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceCoreIdentityClientLive } from '../../api/portal-auth/provider/core-identity-client.ts';
import { CommercePortalAuthAccountCreationProviderLive } from '../../api/portal-auth/provider/account-create.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { CommercePortalAuthAccountCreationReconciliationLive } from '../../src/portal-auth/persistence/portal-auth-account-creation-reconciliation.ts';
import { commerceEnrollmentOwnerTransitionPreparationLive } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { CommerceEnrollmentPreparationSubjectResolverLive } from '../../src/enrollment/orchestration/preparation-subject.ts';
import { CommercePortalAuthConfigLive } from '../../api/portal-auth/provider/config.ts';
import { commercePortalAuthVerificationApiLive } from '../../api/portal-auth/verification-http/server.ts';
import { commercePortalAuthVerificationWorkloadAuthorizationLive } from '../../api/portal-auth/verification-http/workload-authorization.ts';
import {
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrantsSchema,
} from '../../api/portal-auth/verification-http/workload-grants.ts';
import { CommerceEnrollmentProofServiceLive } from '../../src/enrollment/attempts/enrollment-proof-service.ts';
import {
  commerceEnrollmentOwnerAttemptStoreForRun,
  CommerceEnrollmentOwnerTransactionRunner,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { CommercePortalAuthDatabaseLive } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { CommercePortalAuthSessionReaderLive } from '../../src/portal-auth/persistence/portal-auth-session-reader.ts';
import {
  CommercePortalAuthVerificationApi,
  commercePortalAuthVerificationProblems,
} from '../../shared/portal-auth-verification.ts';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { getTableName } from 'drizzle-orm';
import { COMMERCE_PORTAL_AUTH_TABLES } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentResourceIdSchema,
  ReadEnrollmentAttemptInputSchema,
  ReadEnrollmentOwnerOperationInputSchema,
} from '../../shared/enrollment-contracts.ts';
import {
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentForbiddenProblemSchema,
  CommercePortalAuthEnrollmentNotFoundProblemSchema,
  CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema,
  CommercePortalAuthEnrollmentConflictProblemSchema,
  CommercePortalAuthEnrollmentRateLimitedProblemSchema,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
} from '../../shared/portal-auth/enrollment-api.ts';
import { CommercePortalAuthEnrollmentAttemptProjectionSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { COMMERCE_CUSTOMER_CONTEXT_API_PREFIX } from '../../shared/deployment-paths.ts';
import { CommercePortalAuthProviderSubjectIdSchema } from '../../api/portal-auth/session/contracts.ts';
import {
  CommerceSessionReferenceSchema,
  VerifyExternalAuthenticationResultSchema,
} from '../../shared/portal-auth-contracts.ts';
import {
  externalIdentityProblems,
  ExternalIdentityUnauthorizedProblemSchema,
} from '@app/shared-contracts/external-identity';
import { outboxWorkers } from '../../src/workers/index.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

class RetainedConsentOwnerFixtureError extends Schema.TaggedError<RetainedConsentOwnerFixtureError>()(
  'RetainedConsentOwnerFixtureError',
  { stage: Schema.String },
) {}
const failed = (stage: string) => new RetainedConsentOwnerFixtureError({ stage });
const bindingObservationStage = 'retail-binding-observation';
const observeBindingTag = 'observe-binding';
interface OwnedVerificationInbox {
  expectedAddress?: string;
  link?: Redacted.Redacted;
}
const verificationBodyStage = 'verification-body';
const verificationNotDeliveredStage = 'verification-not-delivered';
const invalidDeliveryMessage = 'Invalid owned delivery';
const providerSchemaInventory = 'provider-schema-inventory';
const providerAdminDatabase = 'provider-admin-database';
const providerRuntimeRole = 'provider-runtime-role';
const enrollCommand = Schema.TaggedStruct('enroll', {
  authorization: Schema.RedactedFromValue(Schema.String),
  partyRef: EnrollmentResourceIdSchema,
  sellingLegalEntityId: EnrollmentLegalEntityIdSchema,
});
const observeEnrollmentCommand = Schema.TaggedStruct('observe-enrollment', {
  attemptId: EnrollmentAttemptIdSchema,
  authorization: Schema.RedactedFromValue(Schema.String),
});
const observePartyCommand = Schema.TaggedStruct('observe-party', {});
const observeBindingCommand = Schema.TaggedStruct(observeBindingTag, {
  authorization: Schema.RedactedFromValue(Schema.String),
  bindingId: RetailPortalProfileBindingReadRequestSchema.fields.bindingRef.fields.resourceId,
  principalId: PrincipalIdSchema,
  profileId: RetailPortalProfileBindingReadRequestSchema.fields.profileRef.fields.resourceId,
});
const commandSchema = Schema.Union([
  observeBindingCommand,
  enrollCommand,
  observeEnrollmentCommand,
  observePartyCommand,
  Schema.TaggedStruct('sign-out', {}),
]);
const startedSchema = Schema.Struct({
  attempt: CommercePortalAuthEnrollmentAttemptProjectionSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING']),
});
const sessionSchema = Schema.Struct({
  session: Schema.Struct({
    providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
    sessionRef: CommerceSessionReferenceSchema,
  }),
  state: Schema.Literal('authenticated'),
});
const emailSchema = Schema.Struct({
  subject: Schema.String,
  text: Schema.RedactedFromValue(Schema.String),
  to: Schema.Tuple([Schema.String]),
});
const bounded = Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.fail(failed('deadline')) });
const enrollmentBodyStage = 'enrollment-body';
const publishedEnrollmentProblemSchema = Schema.Union([
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentForbiddenProblemSchema,
  CommercePortalAuthEnrollmentNotFoundProblemSchema,
  CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema,
  CommercePortalAuthEnrollmentConflictProblemSchema,
  CommercePortalAuthEnrollmentRateLimitedProblemSchema,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
]);
const enrollmentObservationStage = 'enrollment-observation';
const ownerHandlerStage = 'owner-handler';
const coreTransportResultSchema = Schema.Literals([
  'NOT_OBSERVED',
  'SUCCESS',
  'UNPUBLISHED_PROBLEM',
  'ExternalIdentityInvalidProblem',
  'ExternalIdentityUnauthorizedProblem',
  'ExternalIdentityForbiddenProblem',
  'ExternalIdentityNotFoundProblem',
  'ExternalIdentityConflictProblem',
  'ExternalIdentityIneligibleProblem',
  'ExternalIdentityThrottledProblem',
  'ExternalIdentityInternalProblem',
  'ExternalIdentityUnavailableProblem',
  'GatewayReloadRequiredProblem',
]);
const enrollmentObservationSchema = Schema.TaggedStruct(enrollmentObservationStage, {
  attemptStatus: Schema.Literals([
    'IN_PROGRESS',
    'VERIFICATION_REQUIRED',
    'COMPLETE',
    'RECONCILIATION_REQUIRED',
    'TERMINATED',
    'FAILED',
  ]),
  continuation: Schema.Literals([
    'NOT_OBSERVED',
    'FAILURE_LOGGED',
    'UNKNOWN_HALT',
    'ATTEMPT_TERMINAL',
    'IN_FLIGHT',
    'NO_OWNER_EFFECT',
    'OWNER_REJECTED',
    'RECONCILIATION_REQUIRED',
    'VERIFICATION_REQUIRED',
  ]),
  coreReadAuthentication: Schema.Literals(['NOT_OBSERVED', 'MISSING', 'INVALID', 'UNUSABLE', 'OTHER']),
  coreReadCredential: Schema.Struct({ matchesConfigured: Schema.Boolean, present: Schema.Boolean }),
  coreTransport: Schema.Struct({
    activate: coreTransportResultSchema,
    read: coreTransportResultSchema,
    reserve: coreTransportResultSchema,
  }),
  phases: Schema.Array(
    Schema.Struct({
      phase: Schema.Literals([
        'provider.account.create',
        'party.candidate.submit',
        'commerce.customer-context.ensure-retail-customer-profile',
        'commerce.customer-context.bind-retail-portal-profile',
      ]),
      status: Schema.Literals([
        'NOT_STARTED',
        'IN_PROGRESS',
        'SUCCEEDED',
        'FAILED',
        'INDETERMINATE',
        'RECONCILIATION_REQUIRED',
      ]),
    }),
  ),
  providerVerification: Schema.Struct({
    authorizationPresent: Schema.Boolean,
    received: Schema.Boolean,
    result: Schema.Literals([
      'NOT_OBSERVED',
      'INVALID_RESPONSE',
      'ALLOWED',
      'REJECTED',
      'UNAVAILABLE',
      'CommercePortalAuthVerificationInvalidProblem',
      'CommercePortalAuthVerificationUnauthorizedProblem',
      'CommercePortalAuthVerificationForbiddenProblem',
      'CommercePortalAuthVerificationUnavailableProblem',
    ]),
    status: Schema.Literals([0, 200, 400, 401, 403, 404, 500, 503]),
  }),
});
// Mutable private transport observation; no owner or authority facts are changed.
interface ContinuationObservation {
  continuation: typeof enrollmentObservationSchema.Type.continuation;
  coreReadAuthentication: typeof enrollmentObservationSchema.Type.coreReadAuthentication;
  coreReadCredential: { matchesConfigured: boolean; present: boolean };
  coreTransport: {
    activate: typeof coreTransportResultSchema.Type;
    read: typeof coreTransportResultSchema.Type;
    reserve: typeof coreTransportResultSchema.Type;
  };
  providerVerification: typeof enrollmentObservationSchema.Type.providerVerification;
}
const commandFailureStageSchema = Schema.Literals([
  bindingObservationStage,
  'deadline',
  enrollmentObservationStage,
  'duplicate-enrollment',
  enrollmentBodyStage,
  'enrollment-identity',
  'public-enrollment',
  'public-request',
  'public-session',
  'public-sign-in',
  'public-verification',
  'session-body',
  'session-cookie',
  'sign-out',
  verificationBodyStage,
  verificationNotDeliveredStage,
  'verification-required',
  'verification-required-body',
]);
const commandOperationSchema = Schema.Literals([
  'CLAIM_COMMAND',
  'OBSERVE_ENROLLMENT',
  'START_ENROLLMENT',
  'REQUIRE_VERIFICATION',
  'VERIFY_EMAIL',
  'SIGN_IN',
  'READ_SESSION',
  'SIGN_OUT',
]);
const failureHttpStatusSchema = Schema.Literals([400, 401, 403, 404, 409, 422, 429, 503]);
const failureProblemCodeSchema = Schema.Literals([
  'invalid_request',
  'authentication_required',
  'enrollment_rejected',
  'origin_not_trusted',
  'attempt_not_found',
  'enrollment_journey_unavailable',
  'enrollment_binding_pending',
  'rate_limited',
  'enrollment_unavailable',
  'UNKNOWN_PROBLEM',
]);
const commandFailureSchema = Schema.TaggedStruct('command-failed', {
  code: Schema.Literal('retained_consent_fixture_failure'),
  command: Schema.Literals(['enroll', 'sign-out', 'observe-enrollment', 'observe-party', observeBindingTag]),
  httpStatus: Schema.optionalKey(failureHttpStatusSchema),
  operation: commandOperationSchema,
  problemCode: Schema.optionalKey(failureProblemCodeSchema),
  stage: commandFailureStageSchema,
});
const serverPartyObservationSchema = Schema.TaggedStruct('server-party-observation', {
  failure: Schema.Literals(['NONE', 'HTTP_STATUS', 'OTHER']),
  httpStatus: Schema.Literals([0, 400, 401, 403, 404, 409, 422, 429, 500, 503]),
  stage: Schema.Literals([
    'NOT_ENTERED',
    'FACTORY_BUILT',
    'FACTORY_MADE',
    'ENTERED',
    'COMPOSITION_LOADED',
    'GATEWAY_ISSUED',
    'PUBLIC_DETAIL_RETURNED',
    'RESOLVED',
  ]),
});
const bindingObservationSchema = Schema.TaggedStruct(bindingObservationStage, {
  authorizationState: Schema.Literals(['ACTIVE', 'REVOKED', 'PENDING_GRANT', 'PENDING_REVOKE']),
  bindingState: Schema.Literals(['ACTIVE', 'REVOKED']),
  current: Schema.Boolean,
  manageAllowed: Schema.Boolean,
  profileReadAllowed: Schema.Boolean,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const replySchema = Schema.Union([
  bindingObservationSchema,
  serverPartyObservationSchema,
  commandFailureSchema,
  enrollmentObservationSchema,
  Schema.TaggedStruct('enrolled', {
    attemptId: EnrollmentAttemptIdSchema,
    providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
    sessionRef: CommerceSessionReferenceSchema,
  }),
  Schema.TaggedStruct('signed-out', {}),
]);
const privateReply = Effect.fn('RetainedConsentOwner.privateReply')(function* privateReply(
  writer: Socket.Writer,
  reply: typeof replySchema.Encoded,
) {
  const line = yield* Schema.decodeUnknownEffect(replySchema)(reply).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(replySchema))),
  );
  yield* writer.write(`${line}\n`).pipe(Effect.mapError(() => failed('private-reply')));
});

const openPrivateCommandSocket = Effect.fn('RetainedConsentOwner.privateSocket')(function* openPrivateCommandSocket() {
  const socketPath = yield* Config.String('ONTOS_RETAINED_CONSENT_SOCKET').pipe(
    Effect.mapError(() => failed('private-socket-config')),
  );
  const fs = yield* FileSystem.FileSystem;
  const socketPaths = yield* Path.Path;
  if (
    !socketPaths.isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    new TextEncoder().encode(socketPath).length > 96 ||
    socketPaths.basename(socketPath) !== 'native.sock'
  ) {
    return yield* failed('private-socket-path');
  }
  const directory = socketPaths.dirname(socketPath);
  const parent = yield* fs.stat(directory);
  if (parent.type !== 'Directory' || parent.mode % 0o1000 !== 0o700 || (yield* fs.realPath(directory)) !== directory) {
    return yield* failed('private-socket-parent');
  }
  const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
  const pull = yield* Socket.readerBytes(socket);
  const writer = yield* socket.writer;
  return { pull, writer };
});

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const grantOwnedPortalAuthTables = Effect.fn('RetainedConsentOwner.grantOwnedPortalAuthTables')(
  function* grantOwnedPortalAuthTables(
    creator: { readonly connectionString: string; readonly database: string; readonly user: string },
    runtimeRole: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(runtimeRole)) {
      return yield* failed(providerRuntimeRole);
    }
    const admin = yield* PgClient.make({ maxConnections: 1, url: Redacted.make(creator.connectionString) }).pipe(
      Effect.provide(Reactivity.layer),
    );
    const identity = yield* admin
      .unsafe(`select current_database() as database, current_user as role`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ database: Schema.String, role: Schema.String })])),
        ),
      );
    if (
      identity[0].database !== creator.database ||
      identity[0].role !== creator.user ||
      !/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(identity[0].database)
    ) {
      return yield* failed(providerAdminDatabase);
    }
    const role = yield* admin
      .unsafe(
        `select not rolsuper and not rolbypassrls and not rolcreatedb
      and not rolcreaterole and rolcanlogin as safe from pg_catalog.pg_roles where rolname=$1`,
        [runtimeRole],
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ safe: Schema.Boolean })]))));
    if (!role[0].safe) {
      return yield* failed(providerRuntimeRole);
    }
    const expected = EffectArray.sort(COMMERCE_PORTAL_AUTH_TABLES.map(getTableName), Order.String);
    const actual = yield* admin
      .unsafe(`select tablename as name from pg_catalog.pg_tables
      where schemaname='commerce_auth' order by tablename`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
    if (actual.length !== expected.length || actual.some((row, index) => row.name !== expected[index])) {
      return yield* failed(providerSchemaInventory);
    }
    // Database-local privileges only. The creator does not own the cluster role; inspect it
    // above and never CREATE/ALTER it, its password, or any default/global privilege.
    yield* admin.unsafe(`grant usage on schema commerce_auth to ${quoteIdentifier(runtimeRole)}`);
    for (const table of expected) {
      yield* admin.unsafe(
        `grant select, insert, update, delete on table commerce_auth.${quoteIdentifier(table)} to ${quoteIdentifier(runtimeRole)}`,
      );
    }
    return yield* Effect.void;
  },
);
const migrateOwnedPortalAuth = Effect.fn('RetainedConsentOwner.migrateOwnedPortalAuth')(
  function* migrateOwnedPortalAuth(
    creator: { readonly connectionString: string; readonly database: string; readonly user: string },
    runtimeRole: string,
  ) {
    const configuredAdmin = yield* Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL');
    if (Redacted.value(configuredAdmin) !== creator.connectionString) {
      return yield* failed(providerAdminDatabase);
    }
    for (const script of ['db:portal-auth:migrate', 'db:portal-auth:verify']) {
      if (script === 'db:portal-auth:verify') {
        yield* grantOwnedPortalAuthTables(creator, runtimeRole);
      }
      const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', script], {
        cwd: new URL('../../', import.meta.url).pathname,
        env: { APP_ENV_PATH: '/dev/null' },
        extendEnv: true,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
        concurrency: 3,
      });
      if (Number(code) !== 0) {
        return yield* failed('provider-owner-migration');
      }
    }
    return yield* Effect.void;
  },
);

// Runtime-only observation: missing storage is reported, never created by an HTTP process.
const ownedDatabaseStage = 'owned-database';
const ownedProviderStorageIsReady = Effect.fn('RetainedConsentOwner.ownedProviderStorageIsReady')(
  function* ownedProviderStorageIsReady(runtime: RuntimeDatabaseConfigValue) {
    // A runtime identity's configuration carries its connection and role; the connection names the database.
    const database = decodeURIComponent(new URL(runtime.connectionString).pathname.slice(1));
    if (!/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(database)) {
      return yield* failed(ownedDatabaseStage);
    }
    const providerConnection = yield* Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL');
    if (Redacted.value(providerConnection) !== runtime.connectionString) {
      return yield* failed('provider-database');
    }
    const observed = yield* PgClient.make({ maxConnections: 1, url: providerConnection }).pipe(
      Effect.provide(Reactivity.layer),
    );
    const identities = yield* observed
      .unsafe(`select current_database() as database, current_user as role,
      rolsuper as superuser, rolbypassrls as bypass from pg_catalog.pg_roles where rolname=current_user`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                bypass: Schema.Boolean,
                database: Schema.String,
                role: Schema.String,
                superuser: Schema.Boolean,
              }),
            ]),
          ),
        ),
      );
    if (
      identities[0].database !== database ||
      identities[0].role !== runtime.expectedRole ||
      identities[0].superuser ||
      identities[0].bypass
    ) {
      return yield* failed(providerRuntimeRole);
    }
    const requiredTables = COMMERCE_PORTAL_AUTH_TABLES.map(getTableName);
    const readInventory = () =>
      observed
        .unsafe(`select c.relname as name,
      has_table_privilege(current_user,c.oid,'SELECT') and has_table_privilege(current_user,c.oid,'INSERT') and has_table_privilege(current_user,c.oid,'UPDATE') and has_table_privilege(current_user,c.oid,'DELETE') as usable
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='commerce_auth' and c.relkind='r' order by c.relname`)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String, usable: Schema.Boolean }))),
          ),
        );
    const inventory = yield* readInventory();
    if (inventory.length === 0) {
      const schema = yield* observed
        .unsafe(`select to_regnamespace('commerce_auth') is null as absent`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ absent: Schema.Boolean })]))));
      if (!schema[0].absent) {
        return yield* failed(providerSchemaInventory);
      }
      return false;
    }
    if (
      inventory.length !== requiredTables.length ||
      requiredTables.some((name) => !inventory.some((table) => table.name === name && table.usable))
    ) {
      return yield* failed(providerSchemaInventory);
    }
    return true;
  },
);

const prepareOwnedProviderStorage = Effect.fn('RetainedConsentOwner.prepareOwnedProviderStorage')(
  function* prepareOwnedProviderStorage() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    if (
      connections.admin.database !== connections.runtime.database ||
      connections.admin.host !== connections.runtime.host ||
      connections.admin.port !== connections.runtime.port ||
      connections.admin.user === connections.runtime.user
    ) {
      return yield* failed(ownedDatabaseStage);
    }
    if (!(yield* ownedProviderStorageIsReady(connections.runtime))) {
      yield* migrateOwnedPortalAuth(connections.admin, connections.runtime.user);
      if (!(yield* ownedProviderStorageIsReady(connections.runtime))) {
        return yield* failed(providerSchemaInventory);
      }
    }
    return yield* Effect.void;
  },
);

const verifyPreparedProviderStorage = Effect.fn('RetainedConsentOwner.verifyPreparedProviderStorage')(
  function* verifyPreparedProviderStorage() {
    // HTTP processes receive only their runtime identity, never the administrative connection.
    const runtime = yield* loadDatabaseConfig({ envPath: '/dev/null', identity: SHARED_RUNTIME_IDENTITY });
    if (!(yield* ownedProviderStorageIsReady(runtime))) {
      return yield* failed(providerSchemaInventory);
    }
    return yield* Effect.void;
  },
);

const readDeclaredEnrollmentPhases = Effect.fn('RetainedConsentOwner.readDeclaredEnrollmentPhases')(
  function* readDeclaredEnrollmentPhases(
    command: typeof observeEnrollmentCommand.Type,
    observation: Pick<
      typeof enrollmentObservationSchema.Type,
      'continuation' | 'coreReadAuthentication' | 'coreReadCredential' | 'coreTransport' | 'providerVerification'
    >,
  ) {
    const principal = yield* bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker).verify(
      command.authorization,
    );
    const input = yield* Schema.decodeUnknownEffect(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: command.attemptId,
      tenantId: principal.tenantId,
    });
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: principal.tenantId }, runner.run);
    const attempt = yield* store.read(input);
    if (attempt.createdByPrincipalId !== principal.principalId || attempt.journey !== 'RETAIL_SELF_ENROLLMENT') {
      return yield* failed(enrollmentObservationStage);
    }
    const phases = yield* Effect.forEach((transition: JourneyTransitionSpec) =>
      Effect.gen(function* readDeclaredTransition() {
        const operationInput = yield* Schema.decodeUnknownEffect(ReadEnrollmentOwnerOperationInputSchema)({
          ...input,
          ownerModuleKey: transition.ownerModuleKey,
          transitionKey: transition.transitionKey,
        });
        const operation = yield* store.readOwnerOperation(operationInput).pipe(
          Effect.map(Option.some),
          Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeed(Option.none())),
        );
        return yield* Schema.decodeUnknownEffect(enrollmentObservationSchema.fields.phases.value)({
          phase: transition.transitionKey,
          status: Option.isSome(operation) ? operation.value.status : 'NOT_STARTED',
        });
      }),
    )(retailSelfEnrollmentJourneyDefinition.requiredTransitions);
    return enrollmentObservationSchema.make({
      _tag: enrollmentObservationStage,
      ...observation,
      attemptStatus: attempt.state,
      phases,
    });
  },
);
interface ServerPartyObservation {
  _tag: typeof serverPartyObservationSchema.Type._tag;
  failure: typeof serverPartyObservationSchema.Type.failure;
  httpStatus: typeof serverPartyObservationSchema.Type.httpStatus;
  stage: typeof serverPartyObservationSchema.Type.stage;
}
const serverPartyObservation: ServerPartyObservation = {
  _tag: 'server-party-observation',
  failure: 'NONE',
  httpStatus: 0,
  stage: 'NOT_ENTERED',
};
const retainedServerScopeSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  legalEntityId: EnrollmentLegalEntityIdSchema,
  managerPrincipalId: PrincipalIdSchema,
  tenantId: EnrollmentTenantIdSchema,
});
const retainedPartyAppId = 'party-registry';
const actualPartyModule = (entry: { readonly deployment: { readonly appId: string } }) =>
  entry.deployment.appId === retainedPartyAppId;
type RetainedServerPartyFailure =
  | Effect.Error<ReturnType<typeof issueApiKeyGatewayContext>>
  | Effect.Error<ReturnType<typeof executePartyDetailWithAuthorization>>
  | Effect.Error<ActiveApplicationCompositionServiceContract['load']>
  | ProfilePersistenceDependencyFailure;
const observeServerPartyFailure = (error: RetainedServerPartyFailure) =>
  Effect.sync(() => {
    if (serverPartyObservation.failure !== 'NONE') {
      return;
    }
    const problem = Schema.decodeUnknownResult(
      Schema.Struct({ status: serverPartyObservationSchema.fields.httpStatus }),
    )(error);
    serverPartyObservation.failure = Result.isSuccess(problem) ? 'HTTP_STATUS' : 'OTHER';
    serverPartyObservation.httpStatus = Result.isSuccess(problem) ? problem.success.status : 0;
  });
const observePartyDetailReturned = Effect.sync(() => {
  serverPartyObservation.stage = 'PUBLIC_DETAIL_RETURNED';
});
const resolveRetainedParty = (
  scope: typeof retainedServerScopeSchema.Type,
  apiKey: Redacted.Redacted,
  shellBaseUrl: URL,
  authority: ActiveApplicationCompositionServiceContract,
  input: PartyRegistryRetailPartyResolverFactoryInput,
  request: Parameters<ReturnType<typeof makePartyRegistryRetailPartyResolver>>[0],
) =>
  Effect.gen(function* resolveActualServerParty() {
    serverPartyObservation.stage = 'ENTERED';
    const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
    serverPartyObservation.stage = 'COMPOSITION_LOADED';
    const party = snapshot.composition.modules.find(actualPartyModule);
    if (
      input.tenantId !== scope.tenantId ||
      request.tenantId !== scope.tenantId ||
      snapshot.composition.revision !== scope.compositionRevision ||
      party === undefined
    ) {
      return yield* new ProfilePersistenceDependencyFailure({
        reason: 'The owned Party server scope is not admitted',
      });
    }
    const gateway = yield* issueApiKeyGatewayContext(
      {
        audience: retainedPartyAppId,
        compositionRevision: scope.compositionRevision,
        legalEntityId: scope.legalEntityId,
      },
      { apiKey, baseUrl: shellBaseUrl, requestCorrelation: input.requestCorrelation },
    );
    serverPartyObservation.stage = 'GATEWAY_ISSUED';
    if (
      gateway.compositionRevision !== scope.compositionRevision ||
      gateway.apiBaseUrl !== moduleReleaseApiBaseUrl(retainedPartyAppId, party.deployment.buildMarker)
    ) {
      return yield* new ProfilePersistenceDependencyFailure({
        reason: 'The actual Party gateway release does not match the owned server scope',
      });
    }
    const resolved = yield* makePartyRegistryRetailPartyResolver(input, (payload, correlation) =>
      executePartyDetailWithAuthorization(payload, `Bearer ${gateway.token}`, correlation, {
        baseUrl: new URL(gateway.apiBaseUrl, shellBaseUrl),
        compositionRevision: scope.compositionRevision,
      }).pipe(Effect.tap(observePartyDetailReturned), Effect.tapError(observeServerPartyFailure)),
    )(request);
    serverPartyObservation.stage = 'RESOLVED';
    return resolved;
  }).pipe(
    Effect.tapError(observeServerPartyFailure),
    Effect.mapError(
      () =>
        new ProfilePersistenceDependencyFailure({
          reason: 'The actual configured server Party operation is unavailable',
        }),
    ),
  );
const retainedPartyResolverFactoryLive = Layer.effect(
  PartyRegistryRetailPartyResolverFactory,
  Effect.gen(function* makeRetainedServerPartyResolver() {
    const scope = yield* Config.schema(
      Schema.fromJsonString(retainedServerScopeSchema),
      'ONTOS_RETAINED_CONSENT_SERVER_SCOPE',
    );
    const apiKey = yield* Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY');
    const shellBaseUrl = yield* Config.schema(Schema.URLFromString, 'ONTOS_SHELL_GATEWAY_BASE_URL');
    const authority = yield* ActiveApplicationCompositionService;
    serverPartyObservation.stage = 'FACTORY_BUILT';
    return PartyRegistryRetailPartyResolverFactory.of({
      make: (input) => {
        serverPartyObservation.stage = 'FACTORY_MADE';
        return (request) => resolveRetainedParty(scope, apiKey, shellBaseUrl, authority, input, request);
      },
    });
  }),
);
const readOwnedBinding = Effect.fn('RetainedConsentOwner.readOwnedBinding')(function* readOwnedBinding(
  command: typeof observeBindingCommand.Type,
  reader: ProfileRetailPermissionReaderFactoryService,
) {
  const expected = yield* Config.schema(
    Schema.fromJsonString(retainedServerScopeSchema),
    'ONTOS_RETAINED_CONSENT_SERVER_SCOPE',
  );
  const principal = yield* bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker).verify(
    command.authorization,
  );
  if (
    principal.principalId !== expected.managerPrincipalId ||
    principal.tenantId !== expected.tenantId ||
    principal.legalEntityId !== expected.legalEntityId ||
    principal.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID ||
    principal.impersonatedByPrincipalId !== undefined
  ) {
    return yield* failed(bindingObservationStage);
  }
  const request = yield* Schema.decodeUnknownEffect(RetailPortalProfileBindingReadRequestSchema)({
    bindingRef: {
      moduleId: 'commerce.customer-context',
      resourceId: command.bindingId,
      resourceType: 'commerce.customer-context.retail-portal-profile-binding',
      tenantId: principal.tenantId,
    },
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: command.profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: principal.tenantId,
    },
  });
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const result = yield* runner.run(
    { legalEntityId: expected.legalEntityId, tenantId: principal.tenantId },
    (transaction) =>
      profilePersistenceServicesForTransaction(
        transaction,
        {
          legalEntityId: expected.legalEntityId,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
        {
          readRetailPermissions: reader.make({
            legalEntityId: expected.legalEntityId,
            principalId: command.principalId,
            tenantId: principal.tenantId,
          }),
        },
      )
        .retailPortalProfileBindingRead.readBinding(request, command.principalId, principal.tenantId)
        .pipe(
          Effect.mapError(
            () =>
              new CommerceEnrollmentAttemptUnavailable({
                code: 'attempt_unavailable',
                reason: 'The owned binding observation is unavailable',
                retryable: true,
              }),
          ),
        ),
  );
  if (!Schema.is(Schema.Struct({ _tag: Schema.Literal('BINDING_AVAILABLE') }))(result) || !('binding' in result)) {
    return yield* failed(bindingObservationStage);
  }
  if (
    result.binding.bindingRef.resourceId !== command.bindingId ||
    result.binding.profileRef.resourceId !== command.profileId ||
    result.binding.principalRef.resourceId !== command.principalId ||
    result.binding.sellingLegalEntityRef.resourceId !== expected.legalEntityId
  ) {
    return yield* failed(bindingObservationStage);
  }
  return yield* Schema.decodeUnknownEffect(bindingObservationSchema)({
    _tag: bindingObservationStage,
    authorizationState: result.binding.authorizationState,
    bindingState: result.binding.state,
    current: result.authorizationFreshness.status === 'CURRENT' && result.permissionsFreshness.status === 'CURRENT',
    manageAllowed: result.grantedPermissions.includes('retail.consent.manage'),
    profileReadAllowed: result.grantedPermissions.includes('retail.profile.read'),
    revision: result.binding.revision,
  });
});
const serve = Effect.scoped(
  Effect.gen(function* retainedConsentOwnerServer() {
    const { pull, writer } = yield* openPrivateCommandSocket();
    yield* verifyPreparedProviderStorage();
    const configuredOrigin = yield* Config.String('COMMERCE_PORTAL_AUTH_URL');
    const portalOrigin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(configuredOrigin).pipe(
      Effect.mapError(() => failed('portal-origin')),
    );
    if (portalOrigin.username !== '' || portalOrigin.password !== '' || portalOrigin.pathname !== '/') {
      return yield* failed('portal-origin');
    }
    const emailEndpoint = yield* Config.String('RESEND_API_URL').pipe(Config.withDefault(RESEND_EMAILS_ENDPOINT));
    if (emailEndpoint !== RESEND_EMAILS_ENDPOINT) {
      return yield* failed('email-endpoint');
    }
    const mailbox: OwnedVerificationInbox = {};
    const deliveredEmailRequests: Request[] = [];
    const continuationObservation: ContinuationObservation = {
      continuation: 'NOT_OBSERVED',
      coreReadAuthentication: 'NOT_OBSERVED',
      coreReadCredential: { matchesConfigured: false, present: false },
      coreTransport: { activate: 'NOT_OBSERVED', read: 'NOT_OBSERVED', reserve: 'NOT_OBSERVED' },
      providerVerification: { authorizationPresent: false, received: false, result: 'NOT_OBSERVED', status: 0 },
    };
    const continuationLogger = Logger.make((options) => {
      const message = Schema.decodeUnknownResult(Schema.Tuple([Schema.String]))(options.message);
      if (Result.isFailure(message)) {
        return;
      }
      if (message.success[0] === 'The Commerce enrollment continuation did not advance this Attempt') {
        continuationObservation.continuation = 'FAILURE_LOGGED';
      } else if (message.success[0] === 'The Commerce enrollment journey halted before completion') {
        const reason = Schema.decodeUnknownResult(
          Schema.Literals([
            'ATTEMPT_TERMINAL',
            'IN_FLIGHT',
            'NO_OWNER_EFFECT',
            'OWNER_REJECTED',
            'RECONCILIATION_REQUIRED',
            'VERIFICATION_REQUIRED',
          ]),
        )(options.fiber.getRef(References.CurrentLogAnnotations).reason);
        continuationObservation.continuation = Result.isSuccess(reason) ? reason.success : 'UNKNOWN_HALT';
      }
    });
    const claimed = yield* Ref.make(false);
    const commandOperation = yield* Ref.make<typeof commandOperationSchema.Type>('CLAIM_COMMAND');
    const commandObservation = yield* Ref.make<
      Option.Option<{
        readonly httpStatus?: typeof failureHttpStatusSchema.Type;
        readonly problemCode: typeof failureProblemCodeSchema.Type;
      }>
    >(Option.none());
    const cookies = yield* Ref.make(Redacted.make(''));
    const actualFetch = globalThis.fetch;
    // A private foreign Fetch callback owns only transport inbox state. It runs no nested Effect
    // runtime and makes no authority decision. Invalid delivery is a typed Resend HTTP refusal.
    const coreOperations = new Map<string, keyof typeof enrollmentObservationSchema.Type.coreTransport>([
      ['/auth/identity/external/bindings/read', 'read'],
      ['/auth/identity/external/bindings/reserve', 'reserve'],
      ['/auth/identity/external/bindings/activate', 'activate'],
    ]);
    const expectedCoreKey = yield* Config.Redacted('COMMERCE_CORE_IDENTITY_API_KEY');
    const authenticationDetails = new Map<string, typeof enrollmentObservationSchema.Type.coreReadAuthentication>([
      ['A workload API key is required', 'MISSING'],
      ['The workload API key is invalid', 'INVALID'],
      ['The workload API key is not usable', 'UNUSABLE'],
    ]);
    const observeCoreResponse = async (url: URL, response: Response) => {
      const operation = coreOperations.get(url.pathname);
      if (operation !== undefined) {
        if (response.ok) {
          continuationObservation.coreTransport[operation] = 'SUCCESS';
        } else {
          continuationObservation.coreTransport[operation] = 'UNPUBLISHED_PROBLEM';
          try {
            const problem = Schema.decodeUnknownResult(Schema.Union(externalIdentityProblems))(
              await response.clone().json(),
            );
            if (Result.isSuccess(problem) && problem.success.status === response.status) {
              continuationObservation.coreTransport[operation] = problem.success._tag;
              if (operation === 'read' && Schema.is(ExternalIdentityUnauthorizedProblemSchema)(problem.success)) {
                continuationObservation.coreReadAuthentication =
                  authenticationDetails.get(problem.success.detail) ?? 'OTHER';
              }
            }
          } catch {
            // Observation failure never replaces the real response or reveals its contents.
          }
        }
      }
    };
    const localInboxFetch: typeof globalThis.fetch = async (input, init) => {
      const inputUrl = Schema.is(Schema.Struct({ url: Schema.String }))(input) ? input.url : String(input);
      const parsedUrl = Schema.decodeUnknownResult(Schema.URLFromString)(inputUrl);
      if (Result.isFailure(parsedUrl)) {
        return Response.json({ message: 'Unsupported owned transport' }, { status: 503 });
      }
      const url = parsedUrl.success;
      if (url.href !== RESEND_EMAILS_ENDPOINT) {
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.username !== '' ||
          url.password !== ''
        ) {
          return Response.json({ message: 'Unsupported owned transport' }, { status: 503 });
        }
        if (url.pathname === '/auth/identity/external/bindings/read') {
          let headers = new Headers(init?.headers);
          if (init?.headers === undefined && Schema.is(Schema.Struct({ headers: Schema.instanceOf(Headers) }))(input)) {
            ({ headers } = input);
          }
          const suppliedKey = headers.get('x-api-key');
          continuationObservation.coreReadCredential = {
            matchesConfigured: suppliedKey === Redacted.value(expectedCoreKey),
            present: suppliedKey !== null && suppliedKey.trim().length > 0,
          };
        }
        const response = await actualFetch(input, init);
        await observeCoreResponse(url, response);
        return response;
      }
      // FetchHttpClient forwards real encoded bytes. Read the request with normal
      // Fetch semantics before applying the same closed owner delivery contract.
      const deliveredRequest = new Request(input, init);
      const body = await deliveredRequest.text();
      const envelope = Schema.decodeUnknownResult(
        Schema.Struct({
          body: Schema.fromJsonString(emailSchema),
          method: Schema.Literal('POST'),
        }),
      )({ body, method: deliveredRequest.method });
      if (Result.isFailure(envelope) || mailbox.expectedAddress === undefined || mailbox.link !== undefined) {
        return Response.json({ message: invalidDeliveryMessage }, { status: 503 });
      }
      const delivered = envelope.success.body;
      if (delivered.to[0] !== mailbox.expectedAddress) {
        return Response.json({ message: invalidDeliveryMessage }, { status: 503 });
      }
      const candidates = Redacted.value(delivered.text).match(/https?:\/\/[^\s<>]+/gu) ?? [];
      const link = candidates.find((candidate) => {
        if (!URL.canParse(candidate)) {
          return false;
        }
        const parsed = new URL(candidate);
        return (
          parsed.origin === portalOrigin.origin &&
          parsed.pathname === `${COMMERCE_CUSTOMER_CONTEXT_API_PREFIX}/api/portal-auth/verify-email` &&
          parsed.searchParams.has('token')
        );
      });
      if (link === undefined) {
        return Response.json({ message: invalidDeliveryMessage }, { status: 503 });
      }
      mailbox.link = Redacted.make(link);
      return Response.json({ id: 'owned-native-verification-delivery' });
    };
    const observeDeliveredEmail = Effect.fn('RetainedConsentOwner.observeDeliveredEmail')(
      function* observeDeliveredEmail(delivery: Request) {
        // Parse the bytes captured by the installed Resend transport through the same
        // exact-recipient/link checks. This consumes no new provider operation.
        const response = yield* Effect.tryPromise({
          catch: () => failed(verificationBodyStage),
          try: async () => await localInboxFetch(delivery),
        });
        if (!response.ok) {
          // Surface only the receiver's actual closed status. No address, body or token
          // crosses the private command reply. An empty capture queue has no such status.
          const status = yield* Schema.decodeUnknownEffect(failureHttpStatusSchema)(response.status).pipe(
            Effect.mapError(() => failed(verificationBodyStage)),
          );
          yield* Ref.set(commandObservation, Option.some({ httpStatus: status, problemCode: 'UNKNOWN_PROBLEM' }));
          return yield* failed(verificationNotDeliveredStage);
        }
        return yield* Effect.void;
      },
    );
    const compositionSource = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer));
    const core = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
    const ownerTransactions = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
      Layer.provide(ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provide(core))),
    );
    const provider = commercePortalAuthVerificationProviderLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          CommercePortalAuthSessionReaderLive.pipe(Layer.provide(CommercePortalAuthDatabaseLive)),
          CommerceEnrollmentProofServiceLive.pipe(Layer.provide(ownerTransactions)),
        ),
      ),
      Layer.provide(CommercePortalAuthConfigLive),
    );
    const replay = GatewayAssertionRedemptionLive.pipe(
      Layer.provide(
        GatewayAssertionRedemptionDatabaseLive.pipe(
          Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
          Layer.provide(Reactivity.layer),
          Layer.provide(DatabaseConfigLive),
        ),
      ),
    );
    const grants = yield* Config.schema(
      Schema.fromJsonString(CommercePortalAuthVerificationWorkloadGrantsSchema),
      'ONTOS_RETAINED_CONSENT_VERIFICATION_WORKLOAD_GRANTS',
    );
    const verificationLayer = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provide(commercePortalAuthVerificationHttpExecutorLive),
      Layer.provide(provider),
      Layer.provide(commercePortalAuthVerificationWorkloadAuthorizationLive),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationWorkloadGrantConfiguration, grants)),
      Layer.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(compositionSource))),
      Layer.provide(replay),
      Layer.provide(HttpServer.layerServices),
      Layer.orDie,
    );
    const verificationHandler = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () => failed(ownerHandlerStage),
        try: async () =>
          await createEffectBffTestHandler({
            module: { default: defineEffectBff({ api: CommercePortalAuthVerificationApi, layer: verificationLayer }) },
            prefix: COMMERCE_CUSTOMER_CONTEXT_API_PREFIX,
          }),
      }),
      (value) => Effect.promise(value.dispose.bind(value)),
    );
    const serverPartyContext = yield* Layer.build(
      retainedPartyResolverFactoryLive.pipe(
        Layer.provide(ActiveApplicationCompositionConfigLive.pipe(Layer.provide(compositionSource))),
      ),
    );
    const serverParty = Layer.succeed(
      PartyRegistryRetailPartyResolverFactory,
      Context.get(serverPartyContext, PartyRegistryRetailPartyResolverFactory),
    );
    const permissionReaderContext = yield* Layer.build(
      profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive)),
    );
    const permissionReader = Context.get(permissionReaderContext, ProfileRetailPermissionReaderFactory);
    const configuredRealm = commercePortalAuthRealmLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          CommercePortalAuthConfigLive,
          // Bind the capture Fetch when each send executes, including provider callbacks
          // that run in their captured Effect context rather than this HTTP request's fiber.
          localEmailDeliveryLive(deliveredEmailRequests),
        ),
      ),
    );
    // The Action preflight must observe the same provider realm as the public account
    // route, not a separately environment-selected realm with another delivery context.
    const coreIdentity = CommerceCoreIdentityClientLive.pipe(Layer.provideMerge(CommerceCoreIdentityClientConfigLive));
    const providerDatabase = CommercePortalAuthDatabaseLive.pipe(Layer.provide(CommercePortalAuthConfigLive));
    const accountLookup = CommercePortalAuthAccountLookupLive.pipe(Layer.provide(providerDatabase));
    const accountReconciliation = CommercePortalAuthAccountCreationReconciliationLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          providerDatabase,
          CommercePortalAuthAccountCreationProviderLive.pipe(Layer.provide(configuredRealm)),
        ),
      ),
    );
    const preparationSubject = CommerceEnrollmentPreparationSubjectResolverLive.pipe(
      Layer.provide(Layer.mergeAll(ownerTransactions, coreIdentity)),
    );
    const preparationAuthority = commerceEnrollmentOwnerTransitionPreparationLive.pipe(
      Layer.provide(Layer.mergeAll(ownerTransactions, accountLookup, accountReconciliation, preparationSubject)),
      Layer.provide(DatabaseConfigLive),
    );
    const preparedActionRuntime = commerceCustomerContextActionRuntimeAwaitingOwnerPreparation.pipe(
      Layer.provide(preparationAuthority),
      Layer.merge(serverParty),
    );
    const configuredRuntime = makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive.pipe(Layer.merge(serverParty)),
      preparedActionRuntime,
      replay,
      configuredRealm,
      Layer.empty,
      DatabaseConfigLive,
      ContextAccessLive,
    );
    const runtimeLayer = configuredRuntime.layer.pipe(
      Layer.merge(Logger.layer([continuationLogger])),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, localInboxFetch)),
      Layer.provide(HttpServer.layerServices),
    );
    const handler = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () => failed(ownerHandlerStage),
        try: async () =>
          await createEffectBffTestHandler({
            module: { default: defineEffectBff({ ...configuredRuntime, layer: runtimeLayer }) },
            prefix: COMMERCE_CUSTOMER_CONTEXT_API_PREFIX,
          }),
      }),
      (value) => Effect.promise(value.dispose.bind(value)),
    );
    const server = yield* HttpServer.HttpServer;
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
      return yield* failed('listener');
    }
    const baseUrl = `http://127.0.0.1:${server.address.port}`;
    yield* server.serve(
      Effect.gen(function* forwardActualOwnerRequest() {
        const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
        const response = yield* Effect.tryPromise({
          catch: () => failed(ownerHandlerStage),
          try: async () => {
            if (
              new URL(request.url).pathname !== `${COMMERCE_CUSTOMER_CONTEXT_API_PREFIX}/portal-auth/internal/verify`
            ) {
              return await handler.handler(request);
            }
            continuationObservation.providerVerification = {
              authorizationPresent: request.headers.has('authorization'),
              received: true,
              result: 'NOT_OBSERVED',
              status: 0,
            };
            const verifiedResponse = await verificationHandler.handler(request);
            const observed = continuationObservation.providerVerification;
            const status = Schema.decodeUnknownResult(
              enrollmentObservationSchema.fields.providerVerification.fields.status,
            )(verifiedResponse.status);
            let observedResult: typeof enrollmentObservationSchema.Type.providerVerification.result =
              'INVALID_RESPONSE';
            try {
              const body = await verifiedResponse.clone().json();
              if (verifiedResponse.status === 200) {
                const result = Schema.decodeUnknownResult(Schema.toCodecJson(VerifyExternalAuthenticationResultSchema))(
                  body,
                );
                if (Result.isSuccess(result)) {
                  observedResult = result.success.outcome;
                }
              } else {
                const problem = Schema.decodeUnknownResult(Schema.Union(commercePortalAuthVerificationProblems))(body);
                if (Result.isSuccess(problem) && problem.success.status === verifiedResponse.status) {
                  observedResult = problem.success._tag;
                }
              }
            } catch {
              // Observation failure cannot replace the genuine verifiedResponse.
            }
            continuationObservation.providerVerification = {
              ...observed,
              result: observedResult,
              status: Result.isSuccess(status) ? status.success : 0,
            };
            return verifiedResponse;
          },
        }).pipe(bounded);
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const request = Effect.fn('RetainedConsentOwner.request')(function* request(
      path: string,
      init: Omit<RequestInit, 'headers'> & { readonly headers?: Readonly<Record<string, string>> },
    ) {
      const response = yield* Effect.tryPromise({
        catch: () => failed('public-request'),
        try: async () =>
          await actualFetch(`${baseUrl}${COMMERCE_CUSTOMER_CONTEXT_API_PREFIX}${path}`, {
            ...init,
            headers: { origin: portalOrigin.origin, ...init.headers },
            redirect: 'manual',
          }),
      }).pipe(bounded);
      return response;
    });
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          Ref.set(cookies, Redacted.make('')),
          Effect.sync(() => {
            delete mailbox.link;
            delete mailbox.expectedAddress;
            deliveredEmailRequests.length = 0;
          }),
        ],
        { discard: true },
      ),
    );
    yield* Effect.sync(() =>
      process.stdout.write(`${JSON.stringify({ baseUrl, marker: ultramodernDeliveryUnit, type: 'ready' })}\n`),
    );
    return yield* Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) =>
        line.length <= 65_536 ? Effect.succeed(line) : Effect.fail(failed('private-frame-bound')),
      ),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(commandSchema), { onExcessProperty: 'error' })(line),
      ),
      Stream.runForEach((command) => {
        if (Schema.is(observePartyCommand)(command)) {
          return privateReply(writer, serverPartyObservationSchema.make(serverPartyObservation));
        }
        if (Schema.is(observeBindingCommand)(command)) {
          return readOwnedBinding(command, permissionReader).pipe(
            Effect.provide(ownerTransactions),
            Effect.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(compositionSource))),
            Effect.flatMap((value) => privateReply(writer, value)),
            Effect.catch(() =>
              privateReply(writer, {
                _tag: 'command-failed',
                code: 'retained_consent_fixture_failure',
                command: observeBindingTag,
                operation: 'CLAIM_COMMAND',
                stage: bindingObservationStage,
              }),
            ),
          );
        }
        return Effect.gen(function* executeClosedOwnerCommand() {
          yield* Ref.set(commandOperation, 'CLAIM_COMMAND');
          yield* Ref.set(commandObservation, Option.none());
          if (Schema.is(observeEnrollmentCommand)(command)) {
            yield* Ref.set(commandOperation, 'OBSERVE_ENROLLMENT');
            const observation = yield* readDeclaredEnrollmentPhases(command, continuationObservation).pipe(
              Effect.provide(ownerTransactions),
              Effect.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(compositionSource))),
              Effect.mapError(() => failed(enrollmentObservationStage)),
            );
            return yield* privateReply(writer, observation);
          }
          if (Schema.is(Schema.TaggedStruct('sign-out', {}))(command)) {
            yield* Ref.set(commandOperation, 'SIGN_OUT');
            const response = yield* request('/api/portal-auth/sign-out', {
              body: '{}',
              headers: { 'content-type': 'application/json', cookie: Redacted.value(yield* Ref.get(cookies)) },
              method: 'POST',
            });
            if (!response.ok) {
              return yield* failed('sign-out');
            }
            yield* Ref.set(cookies, Redacted.make(''));
            return yield* privateReply(writer, { _tag: 'signed-out' });
          }
          if (yield* Ref.getAndSet(claimed, true)) {
            return yield* failed('duplicate-enrollment');
          }
          const crypto = yield* Crypto.Crypto;
          const email = `retained-${yield* crypto.randomUUIDv4()}@example.test`;
          const password = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
          yield* Effect.sync(() => {
            mailbox.expectedAddress = email;
          });
          yield* Ref.set(commandOperation, 'START_ENROLLMENT');
          const start = yield* request('/api/portal-auth/enrollment/start', {
            body: JSON.stringify({
              displayName: 'Retained Consent native proof',
              email,
              journey: 'RETAIL_SELF_ENROLLMENT',
              partyRef: command.partyRef,
              password: Redacted.value(password),
              sellingLegalEntityId: command.sellingLegalEntityId,
            }),
            headers: {
              authorization: Redacted.value(command.authorization),
              'content-type': 'application/json',
              'idempotency-key': yield* crypto.randomUUIDv4(),
              'x-correlation-id': yield* crypto.randomUUIDv4(),
            },
            method: 'POST',
          });
          if (!start.ok) {
            const body = yield* Effect.tryPromise({
              catch: () => failed(enrollmentBodyStage),
              try: async () => await start.json(),
            }).pipe(Effect.result);
            let problemCode: typeof failureProblemCodeSchema.Type = 'UNKNOWN_PROBLEM';
            if (Result.isSuccess(body)) {
              const published = Schema.decodeUnknownResult(publishedEnrollmentProblemSchema, {
                onExcessProperty: 'error',
              })(body.success);
              if (Result.isSuccess(published) && published.success.status === start.status) {
                problemCode = published.success.code;
              }
            }
            const status = Schema.decodeUnknownResult(failureHttpStatusSchema)(start.status);
            const observation = Result.isSuccess(status)
              ? { httpStatus: status.success, problemCode }
              : { problemCode };
            yield* Ref.set(commandObservation, Option.some(observation));
            return yield* failed('public-enrollment');
          }
          const started = yield* Effect.tryPromise({
            catch: () => failed(enrollmentBodyStage),
            try: async () => await start.json(),
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(startedSchema)));
          if (
            started.outcome !== 'CREATED' ||
            started.attempt.journey !== 'RETAIL_SELF_ENROLLMENT' ||
            started.attempt.targetLegalEntityId !== command.sellingLegalEntityId
          ) {
            return yield* failed('enrollment-identity');
          }
          const signInInput = JSON.stringify({ email, password: Redacted.value(password) });
          yield* Ref.set(commandOperation, 'REQUIRE_VERIFICATION');
          const before = yield* request('/api/portal-auth/sign-in/email', {
            body: signInInput,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          });
          if (before.status !== 403 || before.headers.getSetCookie().length !== 0) {
            return yield* failed('verification-required');
          }
          yield* Effect.tryPromise({
            catch: () => failed('verification-required-body'),
            try: async () => await before.json(),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('verification_required') })),
            ),
          );
          yield* Effect.forEach(deliveredEmailRequests.splice(0), observeDeliveredEmail, {
            concurrency: 1,
            discard: true,
          });
          const delivered = yield* Effect.sync(() => Option.fromUndefinedOr(mailbox.link));
          if (Option.isNone(delivered)) {
            return yield* failed(verificationNotDeliveredStage);
          }
          const link = new URL(Redacted.value(delivered.value));
          yield* Ref.set(commandOperation, 'VERIFY_EMAIL');
          const verify = yield* request(
            `${link.pathname.replace(COMMERCE_CUSTOMER_CONTEXT_API_PREFIX, '')}${link.search}`,
            { method: 'GET' },
          );
          if (!verify.ok) {
            return yield* failed('public-verification');
          }
          yield* Effect.tryPromise({
            catch: () => failed(verificationBodyStage),
            try: async () => await verify.json(),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ outcome: Schema.Literal('EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT') }),
              ),
            ),
          );
          yield* Effect.sync(() => {
            delete mailbox.link;
          });
          yield* Ref.set(commandOperation, 'SIGN_IN');
          const signedIn = yield* request('/api/portal-auth/sign-in/email', {
            body: signInInput,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          });
          if (!signedIn.ok) {
            return yield* failed('public-sign-in');
          }
          const cookie = signedIn.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; ');
          if (cookie === '') {
            return yield* failed('session-cookie');
          }
          yield* Ref.set(cookies, Redacted.make(cookie));
          yield* Ref.set(commandOperation, 'READ_SESSION');
          const current = yield* request('/api/portal-auth/get-session', { headers: { cookie }, method: 'GET' });
          if (!current.ok) {
            return yield* failed('public-session');
          }
          const session = yield* Effect.tryPromise({
            catch: () => failed('session-body'),
            try: async () => await current.json(),
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(sessionSchema)));
          return yield* privateReply(writer, {
            _tag: 'enrolled',
            attemptId: started.attempt.portalEnrollmentAttemptId,
            providerSubjectId: session.session.providerSubjectId,
            sessionRef: session.session.sessionRef,
          });
        }).pipe(
          bounded,
          Effect.catchTag('RetainedConsentOwnerFixtureError', (failure) => {
            const known = Schema.decodeUnknownResult(commandFailureStageSchema)(failure.stage);
            if (Result.isFailure(known)) {
              return Effect.fail(failure);
            }
            return Effect.gen(function* reportKnownCommandFailure() {
              const operation = yield* Ref.get(commandOperation);
              const observation = yield* Ref.get(commandObservation);
              const reply = commandFailureSchema.make({
                code: 'retained_consent_fixture_failure',
                command: command._tag,
                operation,
                stage: known.success,
              });
              if (Option.isSome(observation)) {
                return yield* privateReply(writer, { ...reply, ...observation.value });
              }
              return yield* privateReply(writer, reply);
            });
          }),
        );
      }),
    );
  }),
);

const reportKnownStartupFailure = Effect.fn('RetainedConsentOwner.reportKnownStartupFailure')(
  function* reportKnownStartupFailure(failure: RetainedConsentOwnerFixtureError) {
    if (
      [
        ownedDatabaseStage,
        'provider-database',
        providerRuntimeRole,
        providerSchemaInventory,
        providerAdminDatabase,
        'provider-owner-migration',
      ].includes(failure.stage)
    ) {
      yield* Effect.sync(() =>
        process.stdout.write(`${JSON.stringify({ stage: failure.stage, type: 'fixture-failed' })}\n`),
      );
    }
  },
);

const runFixtureMode = Effect.fn('RetainedConsentOwner.runFixtureMode')(function* runFixtureMode() {
  if (process.argv.includes('--describe')) {
    return yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({ marker: ultramodernDeliveryUnit, subscriptions: extractOutboxWorkerSubscriptions(outboxWorkers) })}\n`,
      ),
    );
  }
  if (process.argv.includes('--prepare-owned-provider')) {
    yield* Effect.scoped(prepareOwnedProviderStorage()).pipe(Effect.provide(NodeChildProcessSpawner.layer));
    return yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: 'provider-prepared' })}\n`));
  }
  return yield* serve.pipe(
    Effect.tapErrorTag('RetainedConsentOwnerFixtureError', reportKnownStartupFailure),
    Effect.provide(NodeHttpServer.layerTest),
    Effect.provide(NodeChildProcessSpawner.layer),
  );
});

NodeRuntime.runMain(
  runFixtureMode().pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer),
    Effect.provide(Logger.layer([])),
  ),
  { disableErrorReporting: true },
);
