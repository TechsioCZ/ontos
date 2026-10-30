import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '@app/party-registry-identity-contracts';
import {
  ActionRuntime,
  ReadRuntime,
  ActiveApplicationCompositionSnapshotSchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  TrustedPrincipalContextSchema,
  bindSelfApiKeyAction,
  activatePrincipalBindingAction,
  reservePrincipalBindingAction,
  makeContextPermissionRelationshipMutationLive,
  canonicalizeApplicationComposition,
  validateActiveApplicationCompositionSnapshot,
  loadDatabaseConnectionPair,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { moduleReleaseApiBaseUrl } from '@app/core-runtime/unit-service-fetch';
import {
  ProviderSubjectIdSchema,
  ReadPrincipalBindingPayloadSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { CreatePartyPayloadSchema, partyRegistryApiContract } from '@app/party-registry/api';
import {
  createPartyWithAuthorization,
  executePartyDetailWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
} from '@app/party-registry/api/client';
import { commerceCustomerContextApi, commerceCustomerContextApiContract } from '@app/commerce-customer-context/api';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { shellGatewayContextContract } from '@app/shared-contracts';
import type { GatewayContextRequestSchema } from '@app/shared-contracts';
import {
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeSessionGatewayResponseSchema,
} from '@app/shell-super-app/testing/api-key-gateway-native';
import {
  activatePrincipalBinding,
  issueExternalGatewayContext,
  readPrincipalBinding,
  reservePrincipalBinding,
} from '@app/shared-contracts/server/external-identity-client';
import {
  ExternalGatewayContextRequestSchema,
  ReservePrincipalBindingRequestSchema,
  externalIdentityProblems,
} from '@app/shared-contracts/external-identity';
import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeHttpServer,
  NodeServices,
  NodeSocketServer,
} from '@effect/platform-node';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  Clock,
  Deferred,
  Config,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';
import { Socket } from 'effect/socket';
import { expect, it } from 'effect-rstest';
import { base64url, exportJWK, generateKeyPair } from 'jose';

import {
  RetainedConsentAccountTransportSchema,
  installRetainedAccountEntrypoints,
  installRetainedManagerPartyRead,
  retainedOwnerCredential,
  retainedConsentAccountActionKeys,
} from '../support/privacy-retained-purpose-self-service-http.ts';

import { and, eq } from 'drizzle-orm';
import { privacyApi, privacyApiContract } from '../../shared/api.ts';
import {
  executeAcknowledgePrivacyNoticeWithAuthorization,
  executeAddProcessingPurposeVersionWithAuthorization,
  executeConsentSelfServiceWithAuthorization,
  executeCreateNoticeVersionWithAuthorization,
  executeCreatePrivacySubjectWithAuthorization,
  executeCreateProcessingPurposeWithAuthorization,
  executeRecordConsentDecisionWithAuthorization,
  executeRecordNoticeProvisionWithAuthorization,
} from '@app/privacy/api/client';
import { CreatePrivacySubjectPayloadSchema } from '../../shared/actions/create-privacy-subject.ts';
import { CreateProcessingPurposePayloadSchema } from '../../shared/actions/create-processing-purpose.ts';
import { CreateNoticeVersionPayloadSchema } from '../../shared/actions/create-notice-version.ts';
import { RecordConsentDecisionPayloadSchema } from '../../shared/actions/record-consent-decision.ts';
import { AddProcessingPurposeVersionPayloadSchema } from '../../shared/actions/add-processing-purpose-version.ts';
import { ConsentSelfServicePayloadSchema } from '../../shared/actions/consent-self-service.ts';
import {
  AcknowledgePrivacyNoticeActionAlreadyCommittedProblemSchema,
  AcknowledgePrivacyNoticeActionAuthenticationProblemSchema,
  AcknowledgePrivacyNoticeActionConflictProblemSchema,
  AcknowledgePrivacyNoticeActionIneligibleProblemSchema,
  AcknowledgePrivacyNoticeActionUnavailableProblemSchema,
} from '../../shared/apis/acknowledge-privacy-notice-action.ts';
import { RecordNoticeProvisionActionUnavailableProblemSchema } from '../../shared/apis/record-notice-provision-action.ts';
import {
  NoticePresentationUnavailableProblemSchema,
  NoticePresentationPolicyConflictProblemSchema,
} from '../../shared/apis/notice-presentation.ts';
import { RecordConsentDecisionActionIneligibleProblemSchema } from '../../shared/apis/record-consent-decision-action.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import {
  noticeAcknowledgements,
  noticeProvisions,
  consentDecisions,
  purposeVersions,
} from '../../src/database/schema.ts';

import { makePrivacyApiRuntime } from '../../api/index.ts';
import {
  ConsentSelfServiceAuthority,
  consentSelfServiceAuthorityUnavailable,
} from '../../src/actions/consent-self-service.action.ts';
import {
  CommerceCustomerContextConsentWithdrawalService,
  CommerceCustomerContextConsentWithdrawalServiceLive,
} from '../../src/integrations/commerce-customer-context/commerce-customer-context-consent-withdrawal.service.ts';
import { CommerceCustomerContextNoticeSubjectAuthorityServiceLive } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import {
  PrivacySubjectPartyCredentials,
  PrivacySubjectPartyOwnerLive,
} from '../../src/persistence/privacy-subject-party-owner.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { PrivacyNoticeAcknowledgementError } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import {
  makePrivacyNoticePresentationServiceLayer,
  PrivacyNoticePresentationUnavailableLive,
} from '../../src/services/privacy-notice-presentation.service.ts';
import type { PrivacyNoticePresentationConfiguration } from '../../src/services/privacy-notice-presentation.service.ts';
import { NoticeChannelDeliveryAuthorityForAcknowledgementsLive } from '../../src/services/privacy-notice-acknowledgement-authority.service.ts';
import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import type { RetainedConsentAccountTransport } from '../support/privacy-retained-purpose-self-service-http.ts';

import { makeDsrObligationNative } from '../support/dsr-obligation-native.ts';

// Real public retained-V1 consent lifecycle, using one isolated enrolled account and actual owner services.
class RetainedAccountNativeError extends Schema.TaggedError<RetainedAccountNativeError>()(
  'RetainedAccountNativeError',
  { stage: Schema.String },
) {}
const failed = (stage: string) => new RetainedAccountNativeError({ stage });
const countReads = (reads: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const read of reads) {
    counts.set(read, (counts.get(read) ?? 0) + 1);
  }
  return counts;
};

const uuid = Schema.String.check(Schema.isUUID());
const nonempty = Schema.String.check(Schema.isMinLength(1));
const markerSchema = OntosModuleDeploymentContractSchema.fields.deployment;
const readySchema = Schema.Struct({ marker: markerSchema, port: Schema.Int, type: Schema.Literal('ready') });
const accountReadySchema = Schema.Struct({
  baseUrl: Schema.String,
  marker: markerSchema,
  type: Schema.Literal('ready'),
});
const shellReadySchema = Schema.Struct({ baseUrl: Schema.String, providerUserId: ProviderSubjectIdSchema });
const enrolledReplySchema = Schema.TaggedStruct('enrolled', {
  attemptId: uuid.pipe(Schema.brand('EnrollmentAttemptId')),
  providerSubjectId: ProviderSubjectIdSchema,
  sessionRef: nonempty,
});
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
const enrollmentObservationSchema = Schema.TaggedStruct('enrollment-observation', {
  attemptStatus: Schema.Literals([
    'IN_PROGRESS',
    'VERIFICATION_REQUIRED',
    'COMPLETE',
    'RECONCILIATION_REQUIRED',
    'TERMINATED',
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
const commandFailureStageSchema = Schema.Literals([
  'deadline',
  'enrollment-observation',
  'retail-binding-observation',
  'duplicate-enrollment',
  'enrollment-body',
  'enrollment-identity',
  'public-enrollment',
  'public-request',
  'public-session',
  'public-sign-in',
  'public-verification',
  'session-body',
  'session-cookie',
  'sign-out',
  'verification-body',
  'verification-not-delivered',
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
  command: Schema.Literals(['enroll', 'sign-out', 'observe-enrollment', 'observe-party', 'observe-binding']),
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
const bindingObservationSchema = Schema.TaggedStruct('retail-binding-observation', {
  authorizationState: Schema.Literals(['ACTIVE', 'REVOKED', 'PENDING_GRANT', 'PENDING_REVOKE']),
  bindingState: Schema.Literals(['ACTIVE', 'REVOKED']),
  current: Schema.Boolean,
  manageAllowed: Schema.Boolean,
  profileReadAllowed: Schema.Boolean,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const accountReplySchema = Schema.Union([
  bindingObservationSchema,
  serverPartyObservationSchema,
  enrolledReplySchema,
  enrollmentObservationSchema,
  Schema.TaggedStruct('signed-out', {}),
]);
const issuedReplySchema = Schema.TaggedStruct('issued', {
  providerKeyId: ProviderSubjectIdSchema,
  secret: Schema.RedactedFromValue(Schema.String),
});
const ackReplySchema = Schema.TaggedStruct('ack', {});
const shellReplySchema = Schema.Union([
  issuedReplySchema,
  ackReplySchema,
  ShellNativeSessionGatewayResponseSchema,
  Schema.TaggedStruct('unavailable', {}),
]);
const ownerControlCommandSchema = Schema.Union([
  Schema.TaggedStruct('observe-binding', {
    authorization: Schema.RedactedFromValue(Schema.String),
    bindingId: nonempty.pipe(Schema.brand('RetailPortalProfileBindingResourceId')),
    principalId: uuid.pipe(Schema.brand('PrincipalId')),
    profileId: nonempty.pipe(Schema.brand('RetailCustomerProfileResourceId')),
  }),
  Schema.TaggedStruct('observe-party', {}),
  ShellNativeSessionGatewayCommandSchema,
  Schema.TaggedStruct('issue', {
    principalId: uuid.pipe(Schema.brand('PrincipalId')),
    tenantId: uuid.pipe(Schema.brand('TenantId')),
  }),
  Schema.TaggedStruct('bound', {}),
  Schema.TaggedStruct('enroll', {
    authorization: Schema.RedactedFromValue(Schema.String),
    partyRef: nonempty.pipe(Schema.brand('EnrollmentResourceId')),
    sellingLegalEntityId: uuid.pipe(Schema.brand('EnrollmentLegalEntityId')),
  }),
  Schema.TaggedStruct('sign-out', {}),
  Schema.TaggedStruct('observe-enrollment', {
    attemptId: enrolledReplySchema.fields.attemptId,
    authorization: Schema.RedactedFromValue(Schema.String),
  }),
]);
type OwnerControlCommand = typeof ownerControlCommandSchema.Type;
const ownerIds = ['commerce-customer-context', 'party-registry', 'privacy'] as const;
const appRoot = new URL('../../../../', import.meta.url).pathname;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const retainedNativeCloneTargetMatches = (
  connections: DatabaseConnectionPair,
  source: DatabaseConnectionPair,
  databaseName: string,
): boolean =>
  connections.admin.host === connections.runtime.host &&
  connections.admin.port === connections.runtime.port &&
  connections.admin.database !== source.admin.database &&
  connections.admin.database !== source.runtime.database &&
  connections.admin.database === databaseName &&
  connections.runtime.database === databaseName &&
  /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(databaseName);

// Fixed root-owned setup CLI: metadata-only request/status; credentials stay in its explicit environment.
const prepareRetainedNativeIdentities = Effect.fn('RetainedAccount.prepareRetainedNativeIdentities')(
  function* prepareRetainedNativeIdentities(
    connections: DatabaseConnectionPair,
    capability: { readonly databaseName: string; readonly databaseOid: string; readonly systemIdentifier: string },
  ) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(
      Effect.mapError(() => failed('Canonical fixture database configuration was unavailable')),
    );
    if (!retainedNativeCloneTargetMatches(connections, source, capability.databaseName)) {
      return yield* failed('Canonical native fixture clone target was refused');
    }
    const urls: Record<string, string> = {};
    for (const identity of [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY]) {
      const canonical = yield* loadDatabaseConnectionPair({ envPath: '/dev/null', identity })
        .pipe(Effect.map(({ runtime }) => runtime))
        .pipe(Effect.mapError(() => failed('Canonical fixture identity configuration was unavailable')));
      const address = new URL(canonical.connectionString);
      if (
        canonical.database !== source.runtime.database ||
        canonical.host !== source.runtime.host ||
        canonical.port !== source.runtime.port ||
        canonical.user !== identity.role ||
        canonical.host !== connections.admin.host ||
        canonical.port !== connections.admin.port ||
        !['localhost', '127.0.0.1'].includes(canonical.host) ||
        address.search !== '' ||
        address.hash !== ''
      ) {
        return yield* failed('Canonical native fixture identity target was refused');
      }
      address.pathname = `/${capability.databaseName}`;
      urls[identity.urlKey] = address.href;
    }
    const issuerUrl = urls.SHELL_GATEWAY_ISSUER_DATABASE_URL;
    const requestUrl = urls.PARTY_REGISTRY_DATABASE_URL;
    if (issuerUrl === undefined || requestUrl === undefined) {
      return yield* failed('Canonical native fixture identities were incomplete');
    }
    const child = yield* ChildProcess.make(
      process.execPath,
      [
        `${appRoot}/scripts/integration/support/privacy-native-database-identities.mts`,
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              creatorPid: Schema.Int,
              databaseName: Schema.String,
              databaseOid: Schema.String,
              systemIdentifier: Schema.String,
              type: Schema.Literal('prepare-privacy-native-identities'),
            }),
          ),
        )({ ...capability, creatorPid: process.pid, type: 'prepare-privacy-native-identities' }),
      ],
      {
        cwd: appRoot,
        env: {
          DATABASE_ADMIN_URL: connections.admin.connectionString,
          DATABASE_URL: connections.runtime.connectionString,
          ...urls,
        },
        extendEnv: false,
        forceKillAfter: '2 seconds',
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [lines, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: 3 },
    );
    if (code !== 0 || lines.length !== 1) {
      return yield* failed('Fixed native fixture identity setup failed');
    }
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          databaseName: Schema.Literal(capability.databaseName),
          databaseOid: Schema.Literal(capability.databaseOid),
          systemIdentifier: Schema.Literal(capability.systemIdentifier),
          type: Schema.Literal('privacy-native-identities-prepared'),
        }),
      ),
    )(lines[0], { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => failed('Fixed native fixture identity proof was refused')),
    );
    return { PARTY_REGISTRY_DATABASE_URL: requestUrl, SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerUrl };
  },
);
const commandOutput = Effect.fn('RetainedAccount.commandOutput')(function* commandOutput(
  commandArguments: readonly string[],
) {
  const child = yield* ChildProcess.make('mise', ['exec', '--', ...commandArguments], {
    cwd: appRoot,
    env: { APP_ENV_PATH: '/dev/null' },
    extendEnv: true,
    forceKillAfter: '2 seconds',
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code, stdout] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  ).pipe(Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.fail(failed('deadline')) }));
  if (Number(code) !== 0) {
    return yield* failed('source-description');
  }
  return [...stdout].join('');
});

const ownerBuildIdentitySchema = Schema.Struct({ buildMarker: Schema.String, sourceRevision: Schema.String });
const ownerBuildIdentitiesSchema = Schema.Record(
  Schema.Literals([...ownerIds, 'shell-super-app']),
  ownerBuildIdentitySchema,
);
type OwnerBuildIdentity = typeof ownerBuildIdentitySchema.Type;

// The repository-owned generator executes in a separate owner-loading process.
// No foreign registration, fixture, table, handler or executable is imported here.
const describeContracts = Effect.fn('RetainedAccount.describeContracts')(function* describeContracts() {
  const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
    import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    const ownerIds = ['commerce-customer-context','party-registry','privacy'];
    const buildIdentitySchema = Schema.Struct({buildMarker: Schema.String, sourceRevision: Schema.String});
    const deploymentSchema = Schema.Struct({id: Schema.String,
      deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
    const descriptionSchema = Schema.Struct({
      contracts: Schema.Array(OntosModuleDeploymentContractSchema),
      buildIdentities: Schema.Record(Schema.Literals([...ownerIds, 'shell-super-app']), buildIdentitySchema)
    });
    try { const text = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        shell: deploymentSchema, verticals: Schema.Array(deploymentSchema)
      })))(yield* fs.readFileString('./topology/reference-topology.json'));
      // Capture every identity before contract derivation or test bundling creates artifacts.
      const buildIdentities = {};
      for (const owner of [topology.shell, ...topology.verticals]) {
        if (owner.id !== 'shell-super-app' && !ownerIds.includes(owner.id)) continue;
        buildIdentities[owner.id] = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
          generationBuildMarker: owner.deliveryUnit.buildMarker,
          unitId: owner.deliveryUnit.unitId, workspaceRoot: process.cwd()
        }));
      }
      const contracts = yield* Effect.forEach(ownerIds,
        vertical => deriveOntosModuleDeploymentContract({vertical}), {concurrency:1});
      return yield* Schema.encodeEffect(Schema.fromJsonString(descriptionSchema))({contracts, buildIdentities});
    }));
    process.stdout.write(text); } finally { await runtime.dispose(); }`;
  const output = yield* commandOutput(['node', '--experimental-strip-types', '--input-type=module', '--eval', program]);
  const description = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        buildIdentities: ownerBuildIdentitiesSchema,
        contracts: Schema.Array(OntosModuleDeploymentContractSchema),
      }),
    ),
  )(output).pipe(Effect.mapError(() => failed('owner-contracts')));
  const { buildIdentities, contracts } = description;
  if (
    contracts.length !== ownerIds.length ||
    ownerIds.some(
      (id) =>
        !contracts.some(
          (contract) =>
            contract.deployment.appId === id && contract.deployment.buildMarker === buildIdentities[id].buildMarker,
        ),
    )
  ) {
    return yield* failed('owner-contract-inventory');
  }
  return description;
});

const ownerBuildDefines = Effect.fn('RetainedAccount.ownerBuildDefines')(function* ownerBuildDefines(
  identity: OwnerBuildIdentity,
) {
  const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
  return [
    `--define:ULTRAMODERN_BUILD_MARKER=${yield* encode(identity.buildMarker)}`,
    `--define:ULTRAMODERN_SOURCE_REVISION=${yield* encode(identity.sourceRevision)}`,
  ];
});

// Immutable TEST metadata pins the actual declared component surface; no browser execution or UI build is claimed.
const testFederationDocument = (owner: typeof OntosModuleDeploymentContractSchema.Type) =>
  Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        exposes: Schema.Array(Schema.String),
        name: Schema.String,
        shared: Schema.Array(Schema.Never),
      }),
    ),
  )({
    exposes: owner.manifest.publicSurface.components.map(({ expose }) => expose),
    name: owner.manifest.publicSurface.components[0]?.mfBoundaryId ?? owner.deployment.appId,
    shared: [],
  });

const makeSnapshot = Effect.fn('RetainedAccount.makeSnapshot')(function* makeSnapshot(
  contracts: readonly (typeof OntosModuleDeploymentContractSchema.Type)[],
  shell: (typeof OntosShellRuntimeContractSchema.Type)['deployment'],
  origins: Readonly<Record<string, string>>,
) {
  const base = yield* makeApplicationCompositionSnapshotFixture(ownerIds);
  const shellContract = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
    contributionAbi: base.composition.shell.contributionAbi,
    coreCapabilities: [],
    deployment: shell,
    schemaVersion: '2',
  });
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('RetainedAccount.module')(function* module(entry) {
      const owner = contracts.find((contract) => contract.deployment.appId === entry.deployment.appId);
      if (owner === undefined) {
        return yield* failed('owner-contract-missing');
      }
      const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        owner,
      );
      const hash = digest(contractDocument);
      const baseUrl = new URL(origins[entry.deployment.appId] ?? 'http://127.0.0.1:1/').href;
      const { components } = owner.manifest.publicSurface;
      const [component] = components;
      const federationDocument = yield* testFederationDocument(owner);
      return {
        ...entry,
        allowedContributions: Object.values(owner.manifest.publicSurface.shellContributions).flatMap((items) =>
          items.map(({ contributionKey }) => contributionKey),
        ),
        backend: {
          baseUrl,
          transport: 'node-http' as const,
        },
        contract: { ...entry.contract, sha256: hash },
        contractDocument,
        deployment: owner.deployment,
        federation:
          component === undefined
            ? { execution: 'server' as const }
            : {
                execution: 'browser' as const,
                exposes: components.map(({ expose }) => expose),
                manifest: {
                  sha256: digest(federationDocument),
                  url: new URL('__fixture__/mf-manifest.json', baseUrl).href,
                },
                remoteName: component.mfBoundaryId,
              },
        moduleId: owner.manifest.module.id,
        publicContract: { id: owner.manifest.module.id, sha256: hash, version: owner.schemaVersion },
      };
    }),
    { concurrency: 1 },
  );
  const composition = {
    ...base.composition,
    modules,
    shell: {
      ...base.composition.shell,
      deployment: shell,
      runtimeContract: { ...base.composition.shell.runtimeContract, sha256: digest(shellContract) },
    },
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
});

const resolvePublishedOwnerEntry = Effect.fn('RetainedAccount.resolvePublishedEntry')(
  function* resolvePublishedOwnerEntry(specifier: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entry = yield* Effect.try({
      catch: () => failed('published-owner-entry'),
      try: () => createRequire(new URL('../../package.json', import.meta.url)).resolve(specifier),
    });
    let ownerRoot = path.dirname(entry);
    while (!(yield* fs.exists(path.join(ownerRoot, 'package.json')))) {
      const parent = path.dirname(ownerRoot);
      if (parent === ownerRoot) {
        return yield* failed('published-owner-package');
      }
      ownerRoot = parent;
    }
    const owner = yield* fs
      .readFileString(path.join(ownerRoot, 'package.json'))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))));
    if (!specifier.startsWith(`${owner.name}/`)) {
      return yield* failed('published-owner-identity');
    }
    return { entry, ownerRoot };
  },
);
const bundleOwner = Effect.fn('RetainedAccount.bundleOwner')(function* bundleOwner(
  specifier: string,
  identity: OwnerBuildIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { entry, ownerRoot } = yield* resolvePublishedOwnerEntry(specifier);
  // Keep test artifacts owner-local and gitignored, while preserving the owner's external dependencies.
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.join(appRoot, 'verticals/privacy/node_modules'),
    prefix: '.retained-account-',
  });
  yield* fs.symlink(path.join(ownerRoot, 'node_modules'), path.join(directory, 'node_modules'));
  const artifact = path.join(directory, 'owner.mjs');
  const originalUrl = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(pathToFileURL(entry).href);
  yield* commandOutput([
    'pnpm',
    'exec',
    'esbuild',
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    ...(yield* ownerBuildDefines(identity)),
    `--define:import.meta.url=${originalUrl}`,
    `--outfile=${artifact}`,
  ]);
  return artifact;
});
const bundlePublishedWorker = Effect.fn('RetainedAccount.bundlePublishedWorker')(function* bundlePublishedWorker(
  identity: OwnerBuildIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const specifier = '@app/commerce-customer-context/outbox-worker-host';
  const { entry, ownerRoot } = yield* resolvePublishedOwnerEntry(specifier);
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.join(appRoot, 'verticals/privacy/node_modules'),
    prefix: '.retained-worker-',
  });
  yield* fs.symlink(path.join(ownerRoot, 'node_modules'), path.join(directory, 'node_modules'));
  const source = path.join(directory, 'worker.ts');
  const artifact = path.join(directory, 'worker.mjs');
  yield* fs.writeFileString(
    source,
    `import { startOutboxWorkerHost } from '@app/core-runtime/outbox/worker';
import { outboxWorkerEntry } from '@app/commerce-customer-context/outbox-worker-host';
startOutboxWorkerHost({ entries: [outboxWorkerEntry], health: true });
`,
  );
  yield* commandOutput([
    'pnpm',
    'exec',
    'esbuild',
    source,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    ...(yield* ownerBuildDefines(identity)),
    `--alias:${specifier}=${entry}`,
    `--outfile=${artifact}`,
  ]);
  return artifact;
});
const openRetainedPrivateChannel = Effect.fn('RetainedAccount.privateChannel')(function* openRetainedPrivateChannel() {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'p1261-' });
  yield* fs.chmod(temporary, 0o700);
  const directory = yield* fs.realPath(temporary);
  const socketPath = `${directory}/native.sock`;
  const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(
    Effect.mapError(() => failed('private-listener')),
  );
  const responses = yield* Queue.unbounded<string>();
  const writer = yield* Deferred.make<Socket.Writer>();
  const lost = yield* Deferred.make<never, RetainedAccountNativeError>();
  const closing = yield* Ref.make(false);
  const connected = yield* Ref.make(false);
  yield* server
    .run((socket) =>
      Effect.scoped(
        Effect.gen(function* privateOwnerConnection() {
          if (yield* Ref.getAndSet(connected, true)) {
            return yield* failed('private-duplicate-peer');
          }
          const pull = yield* Socket.readerBytes(socket);
          yield* Deferred.succeed(writer, yield* socket.writer);
          return yield* Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect((line) =>
              line.length <= 65_536 ? Effect.succeed(line) : Effect.fail(failed('private-frame-bound')),
            ),
            Stream.runForEach((line) => Queue.offer(responses, line)),
          );
        }),
      ).pipe(
        Effect.catchIf(
          (error) =>
            Socket.isSocketError(error) &&
            Schema.is(Socket.SocketCloseError)(error.reason) &&
            error.reason.code === 1000,
          (error) => Ref.get(closing).pipe(Effect.flatMap((expected) => (expected ? Effect.void : Effect.fail(error)))),
        ),
        Effect.catch(() => Deferred.fail(lost, failed('private-owner-eof'))),
      ),
    )
    .pipe(Effect.forkScoped);
  const beginClose = Ref.set(closing, true);
  yield* Effect.addFinalizer(() => beginClose.pipe(Effect.andThen(Queue.shutdown(responses))));
  return { beginClose, lost: Deferred.await(lost), responses, socketPath, writer: Deferred.await(writer) };
});

const startOwner = Effect.fn('RetainedAccount.startOwner')(function* startOwner(
  artifact: string,
  environment: Readonly<Record<string, string>>,
) {
  const channel = yield* openRetainedPrivateChannel();
  const transport = yield* Config.all({
    PATH: Config.String('PATH'),
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: {
      PATH: transport.PATH,
      SPICEDB_CA_CERT: transport.SPICEDB_CA_CERT,
      SPICEDB_ENDPOINT: transport.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(transport.SPICEDB_PRESHARED_KEY),
      ...environment,
      APP_ENV_PATH: '/dev/null',
      ONTOS_RETAINED_CONSENT_SOCKET: channel.socketPath,
      ONTOS_SHELL_NATIVE_SOCKET: channel.socketPath,
    },
    extendEnv: false,
    // Owner/worker runtimes may be waiting in graceful shutdown when the test fails.
    // Scope release must reap them before the infrastructure drops their database.
    forceKillAfter: '2 seconds',
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  yield* Effect.addFinalizer(() => channel.beginClose);
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const stopped = child.exitCode.pipe(Effect.andThen(Effect.fail(failed('private-owner-exited'))));
  const next = Effect.raceFirst(Queue.take(channel.responses), Effect.raceFirst(channel.lost, stopped));
  const send = Effect.fn('RetainedAccount.sendPrivate')(function* send(text: string) {
    const output = yield* Effect.raceFirst(channel.writer, Effect.raceFirst(channel.lost, stopped));
    return yield* output.write(text).pipe(Effect.mapError(() => failed('private-owner-write')));
  });
  return { child, next, send };
});
const firstLine = Effect.fn('RetainedAccount.firstLine')(function* firstLine(
  stream: Stream.Stream<Uint8Array, unknown>,
) {
  const line = yield* Stream.runHead(stream.pipe(Stream.decodeText(), Stream.splitLines)).pipe(
    Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.fail(failed('deadline')) }),
    Effect.mapError(() => failed('owner-readiness')),
  );
  if (Option.isNone(line)) {
    return yield* failed('owner-readiness');
  }
  return line.value;
});
const privateExchange = <A, I>(
  schema: Schema.Codec<A, I>,
  nativeClock: Clock.Clock,
  owner: Effect.Success<ReturnType<typeof startOwner>>,
  command: OwnerControlCommand,
) =>
  Effect.gen(function* exchange() {
    const encoded = yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))(command).pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ownerControlCommandSchema))),
      Effect.mapError(() => failed('private-owner-command')),
    );
    yield* owner.send(`${encoded}\n`);
    const text = yield* Effect.timeoutOrElse(owner.next, {
      duration: '20 seconds',
      orElse: () => Effect.fail(failed('deadline')),
    });
    const knownFailure = Schema.decodeUnknownResult(Schema.fromJsonString(commandFailureSchema), {
      onExcessProperty: 'error',
    })(text);
    if (Result.isSuccess(knownFailure)) {
      const matchesCommand = Match.value(command).pipe(
        Match.tag('enroll', () => knownFailure.success.command === 'enroll'),
        Match.tag('sign-out', () => knownFailure.success.command === 'sign-out'),
        Match.tag('observe-enrollment', () => knownFailure.success.command === 'observe-enrollment'),
        Match.tag('observe-party', () => knownFailure.success.command === 'observe-party'),
        Match.tag('observe-binding', () => knownFailure.success.command === 'observe-binding'),
        Match.tag('issue', () => false),
        Match.tag('bound', () => false),
        Match.tag('session-gateway', () => false),
        Match.exhaustive,
      );
      if (!matchesCommand) {
        return yield* failed('private-owner-failure-command');
      }
      return yield* failed(
        `owner-${knownFailure.success.command}-${knownFailure.success.operation}-${knownFailure.success.stage}${
          knownFailure.success.problemCode === undefined
            ? ''
            : `-${knownFailure.success.httpStatus ?? 'UNDECLARED_STATUS'}-${knownFailure.success.problemCode}`
        }`,
      );
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => failed('private-owner-reply')),
    );
  }).pipe(Effect.provideService(Clock.Clock, nativeClock));

const partyOwnerUnavailable = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'The actual native Party credential is unavailable',
  });
const noticeOwnerUnavailable = () =>
  new PrivacyNoticeAcknowledgementError({
    code: 'privacy_notice_acknowledgement_unavailable',
    reason: 'The actual native Notice subject credential is unavailable',
  });

/** Invoked same-owner test composition of real services, creator-owned runtime and durable replay. */
const startRetainedPrivacyHttp = Effect.fn('RetainedConsent.startActualPrivacyHttp')(function* startRetainedPrivacyHttp(
  runtime: Parameters<typeof makePrivacyApiRuntime>,
  account: RetainedConsentAccountTransport,
  managerPrincipalId: string,
  presentationConfiguration: PrivacyNoticePresentationConfiguration | undefined,
  configuration: ConfigProvider.ConfigProvider,
) {
  const acquire = retainedOwnerCredential(account, managerPrincipalId);
  const party = PrivacySubjectPartyOwnerLive.pipe(
    Layer.provide(
      Layer.succeed(PrivacySubjectPartyCredentials, {
        acquire: (scope) => acquire(scope, 'party-registry').pipe(Effect.mapError(partyOwnerUnavailable)),
      }),
    ),
  );
  const notice = CommerceCustomerContextNoticeSubjectAuthorityServiceLive((scope) =>
    acquire(scope, 'commerce-customer-context').pipe(Effect.mapError(noticeOwnerUnavailable)),
  ).pipe(Layer.provide(party));
  const presentation =
    presentationConfiguration === undefined
      ? PrivacyNoticePresentationUnavailableLive
      : makePrivacyNoticePresentationServiceLayer(presentationConfiguration);
  const channel = NoticeChannelDeliveryAuthorityForAcknowledgementsLive.pipe(
    Layer.provide(Layer.merge(presentation, notice)),
  );
  const withdrawal = CommerceCustomerContextConsentWithdrawalServiceLive((scope) =>
    acquire(scope, 'commerce-customer-context'),
  ).pipe(Layer.provide(party));
  const authority = Layer.effect(
    ConsentSelfServiceAuthority,
    CommerceCustomerContextConsentWithdrawalService.pipe(
      Effect.map((actual) => ({ forScope: actual.forScope, ports: consentSelfServiceAuthorityUnavailable.ports })),
    ),
  ).pipe(Layer.provide(withdrawal));
  const owners = Layer.mergeAll(party, notice, presentation, channel, authority).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.orDie,
  );
  const [read, action, replay] = runtime;
  const configured = makePrivacyApiRuntime(Layer.merge(read, owners), Layer.merge(action, owners), replay);
  const handler = yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: partyOwnerUnavailable,
      try: async () =>
        await createEffectBffTestHandler({
          module: {
            default: defineEffectBff({
              ...configured,
              layer: configured.layer.pipe(Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, configuration))),
            }),
          },
          prefix: privacyApiContract.apiPrefix,
        }),
    }),
    (value) => Effect.promise(value.dispose.bind(value)),
  );
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
    return yield* partyOwnerUnavailable();
  }
  yield* server.serve(
    Effect.gen(function* actualPrivacyRequest() {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      const response = yield* Effect.tryPromise({
        catch: partyOwnerUnavailable,
        try: async () => await handler.handler(request),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const origin = `http://127.0.0.1:${server.address.port}`;
  return { baseUrl: new URL(privacyApiContract.apiPrefix, origin).href, origin };
});

interface RetainedPublicArtifactSet {
  readonly accountArtifact: string;
  readonly accountDescription: typeof retainedAccountDescriptionSchema.Type;
  readonly contracts: Effect.Success<ReturnType<typeof describeContracts>>['contracts'];
  readonly partyArtifact: string;
  readonly shellArtifact: string;
  readonly shellHttpArtifact: string;
  readonly shellMarker: typeof OntosShellRuntimeContractSchema.fields.deployment.Type;
  readonly workerArtifact: string;
}
const RetainedPublicArtifacts = Context.Service<RetainedPublicArtifactSet>('RetainedPublicArtifacts');
const retainedAccountDescriptionSchema = Schema.Struct({
  marker: markerSchema,
  subscriptions: OntosModuleDeploymentContractSchema.fields.runtime.fields.outboxSubscriptions,
});
// Only immutable process artifacts/descriptions are prepared here. All isolated database,
// identity, account and business effects retain the test's independent 60-second budget.
const defaultNativeClock = Clock.Clock.defaultValue();
const retainedPublicArtifacts = Layer.effect(
  RetainedPublicArtifacts,
  Effect.gen(function* preparePublicArtifacts() {
    const { buildIdentities, contracts } = yield* describeContracts();
    const shellArtifact = yield* bundleOwner(
      '@app/shell-super-app/testing/api-key-gateway-native-child',
      buildIdentities['shell-super-app'],
    );
    const shellMarker = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OntosShellRuntimeContractSchema.fields.deployment),
    )(yield* commandOutput(['node', shellArtifact, '--describe']));
    const partyArtifact = yield* bundleOwner(
      '@app/party-registry/testing/tenant-party-http',
      buildIdentities['party-registry'],
    );
    const accountArtifact = yield* bundleOwner(
      '@app/commerce-customer-context/testing/privacy-consent-authority-owner',
      buildIdentities['commerce-customer-context'],
    );
    const accountDescription = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(retainedAccountDescriptionSchema),
    )(yield* commandOutput(['node', accountArtifact, '--describe']));
    const shellHttpArtifact = yield* bundleOwner(
      '@app/shell-super-app/testing/tenant-party-shell-http',
      buildIdentities['shell-super-app'],
    );
    const workerArtifact = yield* bundlePublishedWorker(buildIdentities['commerce-customer-context']);
    return {
      accountArtifact,
      accountDescription,
      contracts,
      partyArtifact,
      shellArtifact,
      shellHttpArtifact,
      shellMarker,
      workerArtifact,
    };
  }).pipe(Effect.provideService(Clock.Clock, defaultNativeClock)),
).pipe(Layer.provide(nativeServices));

interface PartyTransportEntry {
  readonly operation: 'GATEWAY' | 'MATCH' | 'CREATE';
  readonly state: 'STARTED' | 'RESPONSE';
  readonly status: number;
}
const recordPartyTransport = (
  reference: Ref.Ref<readonly PartyTransportEntry[]>,
  method: string,
  operation: PartyTransportEntry['operation'] | undefined,
  state: PartyTransportEntry['state'],
  status: number,
) =>
  method === 'POST' && operation !== undefined
    ? Ref.update(reference, (entries) => (entries.length < 24 ? [...entries, { operation, state, status }] : entries))
    : Effect.void;

const acquireRetainedInfrastructure = Effect.fn('RetainedAccount.acquireInfrastructure')(
  function* acquireRetainedInfrastructure() {
    const nativeClock = yield* Clock.Clock;
    const { accountArtifact, contracts, shellMarker } = yield* RetainedPublicArtifacts;
    const snapshot = yield* Ref.make(Option.none<typeof ActiveApplicationCompositionSnapshotSchema.Type>());
    const partyTransport = yield* Ref.make<readonly PartyTransportEntry[]>([]);
    const makeForwarder = Effect.fn('RetainedAccount.makeForwarder')(function* makeForwarder(
      compositionSource: boolean,
      ownerAppId?: (typeof ownerIds)[number],
    ) {
      const observedOwner = contracts.find((contract) => contract.deployment.appId === ownerAppId);
      const federationDocument = observedOwner === undefined ? undefined : yield* testFederationDocument(observedOwner);
      const target = yield* Ref.make(Option.none<string>());
      const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
      if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
        return yield* failed('routing-listener');
      }
      yield* server.serve(
        Effect.gen(function* routeActualOwner() {
          const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
          const url = new URL(request.url);
          if (
            federationDocument !== undefined &&
            request.method === 'GET' &&
            url.pathname === '/__fixture__/mf-manifest.json'
          ) {
            return HttpServerResponse.text(federationDocument, { contentType: 'application/json' });
          }
          if (compositionSource && url.pathname === '/composition') {
            const current = yield* Ref.get(snapshot);
            if (Option.isNone(current)) {
              return yield* failed('composition-not-ready');
            }
            return HttpServerResponse.text(
              yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
                current.value,
              ),
              { contentType: 'application/json' },
            );
          }
          const destination = yield* Ref.get(target);
          if (Option.isNone(destination)) {
            return yield* failed('owner-not-ready');
          }
          const forwarded = new Request(new URL(`${url.pathname}${url.search}`, destination.value), request);
          const partyContract = contracts.find((contract) => contract.deployment.appId === 'party-registry');
          const partyReleasePrefix =
            partyContract === undefined
              ? undefined
              : moduleReleaseApiBaseUrl('party-registry', partyContract.deployment.buildMarker);
          const operation = new Map<string, 'GATEWAY' | 'MATCH' | 'CREATE'>([
            [`${partyReleasePrefix}/reads/party-match`, 'MATCH'],
            [`${partyReleasePrefix}/party-registry/actions/create-party`, 'CREATE'],
            ['/auth/api-key/gateway-context', 'GATEWAY'],
            ['/shell-super-app-api/auth/api-key/gateway-context', 'GATEWAY'],
            ['/party-registry-api/reads/party-match', 'MATCH'],
            ['/party-registry-api/party-registry/actions/create-party', 'CREATE'],
          ]).get(url.pathname);
          yield* recordPartyTransport(partyTransport, request.method, operation, 'STARTED', 0);
          const response = yield* Effect.tryPromise({
            catch: () => failed('owner-forwarding'),
            try: () => fetch(forwarded),
          }).pipe(Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.fail(failed('deadline')) }));
          yield* recordPartyTransport(partyTransport, request.method, operation, 'RESPONSE', response.status);
          return HttpServerResponse.fromWeb(response);
        }).pipe(Effect.provideService(Clock.Clock, nativeClock)),
      );
      return { origin: `http://127.0.0.1:${server.address.port}`, target };
    });
    // Stable transport origins break the deployment configuration cycle before identity
    // or Composition exists. Only actual child handlers produce owner responses.
    const coreRoute = yield* makeForwarder(true);
    const commerceRoute = yield* makeForwarder(false, 'commerce-customer-context');
    const partyRoute = yield* makeForwarder(false, 'party-registry');
    const privacyRoute = yield* makeForwarder(false, 'privacy');
    const coreOrigin = coreRoute.origin;
    const initialSnapshot = yield* makeSnapshot(contracts, shellMarker, {
      'commerce-customer-context': commerceRoute.origin,
      'party-registry': partyRoute.origin,
      privacy: privacyRoute.origin,
    });
    yield* Ref.set(snapshot, Option.some(initialSnapshot));
    const { isolated, makeRedemption } = yield* makeDsrObligationNative(
      initialSnapshot,
      'stabilization-1261-retained-purpose-withdrawal',
    );
    const prepared = yield* ChildProcess.make(
      'mise',
      ['exec', '--', 'node', accountArtifact, '--prepare-owned-provider'],
      {
        cwd: appRoot,
        env: {
          APP_ENV_PATH: '/dev/null',
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          COMMERCE_PORTAL_AUTH_DATABASE_URL: isolated.connections.runtime.connectionString,
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
        },
        extendEnv: true,
        forceKillAfter: '2 seconds',
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [code, output] = yield* Effect.all(
      [
        prepared.exitCode,
        prepared.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        Stream.runDrain(prepared.stderr),
      ],
      { concurrency: 3 },
    );
    if (Number(code) !== 0) {
      return yield* failed('owned-provider-preparation');
    }
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('provider-prepared') })),
    )([...output].join(''));
    // The actual owned creator supplies physical identity, never a caller-invented capability.
    const identityServices = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const identityClient = Context.get(identityServices, PgClient.PgClient);
    const [identityCapability] = yield* identityClient
      .unsafe(
        'select current_database() as "databaseName", d.oid::text as "databaseOid", (pg_control_system()).system_identifier::text as "systemIdentifier" from pg_database d where d.datname=current_database()',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                databaseName: Schema.String,
                databaseOid: Schema.String,
                systemIdentifier: Schema.String,
              }),
            ]),
          ),
        ),
      );
    const nativeIdentityUrls = yield* prepareRetainedNativeIdentities(isolated.connections, identityCapability);
    return {
      commerceRoute,
      coreOrigin,
      coreRoute,
      initialSnapshot,
      isolated,
      makeRedemption,
      nativeIdentityUrls,
      partyRoute,
      partyTransport,
      privacyRoute,
    };
  },
);
type RetainedInfrastructureState = Effect.Success<ReturnType<typeof acquireRetainedInfrastructure>>;
const RetainedNativeInfrastructure = Context.Service<RetainedInfrastructureState>('RetainedNativeInfrastructure');
const retainedNativeInfrastructure = Layer.effect(
  RetainedNativeInfrastructure,
  acquireRetainedInfrastructure().pipe(Effect.provideService(Clock.Clock, defaultNativeClock)),
).pipe(Layer.provideMerge(retainedPublicArtifacts), Layer.provide(nativeServices));

const retainedPublicJourney = Effect.fn('RetainedAccount.publicJourney')(function* actualAccountPrerequisite(
  terminalMode: 'revoked' | 'owner-outage',
) {
  const nativeClock = yield* Clock.Clock;
  const {
    accountArtifact,
    accountDescription,
    contracts,
    partyArtifact,
    shellArtifact,
    shellHttpArtifact,
    shellMarker,
    workerArtifact,
  } = yield* RetainedPublicArtifacts;
  const {
    commerceRoute,
    coreOrigin,
    coreRoute,
    initialSnapshot,
    isolated,
    makeRedemption,
    nativeIdentityUrls,
    partyRoute,
    privacyRoute,
  } = yield* RetainedNativeInfrastructure;
  const pair = yield* Effect.tryPromise({
    catch: () => failed('gateway-key-generation'),
    try: () => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  });
  const publicKey = yield* Effect.tryPromise({
    catch: () => failed('gateway-public-key'),
    try: () => exportJWK(pair.publicKey),
  });
  const privateKey = yield* Effect.tryPromise({
    catch: () => failed('gateway-private-key'),
    try: () => exportJWK(pair.privateKey),
  });
  const suffix = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  const keyAttributes = { alg: 'EdDSA', kid: `retained-${suffix}`, use: 'sig' };
  const environment = {
    APP_ENV_PATH: '/dev/null',
    BETTER_AUTH_SECRET: `${suffix}${yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4())}`,
    // The Shell's MCP resource accepts only HTTPS or a loopback development origin.
    BETTER_AUTH_URL: 'http://localhost',
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${coreOrigin}/composition`,
    ONTOS_GATEWAY_ISSUER: 'https://retained-account.fixture.invalid',
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateKey, ...keyAttributes }),
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey, ...keyAttributes }] }),
  };
  // Existing bootstrap creator validates the admin/runtime pair; HTTP-only children receive no admin.
  const bootstrap = yield* startOwner(shellArtifact, {
    ...environment,
    DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
    SHELL_GATEWAY_ISSUER_DATABASE_URL: nativeIdentityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL,
  });
  const bootstrapReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(shellReadySchema))(
    yield* firstLine(bootstrap.child.stdout),
  );
  const businessActionKeys = [
    'commerce.customer-context.start-portal-enrollment',
    'commerce.customer-context.claim-portal-enrollment-transition',
    'commerce.customer-context.record-portal-enrollment-outcome',
    'commerce.customer-context.ensure-retail-customer-profile',
    'party.registry.create-party',
    'party.registry.resolve-duplicate-candidate-create',
    'privacy.core.create-privacy-subject',
    'privacy.core.create-processing-purpose',
    'privacy.core.create-notice-version',
    'privacy.core.add-processing-purpose-version',
    ...retainedConsentAccountActionKeys,
  ];
  const publishedActions = new Set(
    contracts.flatMap((contract) => contract.manifest.publicSurface.actions.map(({ actionKey }) => actionKey)),
  );
  if (businessActionKeys.some((key) => !publishedActions.has(key))) {
    return yield* failed('required-registered-action');
  }
  const actionKeys = [
    bindSelfApiKeyAction.descriptor.actionKey,
    activatePrincipalBindingAction.descriptor.actionKey,
    reservePrincipalBindingAction.descriptor.actionKey,
    ...businessActionKeys,
  ];
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys,
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context', 'party-registry', 'privacy'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: initialSnapshot.composition.revision,
      managerIdentityAdmin: true,
      managerProviderSubjectId: bootstrapReady.providerUserId,
      managerProvisioningNamespaces: [COMMERCE_AUTHENTICATION_NAMESPACE_ID],
      moduleAccess: 'configured-modules',
      moduleKeys: ['core.identity', 'commerce.customer-context', 'party.registry', 'privacy.core'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const coreEvidenceServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
  const context = yield* Layer.build(fixture.layer);
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    ...fixture.manager,
    legalEntityId: fixture.legalEntityId,
  });
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  for (const target of [
    { moduleId: 'party.registry', permission: 'manage_party_identity' },
    { moduleId: 'privacy.core', permission: 'privacy.processing_catalog.read' },
    { moduleId: 'privacy.core', permission: 'privacy.consent.read' },
  ]) {
    yield* Effect.addFinalizer(() =>
      permissions
        .mutate({
          legalEntityId: fixture.legalEntityId,
          operation: 'revoke',
          principal,
          target,
          tenantId: fixture.tenantId,
        })
        .pipe(Effect.orDie),
    );
    yield* permissions.mutate({
      legalEntityId: fixture.legalEntityId,
      operation: 'grant',
      principal,
      target,
      tenantId: fixture.tenantId,
    });
  }
  const issued = yield* privateExchange(
    shellReplySchema,
    nativeClock,
    bootstrap,
    yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({
      _tag: 'issue',
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    }),
  );
  if (!Schema.is(issuedReplySchema)(issued)) {
    return yield* failed('shell-service-key');
  }
  const action = Context.get(context, ActionRuntime);
  yield* action
    .runAction({
      payload: { providerSubjectId: issued.providerKeyId },
      principal,
      registration: bindSelfApiKeyAction,
      transport: { correlationId: `retained-bind:${suffix}`, idempotencyKey: `retained-bind:${suffix}` },
    })
    .pipe(Effect.provideContext(context));
  const bound = yield* privateExchange(shellReplySchema, nativeClock, bootstrap, { _tag: 'bound' });
  if (!Schema.is(ackReplySchema)(bound)) {
    return yield* failed('shell-key-binding');
  }
  const party = yield* startOwner(partyArtifact, {
    ...environment,
    PARTY_REGISTRY_DATABASE_URL: nativeIdentityUrls.PARTY_REGISTRY_DATABASE_URL,
  });
  const partyReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(
    yield* firstLine(party.child.stdout),
  );
  const workload = {
    tenantId: principal.tenantId,
    workloadAuthenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    workloadPrincipalId: principal.principalId,
  };
  const commerceEnvironment = {
    ...environment,
    COMMERCE_CORE_IDENTITY_API_KEY: Redacted.value(issued.secret),
    COMMERCE_CORE_IDENTITY_BASE_URL: `${coreOrigin}${shellGatewayContextContract.apiPrefix}`,
    COMMERCE_PORTAL_AUTH_DATABASE_URL: isolated.connections.runtime.connectionString,
    COMMERCE_PORTAL_AUTH_SECRET: `${suffix}${suffix}`,
    COMMERCE_PORTAL_AUTH_SECRETS: '',
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: '',
    COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES: '',
    COMMERCE_PORTAL_AUTH_URL: 'https://retained-portal.example.test',
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: Redacted.value(issued.secret),
    ONTOS_RETAINED_CONSENT_SERVER_SCOPE: JSON.stringify({
      compositionRevision: initialSnapshot.composition.revision,
      legalEntityId: fixture.legalEntityId,
      managerPrincipalId: fixture.manager.principalId,
      tenantId: fixture.tenantId,
    }),
    ONTOS_RETAINED_CONSENT_VERIFICATION_WORKLOAD_GRANTS: JSON.stringify({
      grants: [
        {
          ...workload,
          commerceAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          operation: 'commerce-portal-authentication.verify-external-authentication.v1',
          receivingAudience: 'commerce-customer-context',
        },
      ],
      providerEndpointAudience: 'commerce-customer-context',
    }),
    ONTOS_SHELL_GATEWAY_BASE_URL: `${coreOrigin}${shellGatewayContextContract.apiPrefix}`,
    RESEND_API_KEY: 're_isolated_transport_only',
    RESEND_API_URL: 'https://api.resend.com/emails',
    RESEND_FROM_EMAIL: 'consent@example.test',
  };

  const accountContract = contracts.find((contract) => contract.deployment.appId === 'commerce-customer-context');
  if (accountContract === undefined) {
    return yield* failed('ccc-contract');
  }
  expect(accountDescription.marker).toEqual(accountContract.deployment);
  expect(accountDescription.subscriptions).toEqual(accountContract.runtime.outboxSubscriptions);
  const account = yield* startOwner(accountArtifact, commerceEnvironment);
  const accountReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(accountReadySchema))(
    yield* firstLine(account.child.stdout),
  );
  const accountApiBaseUrl = new URL(commerceCustomerContextApiContract.apiPrefix, accountReady.baseUrl).href;
  const grants = [
    ...['reserve', 'activate', 'resolve', 'read'].map((operation) => ({
      ...workload,
      operation,
      receivingAudience: 'commerce-customer-context',
      targetAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    })),
    ...['commerce-customer-context', 'party-registry', 'privacy'].map((targetAudience) => ({
      ...workload,
      operation: 'gateway-context',
      receivingAudience: 'commerce-customer-context',
      targetAudience,
      targetAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    })),
  ];
  const shell = yield* startOwner(shellHttpArtifact, {
    ...environment,
    ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify({
      attesterPrincipalId: principal.principalId,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      grants,
      providerEndpointAudience: 'commerce-customer-context',
    }),
    SHELL_GATEWAY_ISSUER_DATABASE_URL: nativeIdentityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL,
  });
  const shellReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(
    yield* firstLine(shell.child.stdout),
  );
  const admitted = initialSnapshot;
  expect(shellReady.marker).toEqual(shellMarker);
  yield* Ref.set(coreRoute.target, Option.some(`http://127.0.0.1:${shellReady.port}`));
  yield* Ref.set(commerceRoute.target, Option.some(accountReady.baseUrl));
  yield* Ref.set(partyRoute.target, Option.some(`http://127.0.0.1:${partyReady.port}`));
  const worker = yield* startOwner(workerArtifact, commerceEnvironment);
  yield* Effect.forkScoped(Stream.runDrain(worker.child.stdout));
  const issueManagerSessionGateway = Effect.fn('RetainedAccount.managerSessionGateway')(function* managerSessionGateway(
    request: typeof GatewayContextRequestSchema.Encoded,
  ) {
    const response = yield* privateExchange(
      shellReplySchema,
      nativeClock,
      bootstrap,
      yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({ _tag: 'session-gateway', request }),
    );
    if (!Schema.is(ShellNativeSessionGatewayResponseSchema)(response)) {
      return yield* failed('manager-session-gateway');
    }
    return response.gateway;
  });
  const partyCredential = yield* issueManagerSessionGateway({
    audience: 'party-registry',
    compositionRevision: admitted.composition.revision,
    legalEntityId: fixture.legalEntityId,
  });
  const partyPayload = yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)({
    candidate: {
      displayName: `Retained Consent ${suffix}`,
      evidenceRefs: [],
      officialIdentifiers: [],
      partyType: 'PERSON',
      provenance: { method: 'DIRECT_ENTRY', source: 'stabilization-1261-native-account' },
      subjectEvidence: [
        {
          basis: 'DIRECT_INTERACTION',
          evidenceRef: `retained-account:${suffix}`,
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'PERSON',
          statement: 'The isolated account fixture represents this distinct consenting person',
          subjectKey: suffix,
        },
      ],
      validFrom: DateTime.formatIso(yield* DateTime.now),
    },
  });
  const actualParty = yield* createPartyWithAuthorization(partyPayload, `Bearer ${partyCredential.token}`, {
    baseUrl: `http://127.0.0.1:${partyReady.port}${partyRegistryApiContract.apiPrefix}`,
    compositionRevision: admitted.composition.revision,
    correlationId: `retained-party:${suffix}`,
    idempotencyKey: `retained-party:${suffix}`,
  });
  const actualPartyRef = yield* Effect.gen(function* resolveProducedPartyCandidate() {
    if (actualParty.outcome === 'CREATED') {
      return actualParty.partyRef;
    }
    // Do not invent an official identifier. Follow the owner's genuine identity review
    // for a no-identifier person, and never bind this new account to an existing match.
    expect(actualParty.outcome).toBe('AMBIGUOUS');
    if (actualParty.outcome !== 'AMBIGUOUS') {
      return yield* failed('new-account-party-matched-existing');
    }
    const detailCredential = yield* issueManagerSessionGateway({
      audience: 'party-registry',
      compositionRevision: admitted.composition.revision,
      legalEntityId: fixture.legalEntityId,
    });
    const detail = yield* executeDuplicateCandidateDetailWithAuthorization(
      { caseRef: actualParty.caseRef },
      `Bearer ${detailCredential.token}`,
      `retained-party-review-read:${suffix}`,
      {
        baseUrl: `http://127.0.0.1:${partyReady.port}${partyRegistryApiContract.apiPrefix}`,
        compositionRevision: admitted.composition.revision,
      },
    );
    expect(detail.caseRef).toEqual(actualParty.caseRef);
    expect(detail.lifecycleState).toBe('OPEN');
    expect(detail.candidateParties).toHaveLength(0);
    expect(detail.candidate.subjectEvidence).toEqual(partyPayload.candidate.subjectEvidence);
    expect(detail.candidate.partyType).toBe('PERSON');
    expect(detail.candidate.displayName).toEqual(partyPayload.candidate.displayName);
    const reviewCredential = yield* issueManagerSessionGateway({
      audience: 'party-registry',
      compositionRevision: admitted.composition.revision,
      legalEntityId: fixture.legalEntityId,
    });
    const reviewed = yield* resolveDuplicateCandidateCreateWithAuthorization(
      {
        caseRef: detail.caseRef,
        expectedRevision: detail.revision,
        reason:
          'The authorized fixture reviewer accepts the actual one-person attestation and empty match inventory for this distinct disposable consenting account',
      },
      `Bearer ${reviewCredential.token}`,
      {
        baseUrl: `http://127.0.0.1:${partyReady.port}${partyRegistryApiContract.apiPrefix}`,
        compositionRevision: admitted.composition.revision,
        correlationId: `retained-party-review:${suffix}`,
        idempotencyKey: `retained-party-review:${suffix}`,
      },
    );
    expect(reviewed.caseRef).toEqual(actualParty.caseRef);
    expect(reviewed.lifecycleState).toBe('RESOLVED');
    expect(reviewed.outcome).toBe('CREATE_NEW');
    if (reviewed.partyRef === null) {
      return yield* failed('new-account-party-review-no-party');
    }
    return reviewed.partyRef;
  });
  expect(actualPartyRef.tenantId).toBe(fixture.tenantId);
  yield* installRetainedManagerPartyRead(
    { legalEntityId: fixture.legalEntityId, principalId: principal.principalId, tenantId: fixture.tenantId },
    actualPartyRef,
  );
  // Enrollment's governed Actions are Tenant-only. The selling entity remains
  // an explicit journey input, rather than a selected Legal Entity on the caller.
  // Enrollment forbids selected LE; the actual session endpoint selects one, so retain
  // the genuine API-key tenant assertion for this exact declared tenant-only Action.
  const credential = yield* issueApiKeyGatewayContext(
    {
      audience: 'commerce-customer-context',
      compositionRevision: admitted.composition.revision,
    },
    {
      apiKey: issued.secret,
      baseUrl: `${coreOrigin}${shellGatewayContextContract.apiPrefix}`,
      requestCorrelation: `retained-enroll:${suffix}`,
    },
  );
  const enrolled = yield* privateExchange(
    accountReplySchema,
    nativeClock,
    account,
    yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({
      _tag: 'enroll',
      authorization: Redacted.make(`Bearer ${credential.token}`),
      partyRef: actualPartyRef.resourceId,
      sellingLegalEntityId: fixture.legalEntityId,
    }),
  );
  if (!Schema.is(enrolledReplySchema)(enrolled)) {
    return yield* failed('real-account-enrollment');
  }
  const accountStopped = yield* Ref.make(false);
  yield* Effect.addFinalizer(() =>
    Ref.get(accountStopped).pipe(
      Effect.flatMap((stopped) =>
        stopped
          ? Effect.void
          : privateExchange(accountReplySchema, nativeClock, account, { _tag: 'sign-out' }).pipe(
              Effect.asVoid,
              Effect.orDie,
            ),
      ),
    ),
  );
  expect(enrolled.attemptId).not.toBe('');
  expect(enrolled.providerSubjectId).not.toBe(bootstrapReady.providerUserId);
  const identityOptions = {
    apiKey: issued.secret,
    baseUrl: `${coreOrigin}${shellGatewayContextContract.apiPrefix}`,
    requestCorrelation: `retained-binding:${suffix}`,
  };
  const bindingInput = yield* Schema.decodeUnknownEffect(ReadPrincipalBindingPayloadSchema)({
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    lookup: 'subject',
    providerSubjectId: enrolled.providerSubjectId,
    subjectType: 'user',
  });
  // Provision this verified, signed-in account through the public Core identity API.
  // The provider proves the real session; no Attempt hash is presented as a session.
  const absentBinding = yield* readPrincipalBinding(bindingInput, identityOptions);
  expect(absentBinding.outcome).toBe('NOT_FOUND');
  const reservedBinding = yield* reservePrincipalBinding(
    yield* Schema.decodeUnknownEffect(ReservePrincipalBindingRequestSchema)({
      authenticationRef: enrolled.sessionRef,
      compositionRevision: admitted.composition.revision,
      reservation: {
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        providerSubjectId: enrolled.providerSubjectId,
        subjectType: 'user',
      },
    }).pipe(Effect.mapError(() => failed('public-core-reserve-input'))),
    { ...identityOptions, idempotencyKey: `retained-reserve:${suffix}` },
  ).pipe(
    Effect.tapError((failure) =>
      Effect.gen(function* observeProviderRefusal() {
        const detailCategories = new Map([
          ['The external identity service is temporarily unavailable', 'IDENTITY_DOMAIN_UNAVAILABLE'],
          ['The Action transaction did not complete successfully', 'ACTION_TRANSACTION_UNAVAILABLE'],
          ['The authorization service could not determine permission safely', 'ACTION_PERMISSION_UNAVAILABLE'],
          ['Unable to create or resolve the Action invocation', 'ACTION_INVOCATION_UNAVAILABLE'],
          ['Unable to lock the Action invocation', 'ACTION_INVOCATION_LOCK_UNAVAILABLE'],
          ['Unable to transition the Action invocation to running', 'ACTION_INVOCATION_START_UNAVAILABLE'],
          ['Unable to persist successful Action evidence', 'ACTION_SUCCESS_EVIDENCE_UNAVAILABLE'],
          ['Module state could not be checked safely', 'MODULE_STATE_UNAVAILABLE'],
          ['A required Action Policy could not be evaluated', 'ACTION_POLICY_UNAVAILABLE'],
          [
            'The receiving owner release is not approved by the active Application Composition',
            'RECEIVING_RELEASE_UNAPPROVED',
          ],
          ['The Action has no approved Application Composition authority', 'COMPOSITION_AUTHORITY_MISSING'],
          ['The approved Application Composition no longer admits owner writes', 'COMPOSITION_WRITES_UNAVAILABLE'],
          ['The Action invocation could not be marked rejected', 'ACTION_INVOCATION_REJECTION_UNAVAILABLE'],
          ['Unable to load the recorded Action rejection', 'ACTION_REJECTION_READ_UNAVAILABLE'],
          ['Unable to resolve the Action invocation commit state', 'ACTION_COMMIT_STATE_UNAVAILABLE'],
          ['The rejected Action invocation has no recorded rejection', 'ACTION_REJECTION_MISSING'],
          ['Unable to persist Action permission denial evidence', 'ACTION_DENIAL_EVIDENCE_UNAVAILABLE'],
          ['The denied Action invocation no longer exists', 'ACTION_DENIED_INVOCATION_MISSING'],
          ['Unable to persist the rejected Action invocation', 'ACTION_REJECTION_PERSISTENCE_UNAVAILABLE'],
        ]);
        const published = Schema.decodeUnknownResult(Schema.Union(externalIdentityProblems))(failure);
        if (Result.isSuccess(published)) {
          const localDiagnostics = yield* FileSystem.FileSystem;
          yield* localDiagnostics.writeFileString(
            `${appRoot}../.codex/1261-completion-20261022/core-reserve-local-problem.json`,
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Union(externalIdentityProblems)))(
              published.success,
            ),
            { mode: 0o600 },
          );
        }
        yield* Effect.logInfo(
          'Retained reserve failure category',
          Result.isSuccess(published)
            ? (detailCategories.get(published.success.detail) ?? 'OTHER_PUBLISHED_DETAIL')
            : 'UNPUBLISHED_FAILURE',
        );
        const evidence = yield* fixture.evidence(coreEvidenceExecutor);
        const invocations = evidence.invocations.filter(
          (row) =>
            row.actionKey === reservePrincipalBindingAction.descriptor.actionKey &&
            row.idempotencyKey === `retained-reserve:${suffix}`,
        );
        const invocationIds = new Set(invocations.map((row) => row.actionInvocationId));
        const knownAuditCodes = Schema.Literals([
          'action_executed',
          'spicedb_permission_denied',
          'action_transaction_failed',
          'identity_unavailable',
          'action_permission_check_failed',
        ]);
        yield* Effect.logInfo('Retained reserve invocation evidence', {
          audits: evidence.audits
            .filter((row) => row.actionInvocationId !== null && invocationIds.has(row.actionInvocationId))
            .map((row) => {
              const code = Schema.decodeUnknownResult(knownAuditCodes)(row.outcomeCode);
              return Result.isSuccess(code) ? code.success : 'OTHER_AUDIT_CODE';
            }),
          statuses: invocations.map((row) => row.status),
        });
        const snapshot = yield* privateExchange(
          accountReplySchema,
          nativeClock,
          account,
          yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({
            _tag: 'observe-enrollment',
            attemptId: enrolled.attemptId,
            authorization: Redacted.make(`Bearer ${credential.token}`),
          }),
        );
        if (Schema.is(enrollmentObservationSchema)(snapshot)) {
          yield* Effect.logInfo('Retained provider verification transport', snapshot.providerVerification);
        }
      }).pipe(Effect.catch(() => Effect.logInfo('Retained provider observation unavailable'))),
    ),
    Effect.mapError((error) =>
      failed(
        Schema.is(Schema.Union(externalIdentityProblems))(error)
          ? `public-core-reserve-${error._tag}`
          : 'public-core-reserve-UNEXPECTED',
      ),
    ),
  );
  expect(reservedBinding.outcome).toBe('RESERVED');
  expect(reservedBinding.bindingStatus).toBe('pending');
  const activatedBinding = yield* activatePrincipalBinding(
    {
      activation: { authBindingId: reservedBinding.authBindingId, expectedRevision: reservedBinding.bindingRevision },
      authenticationRef: enrolled.sessionRef,
      compositionRevision: admitted.composition.revision,
    },
    { ...identityOptions, idempotencyKey: `retained-activate:${suffix}` },
  ).pipe(
    Effect.mapError((error) =>
      failed(
        Schema.is(Schema.Union(externalIdentityProblems))(error)
          ? `public-core-activate-${error._tag}`
          : 'public-core-activate-UNEXPECTED',
      ),
    ),
  );
  expect(activatedBinding).toMatchObject({
    authBindingId: reservedBinding.authBindingId,
    bindingStatus: 'active',
    outcome: 'ACTIVATED',
    principalId: reservedBinding.principalId,
  });
  const activeBinding = yield* readPrincipalBinding(bindingInput, identityOptions);
  expect(activeBinding).toMatchObject({
    authBindingId: activatedBinding.authBindingId,
    bindingRevision: activatedBinding.bindingRevision,
    bindingStatus: 'active',
    outcome: 'FOUND',
    principalId: activatedBinding.principalId,
  });
  // The real verified account and ACTIVE Core binding are the account prerequisite.
  // The optional self-enrollment orchestration is a separate workflow: its actual Attempt
  // remains a correlation reference, never fabricated completion or authority evidence.
  const binding = yield* readPrincipalBinding(bindingInput, identityOptions);
  expect(binding.outcome).toBe('FOUND');
  if (binding.outcome !== 'FOUND') {
    return yield* failed('real-current-binding');
  }
  expect(binding).toMatchObject({
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    bindingStatus: 'active',
    principalStatus: 'active',
    tenantStatus: 'active',
  });
  expect(binding.principalId).not.toBe(principal.principalId);
  const accountTransport = yield* Schema.decodeUnknownEffect(RetainedConsentAccountTransportSchema)({
    authBindingId: binding.authBindingId,
    commerceOrigin: accountReady.baseUrl,
    compositionRevision: admitted.composition.revision,
    coreApiKey: issued.secret,
    coreOrigin,
    legalEntityId: fixture.legalEntityId,
    partyOrigin: `http://127.0.0.1:${partyReady.port}`,
    principalId: binding.principalId,
    providerSubjectId: enrolled.providerSubjectId,
    sessionRef: enrolled.sessionRef,
    tenantId: fixture.tenantId,
  });
  yield* installRetainedAccountEntrypoints(accountTransport, fixture.denied.principalId, actualPartyRef);
  const request = yield* Schema.decodeUnknownEffect(ExternalGatewayContextRequestSchema)({
    audience: 'commerce-customer-context',
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authenticationRef: enrolled.sessionRef,
    compositionRevision: admitted.composition.revision,
    legalEntityId: fixture.legalEntityId,
    providerSubjectId: enrolled.providerSubjectId,
    subjectType: 'user',
  });
  const retail = yield* issueExternalGatewayContext(request, identityOptions);
  expect(retail.token.length).toBeGreaterThan(0);
  expect(retail.compositionRevision).toBe(admitted.composition.revision);
  expect(retail.apiBaseUrl).toBe(
    moduleReleaseApiBaseUrl('commerce-customer-context', accountContract.deployment.buildMarker),
  );
  const sellingLegalEntityRef = {
    moduleId: 'core.identity' as const,
    resourceId: fixture.legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId: fixture.tenantId,
  };
  const actualSubject = { kind: 'RETAIL' as const, partyRef: actualPartyRef, sellingLegalEntityRef };
  const managerGateway = yield* issueManagerSessionGateway({
    audience: 'commerce-customer-context',
    compositionRevision: admitted.composition.revision,
    legalEntityId: fixture.legalEntityId,
  });
  const managerClient = yield* makeGovernedEffectBffClient(
    {
      api: commerceCustomerContextApi,
      credential: Redacted.make(`Bearer ${managerGateway.token}`),
      defaultApiPrefix: commerceCustomerContextApiContract.apiPrefix,
      idempotencyKey: `retained-profile:${suffix}`,
      requestCorrelation: `retained-profile:${suffix}`,
    },
    { baseUrl: accountApiBaseUrl, compositionRevision: admitted.composition.revision },
  );
  const existingProfile = yield* managerClient.ensureRetailCustomerProfileAction
    .execute({
      payload: {
        effectiveAt: DateTime.formatIso(yield* DateTime.now),
        subject: actualSubject,
        trigger: 'AUTHORIZED_ONBOARDING',
      },
    })
    .pipe(
      Effect.tapError(() =>
        privateExchange(accountReplySchema, nativeClock, account, { _tag: 'observe-party' }).pipe(
          Effect.tap((observation) =>
            Schema.is(serverPartyObservationSchema)(observation)
              ? Effect.logInfo('Retained actual server Party stage', observation)
              : Effect.void,
          ),
          Effect.catch(() => Effect.logInfo('Retained actual server Party observation unavailable')),
        ),
      ),
    );
  // The approved public onboarding Action produces the actual profile for the reviewed person.
  expect(existingProfile.outcome).toBe('PROFILE_CREATED');
  expect(existingProfile.state).toBe('ACTIVE');
  expect(existingProfile.profileRef.tenantId).toBe(fixture.tenantId);
  const freshRetailClient = Effect.fn('RetainedAccount.freshRetailClient')(function* freshRetailClient(
    idempotencyKey?: string,
  ) {
    const nextRequest = yield* Schema.decodeUnknownEffect(ExternalGatewayContextRequestSchema)({
      audience: 'commerce-customer-context',
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      authenticationRef: enrolled.sessionRef,
      compositionRevision: admitted.composition.revision,
      legalEntityId: fixture.legalEntityId,
      providerSubjectId: enrolled.providerSubjectId,
      subjectType: 'user',
    });
    const next = yield* issueExternalGatewayContext(nextRequest, {
      ...identityOptions,
      requestCorrelation: `retained-current:${yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4())}`,
    });
    const clientRequest = {
      api: commerceCustomerContextApi,
      credential: Redacted.make(`Bearer ${next.token}`),
      defaultApiPrefix: commerceCustomerContextApiContract.apiPrefix,
      requestCorrelation: `retained-current:${suffix}`,
    };
    if (idempotencyKey !== undefined) {
      Object.assign(clientRequest, { idempotencyKey });
    }
    return yield* makeGovernedEffectBffClient(clientRequest, {
      baseUrl: accountApiBaseUrl,
      compositionRevision: admitted.composition.revision,
    });
  });
  const ownBindingClient = yield* freshRetailClient(`retained-profile-bind:${suffix}`);
  const ownProfileBinding = yield* ownBindingClient.bindRetailPortalProfileAction.execute({
    payload: {
      effectiveAt: DateTime.formatIso(yield* DateTime.now),
      enrollmentEvidenceRef: String(enrolled.attemptId),
      expectedRevision: null,
      expectedState: null,
      principalRef: {
        moduleId: 'core.identity',
        resourceId: binding.principalId,
        resourceType: 'core.identity.principal',
        tenantId: fixture.tenantId,
      },
      profileRef: existingProfile.profileRef,
      reason: 'The verified consenting account binds its own real principal to the publicly reviewed person profile',
      sellingLegalEntityRef,
    },
  });
  expect(ownProfileBinding.outcome).toBe('BINDING_ACTIVATED');
  expect(ownProfileBinding.state).toBe('ACTIVE');
  expect(ownProfileBinding.authorizationOperation).toBe('grant');
  expect(ownProfileBinding.permissionMutations?.every((mutation) => mutation.staged)).toBe(true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observerCredential = yield* issueManagerSessionGateway({
      audience: 'commerce-customer-context',
      compositionRevision: admitted.composition.revision,
      legalEntityId: fixture.legalEntityId,
    });
    const observation = yield* privateExchange(
      accountReplySchema,
      nativeClock,
      account,
      yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({
        _tag: 'observe-binding',
        authorization: Redacted.make(`Bearer ${observerCredential.token}`),
        bindingId: ownProfileBinding.bindingRef.resourceId,
        principalId: binding.principalId,
        profileId: existingProfile.profileRef.resourceId,
      }),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(bindingObservationSchema)));
    if (
      observation.authorizationState === 'ACTIVE' &&
      observation.current &&
      observation.profileReadAllowed &&
      observation.manageAllowed
    ) {
      yield* Effect.logInfo('Retained initial binding permission state', observation);
      break;
    }
    if (attempt === 19) {
      yield* Effect.logInfo('Retained binding permissions did not become current', observation);
      return yield* failed('binding-authorization-not-current');
    }
    yield* Effect.sleep('250 millis').pipe(Effect.provideService(Clock.Clock, defaultNativeClock));
  }
  const observeActualAuthority = Effect.fn('RetainedAccount.observeActualAuthority')(
    function* observeActualAuthority() {
      const profileClient = yield* freshRetailClient();
      const profileResponse = yield* profileClient.customerProfileRead.execute({
        payload: {
          authorizationSubject: actualSubject,
          profileRef: { ...existingProfile.profileRef, kind: 'RETAIL' },
        },
      });
      const profile = yield* Match.value(profileResponse).pipe(
        Match.tagsExhaustive({
          PROFILE_AVAILABLE: (value) => Effect.succeed(value),
          PROFILE_RECONCILIATION_REQUIRED: () => Effect.fail(failed('actual-profile-unavailable')),
        }),
      );
      if (
        profile.profile.kind !== 'RETAIL' ||
        profile.profile.state !== 'ACTIVE' ||
        profile.unavailableSections.includes('PROFILE')
      ) {
        return yield* failed('actual-profile-unavailable');
      }
      expect(profile.profile.profileRef).toEqual(existingProfile.profileRef);
      expect(profile.profile.subject).toEqual(actualSubject);
      expect(profile.provenance.filter((row) => row.projection === 'PROFILE')).toMatchObject([
        {
          freshness: {
            revision: String(profile.profile.revision),
            sourceModuleId: 'commerce.customer-context',
            status: 'CURRENT',
          },
        },
      ]);
      const principalClient = yield* freshRetailClient();
      const principalResponse = yield* principalClient.retailPrincipalResolution.execute({
        payload: {
          profileRef: existingProfile.profileRef,
        },
      });
      const retailPrincipal = yield* Match.value(principalResponse).pipe(
        Match.tagsExhaustive({
          RETAIL_PRINCIPAL_BINDING_REVOKED: () => Effect.fail(failed('actual-retail-principal')),
          RETAIL_PRINCIPAL_BOUND: (value) => Effect.succeed(value),
          RETAIL_PRINCIPAL_NOT_BOUND: () => Effect.fail(failed('actual-retail-principal')),
          RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS: () => Effect.fail(failed('actual-retail-principal')),
        }),
      );
      expect(retailPrincipal.profileRef).toEqual(existingProfile.profileRef);
      const bindingClient = yield* freshRetailClient();
      const bindingResponse = yield* bindingClient.retailPortalProfileBindingRead.execute({
        payload: {
          bindingRef: retailPrincipal.bindingRef,
          profileRef: existingProfile.profileRef,
        },
      });
      const retailBinding = yield* Match.value(bindingResponse).pipe(
        Match.tagsExhaustive({
          BINDING_AVAILABLE: (value) => Effect.succeed(value),
          BINDING_RECONCILIATION_REQUIRED: () => Effect.fail(failed('actual-retail-binding-unavailable')),
        }),
      );
      if (
        retailBinding.completeness !== 'FULL' ||
        retailBinding.authorizationFreshness.status !== 'CURRENT' ||
        retailBinding.permissionsFreshness.status !== 'CURRENT'
      ) {
        return yield* failed('actual-retail-binding-unavailable');
      }
      expect(retailBinding.binding).toMatchObject({
        authorizationOperation: 'grant',
        authorizationState: 'ACTIVE',
        bindingRef: retailPrincipal.bindingRef,
        principalRef: {
          moduleId: 'core.identity',
          resourceId: binding.principalId,
          resourceType: 'core.identity.principal',
          tenantId: fixture.tenantId,
        },
        profileRef: existingProfile.profileRef,
        sellingLegalEntityRef,
        state: 'ACTIVE',
      });
      expect(retailBinding.authorizationFreshness.sourceModuleId).toBe('commerce.customer-context');
      expect(retailBinding.authorizationFreshness.revision).toBeDefined();
      expect(retailBinding.permissionsFreshness.sourceModuleId).toBe('core.identity');
      expect(retailBinding.provenance.filter((row) => row.projection === 'PROFILE')).toMatchObject([
        {
          freshness: {
            revision: String(retailBinding.binding.revision),
            sourceModuleId: 'commerce.customer-context',
            status: 'CURRENT',
          },
        },
      ]);
      expect(retailPrincipal.provenance.filter((row) => row.projection === 'PROFILE')).toMatchObject([
        {
          freshness: {
            revision: String(retailBinding.binding.revision),
            sourceModuleId: 'commerce.customer-context',
            status: 'CURRENT',
          },
        },
      ]);
      expect(retailBinding.grantedPermissions).toContain('retail.consent.manage');
      return { profile: profile.profile, retailBinding };
    },
  );
  const firstAuthority = yield* observeActualAuthority();
  const secondAuthority = yield* observeActualAuthority();
  expect(secondAuthority.profile).toEqual(firstAuthority.profile);
  expect(secondAuthority.retailBinding.binding).toEqual(firstAuthority.retailBinding.binding);
  expect(secondAuthority.retailBinding.authorizationFreshness.revision).toBe(
    firstAuthority.retailBinding.authorizationFreshness.revision,
  );
  const firstPermissions = new Set(firstAuthority.retailBinding.grantedPermissions);
  const secondPermissions = new Set(secondAuthority.retailBinding.grantedPermissions);
  expect(firstPermissions.size).toBe(firstAuthority.retailBinding.grantedPermissions.length);
  expect(secondPermissions.size).toBe(secondAuthority.retailBinding.grantedPermissions.length);
  expect(secondPermissions).toEqual(firstPermissions);
  const finalClient = yield* freshRetailClient();
  const finalDecision = yield* finalClient.retailAccessDecision.execute({
    payload: {
      profileRef: existingProfile.profileRef,
      requiredPermission: 'retail.consent.manage',
    },
  });
  expect(finalDecision.decision).toMatchObject({ allowed: true, outcome: 'ALLOWED' });
  expect(finalDecision.requiredPermission).toBe('retail.consent.manage');
  expect(finalDecision.profileRef).toEqual(existingProfile.profileRef);
  expect(finalDecision.bindingRef).toEqual(Option.some(secondAuthority.retailBinding.binding.bindingRef));
  expect(finalDecision.bindingState).toEqual(Option.some('ACTIVE'));
  expect(finalDecision.authorizationFreshness.status).toBe('CURRENT');
  expect(finalDecision.authorizationFreshness.sourceModuleId).toBe('commerce.customer-context');
  expect(finalDecision.provenance.filter((row) => row.projection === 'OWNING_CAPABILITY')).toMatchObject([
    { freshness: { sourceModuleId: 'core.identity', status: 'CURRENT' } },
  ]);
  expect(finalDecision.provenance.filter((row) => row.projection === 'RETAIL_BINDING')).toMatchObject([
    {
      freshness: {
        revision: secondAuthority.retailBinding.authorizationFreshness.revision,
        sourceModuleId: 'commerce.customer-context',
        status: 'CURRENT',
      },
    },
  ]);
  expect(finalDecision.authorizationFreshness.revision).toBe(
    secondAuthority.retailBinding.authorizationFreshness.revision,
  );
  const accountPartyCredential = yield* issueExternalGatewayContext(
    yield* Schema.decodeUnknownEffect(ExternalGatewayContextRequestSchema)({
      audience: 'party-registry',
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      authenticationRef: enrolled.sessionRef,
      compositionRevision: admitted.composition.revision,
      legalEntityId: fixture.legalEntityId,
      providerSubjectId: enrolled.providerSubjectId,
      subjectType: 'user',
    }),
    { ...identityOptions, requestCorrelation: `retained-account-party:${suffix}` },
  );
  yield* executePartyDetailWithAuthorization(
    { partyRef: actualPartyRef },
    `Bearer ${accountPartyCredential.token}`,
    `retained-account-party:${suffix}`,
    {
      baseUrl: `http://127.0.0.1:${partyReady.port}${partyRegistryApiContract.apiPrefix}`,
      compositionRevision: admitted.composition.revision,
    },
  );
  yield* Effect.logInfo('Retained account real Party read passed');
  yield* Effect.gen(function* actualRetainedPurposeLifecycle() {
    // Select only real runtime services. The fixture's STAFF-only registry must not override
    // the receiving owner's reviewed canonical Commerce+STAFF registry at invocation time.
    const readLayer = Layer.effect(ReadRuntime, ReadRuntime).pipe(
      Layer.provide(fixture.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.orDie,
    );
    const actionLayer = Layer.effect(ActionRuntime, ActionRuntime).pipe(
      Layer.provide(fixture.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.orDie,
    );
    const privacyRuntime: Parameters<typeof makePrivacyApiRuntime> = [readLayer, actionLayer, yield* makeRedemption()];
    const presentationConfiguration = {
      keyId: `retained-notice:${suffix}`,
      signingKey: Redacted.make(base64url.encode(yield* Crypto.Crypto.use((crypto) => crypto.randomBytes(32)))),
    };
    const privacyConfiguration = ConfigProvider.fromUnknown({
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${coreOrigin}/composition`,
      ONTOS_GATEWAY_ISSUER: environment.ONTOS_GATEWAY_ISSUER,
      ONTOS_GATEWAY_PUBLIC_JWKS: environment.ONTOS_GATEWAY_PUBLIC_JWKS,
    });
    const parentScope = yield* Effect.scope;
    const acquirePrivacyHandler = Effect.fn('RetainedAccount.acquirePrivacyHandler')(function* acquirePrivacyHandler(
      mode: 'configured' | 'unconfigured' = 'configured',
    ) {
      const scope = yield* Scope.fork(parentScope);
      const server = yield* startRetainedPrivacyHttp(
        privacyRuntime,
        accountTransport,
        principal.principalId,
        mode === 'configured' ? presentationConfiguration : undefined,
        privacyConfiguration,
      ).pipe(Effect.provideService(Scope.Scope, scope));
      return { scope, server };
    });
    let privacyLease = yield* acquirePrivacyHandler();
    let privacy = privacyLease.server;
    yield* Ref.set(privacyRoute.target, Option.some(privacy.origin));
    const privacyTransport = Effect.fn('RetainedAccount.freshPrivacyTransport')(function* privacyTransport(
      actor: 'account' | 'manager',
      key: string,
    ) {
      const issuedPrivacy =
        actor === 'manager'
          ? yield* issueManagerSessionGateway({
              audience: 'privacy',
              compositionRevision: admitted.composition.revision,
              legalEntityId: fixture.legalEntityId,
            })
          : yield* issueExternalGatewayContext(
              yield* Schema.decodeUnknownEffect(ExternalGatewayContextRequestSchema)({
                audience: 'privacy',
                authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
                authenticationRef: enrolled.sessionRef,
                compositionRevision: admitted.composition.revision,
                legalEntityId: fixture.legalEntityId,
                providerSubjectId: enrolled.providerSubjectId,
                subjectType: 'user',
              }),
              { ...identityOptions, requestCorrelation: key },
            );
      expect(issuedPrivacy.compositionRevision).toBe(admitted.composition.revision);
      return [
        `Bearer ${issuedPrivacy.token}`,
        key,
        { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision, idempotencyKey: key },
      ] as const;
    });
    const publicSubject = yield* executeCreatePrivacySubjectWithAuthorization(
      yield* Schema.decodeUnknownEffect(CreatePrivacySubjectPayloadSchema)({
        subject: { kind: 'DATA_SUBJECT', partyRef: actualPartyRef },
        subjectRef: {
          moduleId: 'privacy.core',
          resourceId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
          resourceType: 'privacy.core.privacy-subject',
          tenantId: fixture.tenantId,
        },
      }),
      ...(yield* privacyTransport('manager', `retained-subject:${suffix}`)),
    );
    expect(publicSubject.subject).toEqual({ kind: 'DATA_SUBJECT', partyRef: actualPartyRef });
    expect(publicSubject.ownerAdmission?.partyRef).toEqual(actualPartyRef);
    const scopeRef = `retained-consent:${suffix}`;
    const controllerRef = `controller:${suffix}`;
    const materialScope = {
      applicabilityKey: `applicability:${suffix}`,
      consentRequired: true,
      consentScopeKey: scopeRef,
      controllerRef,
      dataCategoryRefs: ['contact'],
      processingScopeRef: scopeRef,
      recipientRefs: [],
    };
    const purpose = yield* executeCreateProcessingPurposeWithAuthorization(
      yield* Schema.decodeUnknownEffect(CreateProcessingPurposePayloadSchema)({
        businessCode: `RETAINED_${suffix.replaceAll('-', '').toUpperCase()}`,
        effectiveFrom: DateTime.formatIso(yield* DateTime.now),
        governanceOwnerId: principal.principalId,
        materialScope,
        meaning: 'Original native V1 consent choice',
        requiredConsentDimensions: [],
      }),
      ...(yield* privacyTransport('manager', `retained-purpose:${suffix}`)),
    );
    const [version1] = purpose.versions;
    if (version1 === undefined) {
      return yield* failed('public-purpose-v1');
    }
    const notice = yield* executeCreateNoticeVersionWithAuthorization(
      yield* Schema.decodeUnknownEffect(CreateNoticeVersionPayloadSchema)({
        input: {
          applicableScope: {
            facts: [
              { dimension: 'PRIVACY_SUBJECT', value: publicSubject.subjectRef.resourceId },
              { dimension: 'CONTROLLER_SCOPE', value: controllerRef },
              { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
              { dimension: 'PROCESSING_PURPOSE_VERSION', value: version1.versionId },
            ],
            operation: 'CONSENT_DECISION',
            processingScopeRef: { scopeId: scopeRef, scopeType: 'privacy.processing-scope' },
          },
          contentIdentity: `retained-notice:${suffix}`,
          evidenceArtifactRef: null,
          language: 'en',
          wording: 'This exact original V1 Notice explains the native consent choice.',
        },
        noticeId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
      }),
      ...(yield* privacyTransport('manager', `retained-notice:${suffix}`)),
    );
    // Read-only owner oracles travel through the published creator fixture's scoped transaction.
    // They never fabricate an owner fact or read another deployment's private store.
    const noticeFacts = Effect.fn('RetainedAccount.noticeFacts')(function* noticeFacts() {
      return yield* fixture
        .prepareOwner(
          Effect.fn('RetainedAccount.readNoticeFacts')(function* readNoticeFacts(transaction, scope) {
            return yield* Effect.all(
              {
                acknowledgements: transaction
                  .select()
                  .from(noticeAcknowledgements)
                  .where(
                    and(
                      eq(noticeAcknowledgements.tenantId, scope.tenantId),
                      eq(noticeAcknowledgements.legalEntityId, fixture.legalEntityId),
                      eq(noticeAcknowledgements.privacySubjectId, publicSubject.subjectRef.resourceId),
                      eq(noticeAcknowledgements.noticeVersionId, notice.versionId),
                    ),
                  ),
                provisions: transaction
                  .select()
                  .from(noticeProvisions)
                  .where(
                    and(
                      eq(noticeProvisions.tenantId, scope.tenantId),
                      eq(noticeProvisions.legalEntityId, fixture.legalEntityId),
                      eq(noticeProvisions.privacySubjectRef, publicSubject.subjectRef.resourceId),
                      eq(noticeProvisions.noticeVersionRef, notice.versionId),
                    ),
                  ),
              },
              { concurrency: 2 },
            );
          }),
          'required',
        )
        .pipe(Effect.provideContext(context));
    });
    const evidenceFor = Effect.fn('RetainedAccount.invocationEvidence')(function* evidenceFor(correlation: string) {
      const facts = yield* fixture.evidence(coreEvidenceExecutor);
      const matches = facts.invocations.filter((row) => row.correlationId === correlation);
      expect(matches).toHaveLength(1);
      const [invocation] = matches;
      if (invocation === undefined) {
        return yield* failed('public-invocation-evidence');
      }
      expect(invocation.principalId).toBe(binding.principalId);
      expect(invocation.authMethod).toBe('session');
      expect(invocation.authBindingId).toBe(binding.authBindingId);
      return {
        accesses: facts.accesses.filter((row) => row.actionInvocationId === invocation.actionInvocationId),
        audits: facts.audits.filter((row) => row.actionInvocationId === invocation.actionInvocationId),
        invocation,
      };
    });
    const assertRolledBackEvidence = Effect.fn('RetainedAccount.assertRollbackEvidence')(
      function* assertRolledBackEvidence(correlation: string) {
        const facts = yield* evidenceFor(correlation);
        expect(facts.invocation.status).not.toBe('succeeded');
        expect(facts.audits.filter((row) => row.outcome === 'succeeded')).toHaveLength(0);
        expect(facts.accesses.filter((row) => row.outcome === 'allowed')).toHaveLength(0);
        return yield* Effect.void;
      },
    );
    const interaction = `retained-interaction:${suffix}`;
    const [presentationBearer, presentationCorrelation] = yield* privacyTransport(
      'account',
      `retained-presentation:${suffix}`,
    );
    const presentationClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(presentationBearer),
        defaultApiPrefix: '/privacy-api',
        requestCorrelation: presentationCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    const presentation = yield* presentationClient.noticePresentation.present({
      params: { noticeVersionId: notice.versionId },
      query: {
        businessInteractionRef: interaction,
        privacySubjectId: publicSubject.subjectRef.resourceId,
        retailProfileId: existingProfile.profileRef.resourceId,
      },
    });
    expect(presentation.notice).toEqual(notice);
    const assertNoticeEvidence = Effect.fn('RetainedAccount.assertNoticeEvidence')(function* assertNoticeEvidence(
      correlation: string,
      noticeAction: 'acknowledge-privacy-notice' | 'record-notice-provision',
      expectedReads: readonly (readonly [string, 'read' | 'list', number])[],
      expectedAudit: Readonly<Record<string, Schema.Json>>,
    ) {
      const facts = yield* evidenceFor(correlation);
      expect(facts.invocation.status).toBe('succeeded');
      expect(facts.invocation.actionKey).toBe(`privacy.core.${noticeAction}`);
      expect(facts.audits).toHaveLength(1);
      expect(facts.audits[0]).toMatchObject({
        authBindingId: binding.authBindingId,
        authMethod: 'session',
        eventType: 'action.executed',
        legalEntityId: fixture.legalEntityId,
        outcome: 'succeeded',
        principalId: binding.principalId,
        tenantId: fixture.tenantId,
      });
      expect(facts.audits[0]?.evidenceJson).toEqual({
        ...expectedAudit,
        actionKey: `privacy.core.${noticeAction}`,
        resultHash: expect.any(String),
      });
      // Counting retains duplicate observations, so losing either Subject read (or either
      // Provision by-id read) fails even when the other has the same query identity.
      const observedReads = facts.accesses.map((row) => {
        expect(row).toMatchObject({
          authBindingId: binding.authBindingId,
          authMethod: 'session',
          evidenceCaptureMode: 'metadata_only',
          evidencePayloadJson: null,
          evidencePolicyKey: `privacy.core.${noticeAction}.access.v1`,
          legalEntityId: fixture.legalEntityId,
          outcome: 'allowed',
          principalId: binding.principalId,
          redactionProfile: null,
          resultFingerprintHash: null,
          resultFingerprintSchema: null,
          servingModuleKey: 'privacy.core',
          tenantId: fixture.tenantId,
        });
        return JSON.stringify([row.queryHash, row.accessKind, row.resultCount]);
      });
      expect(countReads(observedReads)).toEqual(countReads(expectedReads.map((read) => JSON.stringify(read))));
      // Authentication references in dedicated trusted columns are expected; neither business
      // evidence payloads nor audit metadata may capture the receipt, text or session secrets.
      const capturedMetadata = JSON.stringify({
        access: facts.accesses.map((row) => row.evidencePayloadJson),
        audit: facts.audits.map((row) => row.evidenceJson),
      });
      expect(notice.wording).toBe('This exact original V1 Notice explains the native consent choice.');
      for (const confidential of [
        'This exact original V1 Notice explains the native consent choice.',
        Redacted.value(presentation.presentationReceipt),
        enrolled.sessionRef,
        enrolled.providerSubjectId,
        Redacted.value(issued.secret),
      ]) {
        expect(capturedMetadata).not.toContain(confidential);
      }
      return facts;
    });
    const subjectRead = ['privacy.subject.for-scope.v1', 'list', 1] as const;
    const noticeRead = ['privacy.notice-version.for-scope.v1', 'list', 1] as const;
    const noNoticeFacts = yield* noticeFacts();
    expect(noNoticeFacts.acknowledgements).toHaveLength(0);
    expect(noNoticeFacts.provisions).toHaveLength(0);
    const [malformedBearer, malformedCorrelation] = yield* privacyTransport(
      'account',
      `retained-malformed-presentation:${suffix}`,
    );
    const malformedUrl = new URL(`${privacy.baseUrl}/notices/${notice.versionId}/presentation`);
    malformedUrl.searchParams.set('businessInteractionRef', interaction);
    // Subject IDs are opaque strings; omit the required query field to test malformed transport.
    malformedUrl.searchParams.set('retailProfileId', existingProfile.profileRef.resourceId);
    const malformedResponse = yield* Effect.tryPromise({
      catch: () => failed('malformed-notice-transport'),
      try: () =>
        fetch(malformedUrl, {
          headers: {
            authorization: malformedBearer,
            'x-correlation-id': malformedCorrelation,
            'x-ontos-composition-revision': admitted.composition.revision,
          },
          method: 'GET',
        }),
    });
    expect(malformedResponse.status).toBe(400);
    yield* Effect.tryPromise({
      catch: () => failed('malformed-notice-body'),
      try: () => malformedResponse.arrayBuffer(),
    });
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);
    // An actual foreign-Tenant target is rejected before owner evidence can be minted.
    // This is malicious request input, never a claimed existing foreign owner fact.
    const [foreignBearer, foreignCorrelation] = yield* privacyTransport(
      'account',
      `retained-foreign-presentation:${suffix}`,
    );
    const foreignClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(foreignBearer),
        defaultApiPrefix: privacyApiContract.apiPrefix,
        requestCorrelation: foreignCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    const foreignTarget = yield* foreignClient.noticePresentation
      .execute({
        payload: {
          businessInteractionRef: interaction,
          noticeVersionId: notice.versionId,
          privacySubjectRef: {
            ...publicSubject.subjectRef,
            tenantId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
          },
          retailProfileId: existingProfile.profileRef.resourceId,
        },
      })
      .pipe(Effect.result);
    expect(Result.isFailure(foreignTarget)).toBe(true);
    if (!Result.isFailure(foreignTarget)) {
      return yield* failed('foreign-notice-target-succeeded');
    }
    yield* Schema.decodeUnknownEffect(NoticePresentationPolicyConflictProblemSchema)(foreignTarget.failure);
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);

    // Keep the genuine receipt header and claims, changing only the first signature
    // character so the actual receiving signature validation must fail.
    const receipt = Redacted.value(presentation.presentationReceipt);
    const signatureStart = receipt.lastIndexOf('.') + 1;
    expect(signatureStart).toBeGreaterThan(1);
    const tamperedReceipt = Redacted.make(
      `${receipt.slice(0, signatureStart)}${receipt[signatureStart] === 'A' ? 'B' : 'A'}${receipt.slice(signatureStart + 1)}`,
    );
    const tamperedAck = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      { acknowledged: true, presentationReceipt: tamperedReceipt },
      ...(yield* privacyTransport('account', `retained-tampered-ack:${suffix}`)),
    ).pipe(Effect.result);
    expect(Result.isFailure(tamperedAck)).toBe(true);
    if (!Result.isFailure(tamperedAck)) {
      return yield* failed('tampered-notice-receipt-succeeded');
    }
    const invalidReceipt = yield* Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionIneligibleProblemSchema)(
      tamperedAck.failure,
    );
    expect(invalidReceipt.code).toBe('privacy_notice_acknowledgement_invalid');
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);

    // The default production unavailable presentation service is a real absent-config
    // boundary, installed only on a second receiver while the healthy receiver stays live.
    const unconfigured = yield* acquirePrivacyHandler('unconfigured');
    const [unconfiguredBearer, unconfiguredCorrelation, unconfiguredOptions] = yield* privacyTransport(
      'account',
      `retained-unconfigured-ack:${suffix}`,
    );
    const unconfiguredFailure = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      { acknowledged: true, presentationReceipt: presentation.presentationReceipt },
      unconfiguredBearer,
      unconfiguredCorrelation,
      { ...unconfiguredOptions, baseUrl: unconfigured.server.baseUrl },
    ).pipe(
      Effect.flip,
      Effect.mapError(() => failed('unconfigured-notice-receiver-succeeded')),
      Effect.flatMap(Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionUnavailableProblemSchema)),
    );
    expect(unconfiguredFailure.code).toBe('privacy_notice_acknowledgement_unavailable');
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);
    const [unconfiguredGetBearer, unconfiguredGetCorrelation] = yield* privacyTransport(
      'account',
      `retained-unconfigured-get:${suffix}`,
    );
    const unconfiguredClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(unconfiguredGetBearer),
        defaultApiPrefix: privacyApiContract.apiPrefix,
        requestCorrelation: unconfiguredGetCorrelation,
      },
      { baseUrl: unconfigured.server.baseUrl, compositionRevision: admitted.composition.revision },
    );
    yield* unconfiguredClient.noticePresentation
      .present({
        params: { noticeVersionId: notice.versionId },
        query: {
          businessInteractionRef: interaction,
          privacySubjectId: publicSubject.subjectRef.resourceId,
          retailProfileId: existingProfile.profileRef.resourceId,
        },
      })
      .pipe(
        Effect.flip,
        Effect.mapError(() => failed('unconfigured-notice-get-succeeded')),
        Effect.flatMap(Schema.decodeUnknownEffect(NoticePresentationUnavailableProblemSchema)),
      );
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);
    yield* Scope.close(unconfigured.scope, Exit.void);

    fixture.faultNextTransaction('rollback');
    const failedAck = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      { acknowledged: true, presentationReceipt: presentation.presentationReceipt },
      ...(yield* privacyTransport('account', `retained-ack-rollback:${suffix}`)),
    ).pipe(Effect.result);
    expect(Result.isFailure(failedAck)).toBe(true);
    if (!Result.isFailure(failedAck)) {
      return yield* failed('ack-rollback-not-triggered');
    }
    const ackFailure = yield* Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionUnavailableProblemSchema)(
      failedAck.failure,
    );
    expect(ackFailure.code).toBe('action_transaction_failed');
    expect(yield* noticeFacts()).toEqual(noNoticeFacts);
    yield* assertRolledBackEvidence(`retained-ack-rollback:${suffix}`);
    const acknowledgementKey = `retained-ack:${suffix}`;
    const acknowledgementTransport = yield* privacyTransport('account', acknowledgementKey);
    const acknowledgementPayload = {
      acknowledged: true as const,
      presentationReceipt: presentation.presentationReceipt,
    };
    const acknowledgement = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      acknowledgementPayload,
      ...acknowledgementTransport,
    );
    expect(acknowledgement.noticeVersionId).toBe(notice.versionId);
    const acknowledgementAudit = {
      acknowledgementRef: acknowledgement.acknowledgementRef,
      noticeVersionId: acknowledgement.noticeVersionId,
    };
    const initialAckEvidence = yield* assertNoticeEvidence(
      `retained-ack:${suffix}`,
      'acknowledge-privacy-notice',
      [subjectRead, subjectRead, noticeRead],
      acknowledgementAudit,
    );
    const originalAcknowledgementFacts = yield* noticeFacts();
    // A fresh genuine assertion with the ORIGINAL command key must resolve Core's terminal
    // invocation rather than execute the owner handler or append any owner/audit/access fact.
    const replayTransport = yield* privacyTransport('account', acknowledgementKey);
    const committed = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      acknowledgementPayload,
      ...replayTransport,
    ).pipe(
      Effect.flip,
      Effect.mapError(() => failed('ack-terminal-replay-succeeded')),
      Effect.flatMap(Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionAlreadyCommittedProblemSchema)),
    );
    expect(committed).toMatchObject({
      code: 'action_already_committed',
      invocationId: initialAckEvidence.invocation.actionInvocationId,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
    });
    expect(yield* noticeFacts()).toEqual(originalAcknowledgementFacts);
    expect(yield* evidenceFor(acknowledgementKey)).toEqual(initialAckEvidence);

    // The original assertion was consumed by the first real request, independently of
    // command idempotency. Reusing it is an authentication failure, never a replay success.
    const consumedBearer = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      acknowledgementPayload,
      ...acknowledgementTransport,
    ).pipe(Effect.result);
    expect(Result.isFailure(consumedBearer)).toBe(true);
    if (!Result.isFailure(consumedBearer)) {
      return yield* failed('ack-consumed-bearer-succeeded');
    }
    yield* Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionAuthenticationProblemSchema)(
      consumedBearer.failure,
    );
    expect(yield* noticeFacts()).toEqual(originalAcknowledgementFacts);
    expect(yield* evidenceFor(acknowledgementKey)).toEqual(initialAckEvidence);

    const [changedBearer, changedCorrelation] = yield* privacyTransport(
      'account',
      `retained-changed-presentation:${suffix}`,
    );
    const changedPresentationClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(changedBearer),
        defaultApiPrefix: privacyApiContract.apiPrefix,
        requestCorrelation: changedCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    const changedPresentation = yield* changedPresentationClient.noticePresentation.present({
      params: { noticeVersionId: notice.versionId },
      query: {
        businessInteractionRef: `${interaction}:changed`,
        privacySubjectId: publicSubject.subjectRef.resourceId,
        retailProfileId: existingProfile.profileRef.resourceId,
      },
    });
    expect(
      Redacted.value(changedPresentation.presentationReceipt) === Redacted.value(presentation.presentationReceipt),
    ).toBe(false);
    const changedPayload = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      { acknowledged: true, presentationReceipt: changedPresentation.presentationReceipt },
      ...(yield* privacyTransport('account', acknowledgementKey)),
    ).pipe(Effect.result);
    expect(Result.isFailure(changedPayload)).toBe(true);
    if (!Result.isFailure(changedPayload)) {
      return yield* failed('ack-changed-command-succeeded');
    }
    const conflict = yield* Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionConflictProblemSchema)(
      changedPayload.failure,
    );
    expect(conflict.code).toBe('action_request_hash_conflict');
    expect(yield* noticeFacts()).toEqual(originalAcknowledgementFacts);
    expect(yield* evidenceFor(acknowledgementKey)).toEqual(initialAckEvidence);

    // Close the actual receiving HTTP server and all owner handler/service resources,
    // then build a fresh handler against the SAME owned native database and signing config.
    // This is a real handler/service reload, not an operating-system process restart.
    const previousOrigin = privacy.origin;
    yield* Scope.close(privacyLease.scope, Exit.void);
    const closedHandler = yield* Effect.tryPromise({
      catch: () => failed('closed-privacy-handler'),
      try: async () => await fetch(previousOrigin),
    }).pipe(Effect.result);
    expect(Result.isFailure(closedHandler)).toBe(true);
    privacyLease = yield* acquirePrivacyHandler();
    privacy = privacyLease.server;
    yield* Ref.set(privacyRoute.target, Option.some(privacy.origin));
    expect(yield* noticeFacts()).toEqual(originalAcknowledgementFacts);
    const retainedAcknowledgement = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      { acknowledged: true, presentationReceipt: presentation.presentationReceipt },
      ...(yield* privacyTransport('account', `retained-ack-retained:${suffix}`)),
    );
    expect(retainedAcknowledgement).toEqual(acknowledgement);
    const ackFacts = yield* noticeFacts();
    expect(ackFacts.acknowledgements).toHaveLength(1);
    expect(ackFacts.acknowledgements[0]?.acknowledgementId).toBe(acknowledgement.acknowledgementRef.resourceId);
    expect(ackFacts.acknowledgements[0]?.actorPrincipalId).toBe(binding.principalId);
    expect(ackFacts.acknowledgements[0]?.actionInvocationId).toBe(initialAckEvidence.invocation.actionInvocationId);
    yield* assertNoticeEvidence(
      `retained-ack-retained:${suffix}`,
      'acknowledge-privacy-notice',
      [subjectRead, subjectRead, noticeRead, ['privacy.notice-acknowledgement.by-presentation.v1', 'read', 1]],
      acknowledgementAudit,
    );
    const provisionPayload = {
      actionRef: null,
      anonymousContextRef: null,
      businessInteractionRef: interaction,
      channel: 'privacy.api.signed-in-acknowledgement.v1',
      claimRef: acknowledgement.acknowledgementRef.resourceId,
      controllerRef,
      noticeVersionRef: notice.versionId,
      privacySubjectRef: publicSubject.subjectRef.resourceId,
      processingPurposeRef: purpose.purposeRef.resourceId,
      processingScopeRef: scopeRef,
      providedLanguage: notice.language,
    };
    fixture.faultNextTransaction('rollback');
    const failedProvision = yield* executeRecordNoticeProvisionWithAuthorization(
      provisionPayload,
      ...(yield* privacyTransport('account', `retained-provision-rollback:${suffix}`)),
    ).pipe(Effect.result);
    expect(Result.isFailure(failedProvision)).toBe(true);
    if (!Result.isFailure(failedProvision)) {
      return yield* failed('provision-rollback-not-triggered');
    }
    const provisionFailure = yield* Schema.decodeUnknownEffect(RecordNoticeProvisionActionUnavailableProblemSchema)(
      failedProvision.failure,
    );
    expect(provisionFailure.code).toBe('action_transaction_failed');
    expect(yield* noticeFacts()).toEqual(ackFacts);
    yield* assertRolledBackEvidence(`retained-provision-rollback:${suffix}`);
    const provision = yield* executeRecordNoticeProvisionWithAuthorization(
      provisionPayload,
      ...(yield* privacyTransport('account', `retained-provision:${suffix}`)),
    );
    expect(provision.outcome).toBe('PROVEN_PROVISION');
    const provisionAudit = {
      noticeVersionRef: provision.noticeVersionRef,
      outcome: provision.outcome,
      providedLanguage: provision.providedLanguage,
      provisionId: provision.provisionId,
    };
    const initialProvisionEvidence = yield* assertNoticeEvidence(
      `retained-provision:${suffix}`,
      'record-notice-provision',
      [
        ['privacy.notice-acknowledgement.by-id.v1', 'read', 1],
        subjectRead,
        subjectRead,
        ['privacy.notice-provision.by-id.v1', 'read', 0],
        ['privacy.notice-provision.by-invocation.v1', 'read', 0],
        ['privacy.notice-provision.by-id.v1', 'read', 0],
      ],
      provisionAudit,
    );
    const retainedProvision = yield* executeRecordNoticeProvisionWithAuthorization(
      provisionPayload,
      ...(yield* privacyTransport('account', `retained-provision-retained:${suffix}`)),
    );
    expect(retainedProvision).toEqual(provision);
    const provisionFacts = yield* noticeFacts();
    expect(provisionFacts.provisions).toHaveLength(1);
    expect(provisionFacts.provisions[0]?.provisionId).toBe(provision.provisionId);
    expect(provisionFacts.provisions[0]?.actionInvocationId).toBe(
      initialProvisionEvidence.invocation.actionInvocationId,
    );
    yield* assertNoticeEvidence(
      `retained-provision-retained:${suffix}`,
      'record-notice-provision',
      [
        ['privacy.notice-acknowledgement.by-id.v1', 'read', 1],
        subjectRead,
        subjectRead,
        ['privacy.notice-provision.by-id.v1', 'read', 1],
        ['privacy.notice-provision.by-invocation.v1', 'read', 0],
        ['privacy.notice-provision.by-id.v1', 'read', 1],
      ],
      provisionAudit,
    );
    const originalScope = {
      controllerRef,
      materialDimensions: [],
      privacySubjectRef: publicSubject.subjectRef,
      processingPurposeRef: purpose.purposeRef,
      purposeMeaning: version1.meaning,
      purposeVersionRef: version1.versionId,
      scopeRef,
    };
    const grantPayload = yield* Schema.decodeUnknownEffect(RecordConsentDecisionPayloadSchema)({
      decision: {
        actorEvidence: null,
        decision: 'GRANTED',
        decisionId: `retained-grant:${suffix}`,
        effectiveAt: DateTime.formatIso(yield* DateTime.now),
        flowEvidenceRefs: [],
        noticeEvidenceRefs: [provision.provisionId],
        provenanceRefs: [interaction, provision.provisionId],
        recordedAt: DateTime.formatIso(yield* DateTime.now),
        scope: originalScope,
      },
    });
    const grant = yield* executeRecordConsentDecisionWithAuthorization(
      grantPayload,
      ...(yield* privacyTransport('account', `retained-grant:${suffix}`)),
    );
    expect(grant.decision).toBe('GRANTED');
    expect(grant.scope).toEqual(originalScope);
    expect(grant.actorEvidence).toMatchObject({
      actor: { principalId: binding.principalId, tenantId: fixture.tenantId },
      authMethod: 'session',
      impersonatedBy: null,
    });
    const storedVersions = Effect.fn('RetainedAccount.originalVersionRows')(function* storedVersions() {
      return yield* fixture
        .prepareOwner(
          (transaction) =>
            transaction
              .select()
              .from(purposeVersions)
              .where(
                and(
                  eq(purposeVersions.tenantId, fixture.tenantId),
                  eq(purposeVersions.legalEntityId, fixture.legalEntityId),
                  eq(purposeVersions.processingPurposeId, purpose.purposeRef.resourceId),
                ),
              ),
          'required',
        )
        .pipe(Effect.provideContext(context));
    });
    const originalVersionRows = yield* storedVersions();
    expect(originalVersionRows).toHaveLength(1);
    const version2At = DateTime.formatIso(yield* DateTime.now);
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(version2At))).toBeGreaterThan(
      DateTime.toEpochMillis(DateTime.makeUnsafe(grant.effectiveAt)),
    );
    const appended = yield* executeAddProcessingPurposeVersionWithAuthorization(
      yield* Schema.decodeUnknownEffect(AddProcessingPurposeVersionPayloadSchema)({
        purposeRef: purpose.purposeRef,
        version: {
          effectiveFrom: version2At,
          materialChange: {
            affectedPrivacySubjectRefs: [publicSubject.subjectRef.resourceId],
            changedAt: version2At,
            changeRef: `retained-change:${suffix}`,
          },
          materialScope,
          meaning: 'Current V2 must not inherit original V1 consent',
          requiredConsentDimensions: [],
        },
      }),
      ...(yield* privacyTransport('manager', `retained-append:${suffix}`)),
    );
    expect(appended.versions).toHaveLength(2);
    expect(appended.versions[0]).toMatchObject({
      effectiveTo: version2At,
      meaning: version1.meaning,
      versionId: version1.versionId,
    });
    const afterVersionRows = yield* storedVersions();
    expect(afterVersionRows).toHaveLength(2);
    expect(afterVersionRows.filter((row) => row.purposeVersionId === version1.versionId)).toEqual(originalVersionRows);
    const endedGrant = yield* executeRecordConsentDecisionWithAuthorization(
      {
        ...grantPayload,
        decision: {
          ...grantPayload.decision,
          decisionId: `retained-ended-grant:${suffix}`,
          effectiveAt: DateTime.formatIso(yield* DateTime.now),
          recordedAt: DateTime.formatIso(yield* DateTime.now),
        },
      },
      ...(yield* privacyTransport('account', `retained-ended-grant:${suffix}`)),
    ).pipe(Effect.result);
    expect(Result.isFailure(endedGrant)).toBe(true);
    if (!Result.isFailure(endedGrant)) {
      return yield* failed('ended-v1-grant-was-accepted');
    }
    const endedProblem = yield* Schema.decodeUnknownEffect(RecordConsentDecisionActionIneligibleProblemSchema)(
      endedGrant.failure,
    );
    expect(endedProblem.code).toBe('privacy_action_rejected');
    const withdrawal = yield* executeConsentSelfServiceWithAuthorization(
      yield* Schema.decodeUnknownEffect(ConsentSelfServicePayloadSchema)({
        decision: 'WITHDRAWN',
        noticeEvidenceRefs: [provision.provisionId],
        path: {
          kind: 'CURRENT_PROFILE_BINDING',
          operation: 'CONSENT_WITHDRAW',
          operationRef: `retained-withdraw:${suffix}`,
          profileRef: existingProfile.profileRef.resourceId,
          requestRef: `retained-withdraw:${suffix}`,
          scopeRef,
          subjectRef: publicSubject.subjectRef,
        },
        scope: originalScope,
      }),
      ...(yield* privacyTransport('account', `retained-withdraw:${suffix}`)),
    );
    expect(withdrawal.authorization).toMatchObject({
      actorPrincipalRef: { principalId: binding.principalId, tenantId: fixture.tenantId },
      allowed: true,
      authority: 'RETAIL_PROFILE_CONSENT',
      outcome: 'ALLOWED_PROFILE',
    });
    expect(withdrawal.decision.decision).toBe('WITHDRAWN');
    expect(withdrawal.decision.scope).toEqual(grant.scope);
    expect(withdrawal.decision.actorEvidence).toMatchObject({
      actor: { principalId: binding.principalId, tenantId: fixture.tenantId },
      authMethod: 'session',
      impersonatedBy: null,
    });
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(withdrawal.decision.effectiveAt))).toBeGreaterThanOrEqual(
      DateTime.toEpochMillis(DateTime.makeUnsafe(version2At)),
    );
    const [consentBearer, consentCorrelation] = yield* privacyTransport('manager', `retained-current:${suffix}`);
    const consentClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(consentBearer),
        defaultApiPrefix: '/privacy-api',
        requestCorrelation: consentCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    const currentConsent = yield* consentClient.currentConsent.execute({
      payload: { scopeRefs: [scopeRef] },
    });
    expect(currentConsent.items).toHaveLength(1);
    expect(currentConsent.items[0]?.resolution).toEqual({
      decision: withdrawal.decision,
      outcome: 'CURRENT',
    });
    const [purposeBearer, purposeCorrelation] = yield* privacyTransport(
      'manager',
      `retained-purpose-current:${suffix}`,
    );
    const purposeClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(purposeBearer),
        defaultApiPrefix: '/privacy-api',
        requestCorrelation: purposeCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    const currentPurpose = yield* purposeClient.processingPurposes.execute({
      payload: {
        at: DateTime.formatIso(yield* DateTime.now),
        includeRetired: false,
        purposeRefs: [purpose.purposeRef],
      },
    });
    expect(currentPurpose.items).toHaveLength(1);
    expect(currentPurpose.items[0]?.effectiveVersion?.versionNumber).toBe(2);
    const historyRows = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction
            .select()
            .from(consentDecisions)
            .where(
              and(
                eq(consentDecisions.tenantId, fixture.tenantId),
                eq(consentDecisions.legalEntityId, fixture.legalEntityId),
                eq(consentDecisions.scopeRef, scopeRef),
              ),
            ),
        'required',
      )
      .pipe(Effect.provideContext(context));
    const history = yield* Effect.forEach((row: typeof consentDecisions.$inferSelect) =>
      Schema.decodeUnknownEffect(ConsentDecisionSchema)(row.decisionRecord),
    )(historyRows);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([grant, withdrawal.decision]));
    expect(yield* noticeFacts()).toEqual(provisionFacts);
    // Preserve the original final healthy Current proof BEFORE terminal negative controls.
    const healthyAuthority = yield* observeActualAuthority();
    if (terminalMode === 'owner-outage') {
      // Acquire a genuine receiving assertion while the dependency is healthy, then stop
      // the actually owned CCC process. No synthetic owner response or service replacement.
      const outageTransport = yield* privacyTransport('account', `retained-owner-outage:${suffix}`);
      yield* Ref.set(accountStopped, true);
      yield* account.child.kill({ forceKillAfter: '2 seconds' });
      expect(yield* account.child.isRunning).toBe(false);
      const outage = yield* executeAcknowledgePrivacyNoticeWithAuthorization(
        acknowledgementPayload,
        ...outageTransport,
      ).pipe(
        Effect.flip,
        Effect.mapError(() => failed('owner-outage-ack-succeeded')),
        Effect.flatMap(Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionUnavailableProblemSchema)),
      );
      expect(outage.code).toBe('privacy_notice_acknowledgement_unavailable');
      expect(yield* noticeFacts()).toEqual(provisionFacts);
      return yield* Effect.void;
    }
    const revokeClient = yield* freshRetailClient(`retained-revoke-profile:${suffix}`);
    const revoked = yield* revokeClient.revokeRetailPortalProfileBindingAction.execute({
      payload: {
        effectiveAt: DateTime.formatIso(yield* DateTime.now),
        enrollmentEvidenceRef: String(enrolled.attemptId),
        expectedRevision: healthyAuthority.retailBinding.binding.revision,
        expectedState: 'ACTIVE',
        principalRef: {
          moduleId: 'core.identity',
          resourceId: binding.principalId,
          resourceType: 'core.identity.principal',
          tenantId: fixture.tenantId,
        },
        profileRef: existingProfile.profileRef,
        reason: 'The actual consenting account revokes its own binding for the terminal authority-denial control',
        sellingLegalEntityRef,
      },
    });
    expect(revoked.outcome).toBe('BINDING_REVOKED');
    expect(revoked.state).toBe('REVOKED');
    expect(revoked.authorizationOperation).toBe('revoke');
    expect(revoked.permissionMutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'revoke', permission: 'retail.consent.manage', staged: true }),
      ]),
    );
    const observedRevocation = yield* Effect.gen(function* awaitRevokedBindingPermissions() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const observerCredential = yield* issueManagerSessionGateway({
          audience: 'commerce-customer-context',
          compositionRevision: admitted.composition.revision,
          legalEntityId: fixture.legalEntityId,
        });
        const observation = yield* privateExchange(
          accountReplySchema,
          nativeClock,
          account,
          yield* Schema.decodeUnknownEffect(Schema.toType(ownerControlCommandSchema))({
            _tag: 'observe-binding',
            authorization: Redacted.make(`Bearer ${observerCredential.token}`),
            bindingId: revoked.bindingRef.resourceId,
            principalId: binding.principalId,
            profileId: existingProfile.profileRef.resourceId,
          }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(bindingObservationSchema)));
        if (observation.authorizationState === 'REVOKED' && observation.current && !observation.manageAllowed) {
          return observation;
        }
        yield* Effect.sleep('250 millis').pipe(Effect.provideService(Clock.Clock, defaultNativeClock));
      }
      return yield* failed('revoked-binding-authorization-not-current');
    });
    expect(observedRevocation.bindingState).toBe('REVOKED');
    expect(observedRevocation.authorizationState).toBe('REVOKED');
    expect(observedRevocation.current).toBe(true);
    expect(observedRevocation.manageAllowed).toBe(false);
    expect(observedRevocation.revision).toBeGreaterThanOrEqual(revoked.revision);

    const [deniedBearer, deniedCorrelation] = yield* privacyTransport(
      'account',
      `retained-revoked-presentation:${suffix}`,
    );
    const deniedClient = yield* makeGovernedEffectBffClient(
      {
        api: privacyApi,
        credential: Redacted.make(deniedBearer),
        defaultApiPrefix: privacyApiContract.apiPrefix,
        requestCorrelation: deniedCorrelation,
      },
      { baseUrl: privacy.baseUrl, compositionRevision: admitted.composition.revision },
    );
    yield* deniedClient.noticePresentation
      .present({
        params: { noticeVersionId: notice.versionId },
        query: {
          businessInteractionRef: interaction,
          privacySubjectId: publicSubject.subjectRef.resourceId,
          retailProfileId: existingProfile.profileRef.resourceId,
        },
      })
      .pipe(
        Effect.flip,
        Effect.mapError(() => failed('revoked-notice-presentation-succeeded')),
        Effect.flatMap(Schema.decodeUnknownEffect(NoticePresentationUnavailableProblemSchema)),
      );
    yield* executeAcknowledgePrivacyNoticeWithAuthorization(
      acknowledgementPayload,
      ...(yield* privacyTransport('account', `retained-revoked-ack:${suffix}`)),
    ).pipe(
      Effect.flip,
      Effect.mapError(() => failed('revoked-notice-ack-succeeded')),
      Effect.flatMap(Schema.decodeUnknownEffect(AcknowledgePrivacyNoticeActionUnavailableProblemSchema)),
    );
    expect(yield* noticeFacts()).toEqual(provisionFacts);

    return yield* Effect.void;
  });
  return yield* Effect.void;
});

it.layer(retainedNativeInfrastructure, { excludeTestServices: true, timeout: '60 seconds' })(
  'retained Purpose public owner processes',
  (suite) => {
    suite.effect(
      'reaps a SIGTERM-resistant owner and its open transaction when the caller fails',
      () =>
        Effect.scoped(
          Effect.gen(function* failedOwnerCleanup() {
            const { isolated } = yield* RetainedNativeInfrastructure;
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: `${appRoot}/verticals/privacy/node_modules`,
              prefix: '.retained-cleanup-',
            });
            const artifact = `${directory}/owner.mjs`;
            // Only the infrastructure's disposable database is reachable by this child.
            // Model a runtime stuck in graceful shutdown with a real open transaction.
            yield* fs.writeFileString(
              artifact,
              `import { Client } from 'pg';
process.on('SIGTERM', () => {});
// Safety net for a broken fixture: never strand this TEST session indefinitely.
setTimeout(() => process.exit(99), 15_000).unref();
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('begin');
await client.query('lock table privacy.consent_decisions in access exclusive mode');
const { rows } = await client.query('select pg_backend_pid() as pid');
process.stdout.write(JSON.stringify(rows[0].pid) + '\\n');
`,
            );
            const ownerScope = yield* Scope.make();
            yield* Effect.addFinalizer((exit) => Scope.close(ownerScope, exit));
            const owner = yield* startOwner(artifact, {
              DATABASE_URL: isolated.connections.admin.connectionString,
            }).pipe(Scope.provide(ownerScope));
            const backendPid = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Int))(
              yield* firstLine(owner.child.stdout),
            );
            const services = yield* Layer.build(
              PgClient.layer({
                maxConnections: 1,
                url: Redacted.make(isolated.connections.admin.connectionString),
              }).pipe(Layer.provideMerge(Reactivity.layer)),
            );
            const client = Context.get(services, PgClient.PgClient);
            expect(
              yield* client`select pid from pg_stat_activity where pid = ${backendPid} and state = 'idle in transaction'`,
            ).toHaveLength(1);
            const failure = failed('intentional-owner-cleanup-failure');
            const result = yield* Effect.fail(failure).pipe(
              Effect.onExit((exit) => Scope.close(ownerScope, exit)),
              Effect.exit,
            );
            expect(result).toEqual(Exit.fail(failure));
            expect(yield* owner.child.isRunning).toBe(false);
            // SIGKILL is required; reaching the child's safety exit is not successful teardown.
            expect(Exit.isFailure(yield* owner.child.exitCode.pipe(Effect.exit))).toBe(true);
            expect(yield* client`select pid from pg_stat_activity where pid = ${backendPid}`).toEqual([]);
            expect(yield* client`select pid from pg_locks where pid = ${backendPid}`).toEqual([]);
          }),
        ).pipe(Effect.provide(nativeServices)),
      30_000,
    );
    suite.effect(
      'serves and acknowledges the exact Notice, grants V1, appends V2 and withdraws retained V1 through a real Commerce account',
      () => retainedPublicJourney('revoked').pipe(Effect.scoped, Effect.provide(nativeServices)),
      60_000,
    );
    suite.effect(
      'preserves the genuine retained V1 lifecycle then refuses acknowledgement when the real Commerce owner process stops',
      () => retainedPublicJourney('owner-outage').pipe(Effect.scoped, Effect.provide(nativeServices)),
      60_000,
    );
  },
);
