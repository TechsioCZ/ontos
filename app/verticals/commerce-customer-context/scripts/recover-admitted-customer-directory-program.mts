import { PartyRefSchema } from '@app/party-registry/resources/party';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Clock, Context, DateTime, Duration, Effect, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { SellingLegalEntityRefSchema } from '../shared/domain/profile-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../shared/enrollment-contracts.ts';
import type {
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  RetailEnrollmentRegistration,
} from '../shared/enrollment-contracts.ts';
import { retailCustomerDirectoryOwnerEffect } from '../src/enrollment/journeys/retail-self-enrollment-customer-owner.ts';
import type { RetailCustomerDirectoryOwnerInput } from '../src/enrollment/journeys/retail-self-enrollment-customer-owner.ts';
import {
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
  retailSelfEnrollmentRequestDigest,
} from '../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { ownerUnavailable } from '../src/enrollment/orchestration/owner-effect-codec.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerReconciliationInput,
} from '../src/enrollment/orchestration/owner-transition-driver.ts';
import { RecoverySourceRevisionSchema } from './recover-admitted-retail-profile-program.mts';
import type { RecoveryModeSchema } from './recover-admitted-retail-profile-program.mts';

/**
 * Operator recovery of one admitted `party.customer.enroll` operation. The operator names only the
 * durable work identity; check reads every other fact from the native journal and binds them into
 * the approval digest, so reconcile acts on exactly the revisions the operator reviewed.
 */
export const DirectoryRecoveryRequestSchema = Schema.Struct({
  attemptId: EnrollmentAttemptIdSchema,
  compositionRevision: EnrollmentDigestSchema,
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  tenantId: EnrollmentTenantIdSchema,
});
export type DirectoryRecoveryRequest = typeof DirectoryRecoveryRequestSchema.Type;

const CONFIGURATION_INVALID = 'configuration-invalid';
const SCOPE_MISMATCH = 'scope-mismatch';
const REVISION_MISMATCH = 'revision-mismatch';
const DIGEST_MISMATCH = 'digest-mismatch';
const APPROVAL_MISMATCH = 'approval-mismatch';
const JOURNAL_UNSETTLED = 'journal-unsettled';

export const DirectoryRecoveryReasonSchema = Schema.Literals([
  CONFIGURATION_INVALID,
  'evidence-unavailable',
  SCOPE_MISMATCH,
  'journey-unsupported',
  REVISION_MISMATCH,
  'operation-mismatch',
  'actor-mismatch',
  DIGEST_MISMATCH,
  'lease-live',
  'authority-unavailable',
  'approval-required',
  APPROVAL_MISMATCH,
  JOURNAL_UNSETTLED,
  'timeout',
  'unknown',
]);
export class AdmittedCustomerDirectoryRecoveryError extends Schema.TaggedError<AdmittedCustomerDirectoryRecoveryError>()(
  'AdmittedCustomerDirectoryRecoveryError',
  { reason: DirectoryRecoveryReasonSchema },
) {}
const failure = (reason: AdmittedCustomerDirectoryRecoveryError['reason']) =>
  new AdmittedCustomerDirectoryRecoveryError({ reason });

/** Only SELECT observations belong here. Registration contact data never leaves this program. */
export const DirectoryRecoveryCoreEvidenceSchema = Schema.Struct({
  admissionClosed: Schema.Boolean,
  authorityActive: Schema.Boolean,
  authorityFresh: Schema.Boolean,
  authorityRevision: EnrollmentDigestSchema,
  durablePresent: Schema.Boolean,
});
export interface DirectoryRecoveryObservation {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly core: typeof DirectoryRecoveryCoreEvidenceSchema.Type;
  readonly operation: EnrollmentOwnerOperationSnapshot;
  readonly partyOperation: EnrollmentOwnerOperationSnapshot;
  readonly registration: Option.Option<RetailEnrollmentRegistration>;
}

/** The root supplies native transactions and SELECT-only evidence, never a continuation. */
export const AdmittedCustomerDirectoryRecoveryRuntime = Context.Service<{
  readonly observe: (
    request: DirectoryRecoveryRequest,
  ) => Effect.Effect<DirectoryRecoveryObservation, AdmittedCustomerDirectoryRecoveryError>;
  readonly store: (observation: DirectoryRecoveryObservation) => CommerceEnrollmentOwnerAttemptStore;
}>('commerce.customer-context/scripts/AdmittedCustomerDirectoryRecoveryRuntime');

export const DirectoryRecoveryReportSchema = Schema.Struct({
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  approvalSha256: EnrollmentDigestSchema,
  attemptId: EnrollmentAttemptIdSchema,
  attemptRevision: Schema.Number,
  attemptState: Schema.String,
  compositionRevision: EnrollmentDigestSchema,
  operationId: EnrollmentOwnerOperationIdSchema,
  operationRevision: Schema.Number,
  operationStatus: Schema.String,
  outcomeCode: Schema.optionalKey(Schema.String),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  schemaVersion: Schema.Literal(1),
  sourceRevision: RecoverySourceRevisionSchema,
  status: Schema.Literals(['checked', 'reconciled']),
  tenantId: EnrollmentTenantIdSchema,
});
export type DirectoryRecoveryReport = typeof DirectoryRecoveryReportSchema.Type;

const assert = (condition: boolean, reason: AdmittedCustomerDirectoryRecoveryError['reason']) =>
  condition ? Effect.void : Effect.fail(failure(reason));

const ownerRefs = (observation: DirectoryRecoveryObservation) =>
  Effect.all([
    Schema.decodeUnknownEffect(PartyRefSchema)({
      moduleId: PARTY_REGISTRY_OWNER_MODULE_KEY,
      resourceId: observation.partyOperation.resultReference,
      resourceType: 'party.registry.party',
      tenantId: observation.attempt.tenantId,
    }),
    Schema.decodeUnknownEffect(SellingLegalEntityRefSchema)({
      moduleId: 'core.identity',
      resourceId: observation.attempt.targetLegalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: observation.attempt.tenantId,
    }),
  ]).pipe(Effect.mapError(() => failure(SCOPE_MISMATCH)));

const assertAuthority = (request: DirectoryRecoveryRequest, { core }: DirectoryRecoveryObservation) =>
  assert(
    core.authorityActive &&
      core.admissionClosed &&
      core.authorityFresh &&
      core.authorityRevision === request.compositionRevision,
    'authority-unavailable',
  );

const assertAttempt = (request: DirectoryRecoveryRequest, { attempt }: DirectoryRecoveryObservation) =>
  assert(
    attempt.tenantId === request.tenantId &&
      attempt.portalEnrollmentAttemptId === request.attemptId &&
      attempt.compositionRevision === request.compositionRevision &&
      attempt.targetLegalEntityId !== undefined &&
      (attempt.state === 'IN_PROGRESS' || attempt.state === 'RECONCILIATION_REQUIRED'),
    SCOPE_MISMATCH,
  ).pipe(
    // A restart retains its predecessor's directory commands; this command reconciles only first enrollments.
    Effect.andThen(assert(attempt.journey === 'RETAIL_SELF_ENROLLMENT', 'journey-unsupported')),
  );

const assertOperation = (request: DirectoryRecoveryRequest, { core, operation }: DirectoryRecoveryObservation) =>
  assert(
    operation.tenantId === request.tenantId &&
      operation.portalEnrollmentAttemptId === request.attemptId &&
      operation.ownerInvocationId === request.ownerInvocationId &&
      operation.ownerModuleKey === PARTY_REGISTRY_OWNER_MODULE_KEY &&
      operation.transitionKey === RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY &&
      operation.required &&
      (operation.status === 'IN_PROGRESS' ||
        operation.status === 'INDETERMINATE' ||
        operation.status === 'RECONCILIATION_REQUIRED') &&
      core.durablePresent,
    'operation-mismatch',
  );

const assertPartyOperation = (
  request: DirectoryRecoveryRequest,
  { attempt, operation, partyOperation }: DirectoryRecoveryObservation,
) =>
  assert(
    attempt.createdByPrincipalId === operation.actorPrincipalId &&
      partyOperation.actorPrincipalId === operation.actorPrincipalId,
    'actor-mismatch',
  ).pipe(
    Effect.andThen(
      assert(
        partyOperation.tenantId === request.tenantId &&
          partyOperation.portalEnrollmentAttemptId === request.attemptId &&
          partyOperation.ownerModuleKey === PARTY_REGISTRY_OWNER_MODULE_KEY &&
          partyOperation.transitionKey === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY &&
          partyOperation.status === 'SUCCEEDED' &&
          partyOperation.resultReference !== undefined,
        SCOPE_MISMATCH,
      ),
    ),
  );

/** Every fact the reconcile acts on is re-proven here; revisions are bound separately by the approval. */
const validateObservation = Effect.fn('CustomerDirectoryRecovery.validateObservation')(function* validateObservation(
  request: DirectoryRecoveryRequest,
  observation: DirectoryRecoveryObservation,
) {
  const { attempt, operation } = observation;
  yield* assertAuthority(request, observation);
  yield* assertAttempt(request, observation);
  yield* assertOperation(request, observation);
  yield* assertPartyOperation(request, observation);
  const now = yield* Clock.currentTimeMillis;
  yield* assert(
    [attempt.lease, operation.lease].every(
      (lease) => lease === undefined || DateTime.toEpochMillis(lease.leaseExpiresAt) <= now,
    ),
    'lease-live',
  );
  if (Option.isNone(observation.registration)) {
    return yield* failure('evidence-unavailable');
  }
  const [partyRef, sellingLegalEntityRef] = yield* ownerRefs(observation);
  yield* assert(
    operation.requestDigest ===
      retailSelfEnrollmentRequestDigest({
        intent: { partyRef, sellingLegalEntityRef, step: 'RETAIL_CUSTOMER_DIRECTORY' },
        ownerModuleKey: operation.ownerModuleKey,
        portalEnrollmentAttemptId: request.attemptId,
        transitionKey: operation.transitionKey,
      }),
    DIGEST_MISMATCH,
  );
  // The exact input the production registry builds for this Attempt's directory transition.
  return {
    compositionRevision: attempt.compositionRevision,
    legalEntityId: sellingLegalEntityRef.resourceId,
    partyRef,
    registration: observation.registration.value,
    requestCorrelation: `customer-directory-recovery:${operation.ownerInvocationId}`,
    tenantId: attempt.tenantId,
    validFrom: DateTime.formatIso(attempt.createdAt),
  } satisfies RetailCustomerDirectoryOwnerInput;
});

/** Canonical ordered fields exclude observation time, authority expiry and every contact value. */
export const customerDirectoryRecoveryApproval = (
  request: DirectoryRecoveryRequest,
  observation: DirectoryRecoveryObservation,
  sourceRevision: string,
) =>
  Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  )([
    'admitted-customer-directory-recovery-v1',
    sourceRevision,
    request.tenantId,
    request.attemptId,
    request.ownerInvocationId,
    request.compositionRevision,
    observation.operation.portalEnrollmentOwnerOperationId,
    observation.operation.actorPrincipalId,
    observation.operation.status,
    observation.operation.requestDigest,
    observation.attempt.revision,
    observation.operation.revision,
    observation.attempt.targetLegalEntityId ?? '',
    DateTime.formatIso(observation.attempt.createdAt),
    observation.partyOperation.portalEnrollmentOwnerOperationId,
    observation.partyOperation.revision,
    observation.partyOperation.resultReference ?? '',
  ]).pipe(
    Effect.map((canonical) => Hex.encode(sha256(utf8ToBytes(canonical)))),
    Effect.mapError(() => failure(CONFIGURATION_INVALID)),
  );

/** Runs the published owner reconciliation for exactly the approved operation; it never dispatches. */
const reconcileExactDirectory = Effect.fn('CustomerDirectoryRecovery.reconcileExactDirectory')(
  function* reconcileExactDirectory(
    request: DirectoryRecoveryRequest,
    initial: DirectoryRecoveryObservation,
    input: RetailCustomerDirectoryOwnerInput,
  ) {
    const runtime = yield* AdmittedCustomerDirectoryRecoveryRuntime;
    // A native fence of an expired IN_PROGRESS claim moves both rows by exactly one revision.
    const delta = initial.operation.status === 'IN_PROGRESS' ? 1 : 0;
    const revalidate = (reconciliation: CommerceEnrollmentOwnerReconciliationInput) =>
      Effect.gen(function* revalidateBeforeOwnerEffect() {
        yield* assert(
          reconciliation.observedRevision === initial.attempt.revision + delta &&
            reconciliation.ownerOperationRevision === initial.operation.revision + delta,
          REVISION_MISMATCH,
        );
        const current = yield* runtime.observe(request);
        yield* validateObservation(request, current);
        yield* assert(
          current.attempt.revision === reconciliation.observedRevision &&
            current.operation.revision === reconciliation.ownerOperationRevision &&
            current.operation.portalEnrollmentOwnerOperationId === initial.operation.portalEnrollmentOwnerOperationId &&
            current.operation.requestDigest === initial.operation.requestDigest &&
            current.partyOperation.resultReference === initial.partyOperation.resultReference,
          DIGEST_MISMATCH,
        );
      });
    const nativeOwner = retailCustomerDirectoryOwnerEffect(input);
    const transition = yield* Schema.decodeUnknownEffect(CommerceEnrollmentOwnerTransitionSchema)({
      actorPrincipalId: initial.operation.actorPrincipalId,
      compositionRevision: request.compositionRevision,
      correlationId: input.requestCorrelation,
      expectedRevision: initial.attempt.revision,
      ownerInvocationId: request.ownerInvocationId,
      ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
      portalEnrollmentAttemptId: request.attemptId,
      requestDigest: initial.operation.requestDigest,
      tenantId: request.tenantId,
      transitionKey: RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
    }).pipe(Effect.mapError(() => failure(CONFIGURATION_INVALID)));
    const driver = commerceEnrollmentOwnerTransitionDriverFor({
      attempt: runtime.store(initial),
      owner: {
        dispatch: () =>
          ownerUnavailable(
            'directory_recovery_dispatch_forbidden',
            'Operator recovery cannot dispatch a new transition',
          ),
        reconcile: (reconciliation) =>
          revalidate(reconciliation).pipe(
            Effect.mapError(() =>
              ownerUnavailable('directory_recovery_evidence_changed', 'The approved recovery evidence changed'),
            ),
            Effect.andThen(nativeOwner.reconcile(reconciliation)),
          ),
      },
      required: true,
    });
    yield* driver.reconcile(transition).pipe(Effect.mapError(() => failure(JOURNAL_UNSETTLED)));
    const final = yield* runtime.observe(request);
    yield* assert(
      final.operation.portalEnrollmentOwnerOperationId === initial.operation.portalEnrollmentOwnerOperationId &&
        final.operation.ownerInvocationId === request.ownerInvocationId &&
        final.operation.requestDigest === initial.operation.requestDigest &&
        (final.operation.status === 'SUCCEEDED' || final.operation.status === 'FAILED') &&
        final.operation.lease === undefined &&
        final.operation.completedAt !== undefined &&
        !final.core.durablePresent,
      JOURNAL_UNSETTLED,
    );
    return final;
  },
);

export const recoverAdmittedCustomerDirectory = Effect.fn('CustomerDirectoryRecovery.run')(
  function* recoverAdmittedCustomerDirectory(options: {
    readonly approvalSha256?: string | undefined;
    readonly mode: typeof RecoveryModeSchema.Type;
    readonly request: DirectoryRecoveryRequest;
    readonly sourceRevision: string;
  }) {
    const sourceRevision = yield* Schema.decodeUnknownEffect(RecoverySourceRevisionSchema)(options.sourceRevision).pipe(
      Effect.mapError(() => failure(CONFIGURATION_INVALID)),
    );
    const request = yield* Schema.decodeUnknownEffect(DirectoryRecoveryRequestSchema)(options.request).pipe(
      Effect.mapError(() => failure(CONFIGURATION_INVALID)),
    );
    const runtime = yield* AdmittedCustomerDirectoryRecoveryRuntime;
    const initial = yield* runtime.observe(request);
    yield* validateObservation(request, initial);
    const approvalSha256 = yield* customerDirectoryRecoveryApproval(request, initial, sourceRevision);
    let final = initial;
    if (options.mode === 'reconcile') {
      yield* assert(options.approvalSha256 !== undefined, 'approval-required');
      yield* assert(options.approvalSha256 === approvalSha256, APPROVAL_MISMATCH);
      const current = yield* runtime.observe(request);
      const input = yield* validateObservation(request, current);
      yield* assert(
        (yield* customerDirectoryRecoveryApproval(request, current, sourceRevision)) === approvalSha256,
        APPROVAL_MISMATCH,
      );
      final = yield* reconcileExactDirectory(request, current, input);
    }
    const report: DirectoryRecoveryReport = {
      actorPrincipalId: final.operation.actorPrincipalId,
      approvalSha256,
      attemptId: request.attemptId,
      attemptRevision: final.attempt.revision,
      attemptState: final.attempt.state,
      compositionRevision: request.compositionRevision,
      operationId: final.operation.portalEnrollmentOwnerOperationId,
      operationRevision: final.operation.revision,
      operationStatus: final.operation.status,
      ownerInvocationId: request.ownerInvocationId,
      schemaVersion: 1,
      sourceRevision,
      status: options.mode === 'check' ? 'checked' : 'reconciled',
      tenantId: request.tenantId,
    };
    return final.operation.outcomeCode === undefined ? report : { ...report, outcomeCode: final.operation.outcomeCode };
  },
);

/** Include root acquisition and disposal within the command's deadline. Unknown is never success. */
export const withCustomerDirectoryRecoveryDeadline = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  mode: typeof RecoveryModeSchema.Type,
) =>
  operation.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(mode === 'check' ? 30 : 60),
      orElse: () => Effect.fail(failure('timeout')),
    }),
  );
