import { createHash } from 'node:crypto';

import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Clock, Context, DateTime, Duration, Effect, Option, Schema } from 'effect';

import { SellingLegalEntityRefSchema } from '../shared/domain/profile-contracts.ts';
import type { EnsureRetailCustomerProfileResult } from '../shared/actions/ensure-retail-customer-profile.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../shared/enrollment-contracts.ts';
import type {
  ClaimEnrollmentTransitionInput,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
} from '../shared/enrollment-contracts.ts';
import { CommerceEnrollmentAttemptConflict } from '../src/enrollment/attempts/errors.ts';
import {
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailSelfEnrollmentRequestDigest,
} from '../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CommerceActionCommitResolutionFailed,
  retailCustomerProfileOwnerEffect,
} from '../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import type {
  RetailCustomerProfileOwnerExecutors,
  RetailCustomerProfileOwnerInput,
  resolveRetailOwnerCommand,
} from '../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import { retailCustomerProfileCommitResolutionFor } from '../src/enrollment/orchestration/owner-effect-registry.ts';
import { ownerUnavailable } from '../src/enrollment/orchestration/owner-effect-codec.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerReconciliationInput,
} from '../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../src/enrollment/orchestration/owner-transition-production.ts';

const revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
export const RecoverySourceRevisionSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
export const RecoveryModeSchema = Schema.Literals(['check', 'reconcile']);
export const RecoveryRequestSchema = Schema.Struct({
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  attemptId: EnrollmentAttemptIdSchema,
  compositionRevision: EnrollmentDigestSchema,
  expectedAttemptRevision: revision,
  expectedOperationRevision: revision,
  operationId: EnrollmentOwnerOperationIdSchema,
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  receiptId: EnrollmentActionInvocationIdSchema,
  servicePrincipalId: EnrollmentPrincipalIdSchema,
  tenantId: EnrollmentTenantIdSchema,
});
export type RecoveryRequest = typeof RecoveryRequestSchema.Type;

const REVISION_MISMATCH = 'revision-mismatch';
const CONFIGURATION_INVALID = 'configuration-invalid';
const SCOPE_MISMATCH = 'scope-mismatch';
const DIGEST_MISMATCH = 'digest-mismatch';
const APPROVAL_MISMATCH = 'approval-mismatch';
const JOURNAL_UNSETTLED = 'journal-unsettled';

export const RecoveryReasonSchema = Schema.Literals([
  CONFIGURATION_INVALID,
  'evidence-unavailable',
  SCOPE_MISMATCH,
  REVISION_MISMATCH,
  'operation-mismatch',
  'actor-mismatch',
  DIGEST_MISMATCH,
  'lease-live',
  'authority-unavailable',
  'receipt-mismatch',
  'command-unresolved',
  'approval-required',
  APPROVAL_MISMATCH,
  JOURNAL_UNSETTLED,
  'result-unproven',
  'timeout',
  'unknown',
]);
export class AdmittedRetailProfileRecoveryError extends Schema.TaggedError<AdmittedRetailProfileRecoveryError>()(
  'AdmittedRetailProfileRecoveryError',
  { reason: RecoveryReasonSchema },
) {}
const failure = (reason: AdmittedRetailProfileRecoveryError['reason']) =>
  new AdmittedRetailProfileRecoveryError({ reason });

/** Only SELECT observations belong here. No raw payload, error or contact data leaves this program. */
export const RecoveryCoreEvidenceSchema = Schema.Struct({
  admissionClosed: Schema.Boolean,
  authorityActive: Schema.Boolean,
  authorityFresh: Schema.Boolean,
  authorityRevision: EnrollmentDigestSchema,
  durablePresent: Schema.Boolean,
  receiptActionKey: EnrollmentKeySchema,
  receiptAuthMethod: Schema.String,
  receiptCompleted: Schema.Boolean,
  receiptId: EnrollmentActionInvocationIdSchema,
  receiptIdempotencyKey: EnrollmentActionInvocationIdSchema,
  receiptLegalEntityId: EnrollmentLegalEntityIdSchema,
  receiptPrincipalId: EnrollmentPrincipalIdSchema,
  receiptRequestHash: EnrollmentDigestSchema,
  receiptStatus: Schema.String,
  receiptTenantId: EnrollmentTenantIdSchema,
});
export interface RecoveryObservation {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly core: typeof RecoveryCoreEvidenceSchema.Type;
  readonly operation: EnrollmentOwnerOperationSnapshot;
  readonly partyOperation: EnrollmentOwnerOperationSnapshot;
  readonly profile: Option.Option<EnsureRetailCustomerProfileResult>;
}

/** The root supplies native transactions, transports and SELECT-only evidence, never a continuation. */
export const AdmittedRetailProfileRecoveryRuntime = Context.Service<{
  readonly executeProfile: (
    input: RetailCustomerProfileOwnerInput,
  ) => RetailCustomerProfileOwnerExecutors['ensureProfile'];
  readonly observe: (
    request: RecoveryRequest,
  ) => Effect.Effect<RecoveryObservation, AdmittedRetailProfileRecoveryError>;
  readonly resolveCommand: typeof resolveRetailOwnerCommand;
  readonly run: CommerceEnrollmentOwnerTransactionRun;
  readonly store: (observation: RecoveryObservation) => CommerceEnrollmentOwnerAttemptStore;
}>('commerce.customer-context/scripts/AdmittedRetailProfileRecoveryRuntime');
export type RetailProfileRecoveryRequirements = typeof AdmittedRetailProfileRecoveryRuntime.Identifier;

export const RecoveryReportSchema = Schema.Struct({
  approvalSha256: EnrollmentDigestSchema,
  attemptId: EnrollmentAttemptIdSchema,
  attemptRevision: revision,
  operationId: EnrollmentOwnerOperationIdSchema,
  operationRevision: revision,
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  receiptId: EnrollmentActionInvocationIdSchema,
  schemaVersion: Schema.Literal(1),
  sourceRevision: RecoverySourceRevisionSchema,
  status: Schema.Literals(['checked', 'reconciled']),
  tenantId: EnrollmentTenantIdSchema,
});
export type RecoveryReport = typeof RecoveryReportSchema.Type;

const assert = (condition: boolean, reason: AdmittedRetailProfileRecoveryError['reason']) =>
  condition ? Effect.void : Effect.fail(failure(reason));

const assertAuthority = (request: RecoveryRequest, observation: RecoveryObservation) =>
  assert(
    observation.core.authorityActive &&
      observation.core.admissionClosed &&
      observation.core.authorityFresh &&
      observation.core.authorityRevision === request.compositionRevision,
    'authority-unavailable',
  );

const assertReceipt = (request: RecoveryRequest, observation: RecoveryObservation) => {
  const { attempt, core } = observation;
  return assert(
    core.receiptId === request.receiptId &&
      core.receiptPrincipalId === request.servicePrincipalId &&
      core.receiptTenantId === request.tenantId &&
      core.receiptLegalEntityId === attempt.targetLegalEntityId &&
      core.receiptActionKey === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY &&
      core.receiptIdempotencyKey === request.ownerInvocationId &&
      core.receiptAuthMethod === 'api_key' &&
      ((core.receiptStatus === 'received' && !core.receiptCompleted) ||
        (core.receiptStatus === 'succeeded' && core.receiptCompleted)),
    'receipt-mismatch',
  );
};

const profileInput = (observation: RecoveryObservation) =>
  Effect.gen(function* deriveExactProfileInput() {
    const { attempt, partyOperation } = observation;
    const [partyRef, sellingLegalEntityRef] = yield* Effect.all([
      Schema.decodeUnknownEffect(PartyRefSchema)({
        moduleId: PARTY_REGISTRY_OWNER_MODULE_KEY,
        resourceId: partyOperation.resultReference,
        resourceType: 'party.registry.party',
        tenantId: attempt.tenantId,
      }),
      Schema.decodeUnknownEffect(SellingLegalEntityRefSchema)({
        moduleId: 'core.identity',
        resourceId: attempt.targetLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: attempt.tenantId,
      }),
    ]).pipe(Effect.mapError(() => failure(SCOPE_MISMATCH)));
    return {
      compositionRevision: attempt.compositionRevision,
      effectiveAt: attempt.createdAt,
      partyRef,
      requestCorrelation: `profile-recovery:${observation.operation.ownerInvocationId}`,
      sellingLegalEntityRef,
    } satisfies RetailCustomerProfileOwnerInput;
  });

const assertOperation = (request: RecoveryRequest, observation: RecoveryObservation) => {
  const { operation } = observation;
  return assert(
    operation.portalEnrollmentOwnerOperationId === request.operationId &&
      operation.tenantId === request.tenantId &&
      operation.portalEnrollmentAttemptId === request.attemptId &&
      operation.ownerInvocationId === request.ownerInvocationId &&
      operation.ownerModuleKey === COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY &&
      operation.transitionKey === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY &&
      operation.required &&
      (operation.status === 'IN_PROGRESS' ||
        operation.status === 'INDETERMINATE' ||
        operation.status === 'RECONCILIATION_REQUIRED') &&
      observation.core.durablePresent,
    'operation-mismatch',
  );
};

/** Reads may be repeated after native fencing; only that phase may change journal revisions. */
const validateObservation = Effect.fn('RetailProfileRecovery.validateObservation')(function* validateObservation(
  request: RecoveryRequest,
  observation: RecoveryObservation,
  expectedAttemptRevision: number,
  expectedOperationRevision: number,
) {
  const { attempt, operation, partyOperation } = observation;
  yield* assertAuthority(request, observation);
  yield* assert(
    attempt.tenantId === request.tenantId &&
      attempt.portalEnrollmentAttemptId === request.attemptId &&
      attempt.compositionRevision === request.compositionRevision &&
      attempt.journey === 'RETAIL_SELF_ENROLLMENT' &&
      attempt.targetLegalEntityId !== undefined &&
      (attempt.state === 'IN_PROGRESS' || attempt.state === 'RECONCILIATION_REQUIRED'),
    SCOPE_MISMATCH,
  );
  yield* assert(
    attempt.revision === expectedAttemptRevision && operation.revision === expectedOperationRevision,
    REVISION_MISMATCH,
  );
  yield* assertOperation(request, observation);
  yield* assert(
    attempt.createdByPrincipalId === request.actorPrincipalId &&
      operation.actorPrincipalId === request.actorPrincipalId &&
      partyOperation.actorPrincipalId === request.actorPrincipalId,
    'actor-mismatch',
  );
  yield* assert(
    partyOperation.tenantId === request.tenantId &&
      partyOperation.portalEnrollmentAttemptId === request.attemptId &&
      partyOperation.ownerModuleKey === PARTY_REGISTRY_OWNER_MODULE_KEY &&
      partyOperation.transitionKey === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY &&
      partyOperation.status === 'SUCCEEDED' &&
      partyOperation.resultReference !== undefined,
    SCOPE_MISMATCH,
  );
  const now = yield* Clock.currentTimeMillis;
  yield* assert(
    [attempt.lease, operation.lease].every(
      (lease) => lease === undefined || DateTime.toEpochMillis(lease.leaseExpiresAt) <= now,
    ),
    'lease-live',
  );
  yield* assertReceipt(request, observation);
  const input = yield* profileInput(observation);
  yield* assert(
    operation.requestDigest ===
      retailSelfEnrollmentRequestDigest({
        intent: {
          partyRef: input.partyRef,
          sellingLegalEntityRef: input.sellingLegalEntityRef,
          step: 'RETAIL_CUSTOMER_PROFILE',
        },
        ownerModuleKey: operation.ownerModuleKey,
        portalEnrollmentAttemptId: request.attemptId,
        transitionKey: operation.transitionKey,
      }),
    DIGEST_MISMATCH,
  );
  return input;
});

/** Canonical ordered fields deliberately exclude observation time and authority expiry time. */
export const retailProfileRecoveryApproval = (
  request: RecoveryRequest,
  observation: RecoveryObservation,
  sourceRevision: string,
) =>
  Effect.gen(function* encodeApproval() {
    const canonical = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
    )([
      'admitted-retail-profile-recovery-v1',
      sourceRevision,
      request.tenantId,
      request.attemptId,
      request.operationId,
      request.ownerInvocationId,
      request.compositionRevision,
      request.actorPrincipalId,
      request.servicePrincipalId,
      request.receiptId,
      request.expectedAttemptRevision,
      request.expectedOperationRevision,
      observation.operation.requestDigest,
      observation.core.receiptRequestHash,
      observation.core.receiptStatus,
      observation.core.receiptCompleted,
      observation.attempt.targetLegalEntityId ?? '',
      DateTime.formatIso(observation.attempt.createdAt),
      observation.partyOperation.portalEnrollmentOwnerOperationId,
      observation.partyOperation.ownerInvocationId,
      observation.partyOperation.revision,
      observation.partyOperation.resultReference ?? '',
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }).pipe(Effect.mapError(() => failure(CONFIGURATION_INVALID)));

const commandFailure = () =>
  new CommerceActionCommitResolutionFailed({
    code: 'commit_resolution_rejected',
    reason: 'The exact approved original command identity or authority could not be proven',
  });

/**
 * The caller MUST execute this entire effect in a transaction that rolls back a failed body.
 * Native claim fences before checking expectedRevision. Checking both exact post-fence deltas
 * under the same native row locks prevents a concurrent revision from committing that fence.
 */
export const claimApprovedRetailProfileFence = Effect.fn('RetailProfileRecovery.claimApprovedFence')(
  function* claimApprovedRetailProfileFence(
    initial: RecoveryObservation,
    input: ClaimEnrollmentTransitionInput,
    store: CommerceEnrollmentOwnerAttemptStore,
  ) {
    const conflict = () =>
      new CommerceEnrollmentAttemptConflict({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_conflict',
        reason: 'The exact approved profile fence revisions or identity changed',
        retryable: false,
      });
    const attemptIdentity = {
      portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
      tenantId: input.tenantId,
    };
    const operationIdentity = {
      ...attemptIdentity,
      ownerModuleKey: input.ownerModuleKey,
      transitionKey: input.transitionKey,
    };
    const beforeAttempt = yield* store.read(attemptIdentity);
    const beforeOperation = yield* store.readOwnerOperation(operationIdentity);
    const sameOperation = (operation: EnrollmentOwnerOperationSnapshot) =>
      operation.portalEnrollmentOwnerOperationId === initial.operation.portalEnrollmentOwnerOperationId &&
      operation.tenantId === initial.operation.tenantId &&
      operation.portalEnrollmentAttemptId === initial.operation.portalEnrollmentAttemptId &&
      operation.ownerInvocationId === initial.operation.ownerInvocationId &&
      operation.ownerModuleKey === initial.operation.ownerModuleKey &&
      operation.transitionKey === initial.operation.transitionKey &&
      operation.requestDigest === initial.operation.requestDigest &&
      operation.actorPrincipalId === initial.operation.actorPrincipalId &&
      operation.required === initial.operation.required;
    if (
      beforeAttempt.revision !== initial.attempt.revision ||
      input.expectedRevision !== initial.attempt.revision ||
      beforeAttempt.compositionRevision !== initial.attempt.compositionRevision ||
      beforeOperation.revision !== initial.operation.revision ||
      beforeOperation.status !== 'IN_PROGRESS' ||
      !sameOperation(beforeOperation)
    ) {
      return yield* conflict();
    }
    const result = yield* store.claimTransition(input);
    const afterAttempt = yield* store.read(attemptIdentity);
    const afterOperation = yield* store.readOwnerOperation(operationIdentity);
    if (
      result.outcome !== 'INDETERMINATE' ||
      result.attempt.revision !== initial.attempt.revision + 1 ||
      afterAttempt.revision !== initial.attempt.revision + 1 ||
      afterAttempt.compositionRevision !== initial.attempt.compositionRevision ||
      afterOperation.revision !== initial.operation.revision + 1 ||
      afterOperation.status !== 'INDETERMINATE' ||
      afterOperation.lease !== undefined ||
      !sameOperation(afterOperation)
    ) {
      return yield* conflict();
    }
    return result;
  },
);

/** Do not expose the broad registry or a dispatch capability to the operator. */
const reconcileExactProfile = Effect.fn('RetailProfileRecovery.reconcileExactProfile')(function* reconcileExactProfile(
  request: RecoveryRequest,
  initial: RecoveryObservation,
  input: RetailCustomerProfileOwnerInput,
) {
  const runtime = yield* AdmittedRetailProfileRecoveryRuntime;
  const revalidate = (reconciliation: CommerceEnrollmentOwnerReconciliationInput) =>
    Effect.gen(function* revalidateBeforeOwnerEffect() {
      const delta = initial.operation.status === 'IN_PROGRESS' ? 1 : 0;
      yield* assert(
        reconciliation.observedRevision === initial.attempt.revision + delta &&
          reconciliation.ownerOperationRevision === initial.operation.revision + delta,
        REVISION_MISMATCH,
      );
      const current = yield* runtime.observe(request);
      yield* validateObservation(
        request,
        current,
        reconciliation.observedRevision,
        reconciliation.ownerOperationRevision,
      );
      yield* assert(
        current.core.receiptRequestHash === initial.core.receiptRequestHash &&
          current.operation.requestDigest === initial.operation.requestDigest &&
          current.partyOperation.resultReference === initial.partyOperation.resultReference &&
          current.attempt.targetLegalEntityId === initial.attempt.targetLegalEntityId &&
          DateTime.formatIso(current.attempt.createdAt) === DateTime.formatIso(initial.attempt.createdAt),
        DIGEST_MISMATCH,
      );
      return current;
    });
  let activeReconciliation: CommerceEnrollmentOwnerReconciliationInput | undefined;
  const guardedResolve: typeof resolveRetailOwnerCommand = (authority, payload) =>
    Effect.gen(function* resolveOnlyKnownCommand() {
      if (
        activeReconciliation === undefined ||
        payload.idempotencyKey !== request.ownerInvocationId ||
        payload.actionKey !== ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY
      ) {
        return yield* commandFailure();
      }
      const current = yield* revalidate(activeReconciliation).pipe(Effect.mapError(commandFailure));
      const resolution = yield* runtime.resolveCommand(authority, payload);
      if (
        resolution.state === 'NOT_STARTED' ||
        resolution.state === 'RUNNING' ||
        resolution.state === 'REJECTED' ||
        resolution.invocationId !== request.receiptId ||
        (resolution.state === 'RETRYABLE' && current.core.receiptStatus !== 'received') ||
        (resolution.state === 'COMMITTED' && current.core.receiptStatus !== 'succeeded')
      ) {
        return yield* commandFailure();
      }
      return resolution;
    }).pipe(
      Effect.mapError(() =>
        ownerUnavailable('profile_recovery_command_unproven', 'The exact original command could not be proven'),
      ),
    );
  const execute = runtime.executeProfile(input);
  const nativeOwner = retailCustomerProfileOwnerEffect(input, {
    commitResolution: retailCustomerProfileCommitResolutionFor(Option.some(runtime.run), input, guardedResolve),
    ensureProfile: (payload, correlation, options) =>
      Effect.gen(function* retryOnlyExactApprovedCommand() {
        if (activeReconciliation === undefined || options.idempotencyKey !== request.ownerInvocationId) {
          return yield* commandFailure();
        }
        const current = yield* revalidate(activeReconciliation).pipe(Effect.mapError(commandFailure));
        if (current.core.receiptStatus !== 'received') {
          return yield* commandFailure();
        }
        return yield* execute(payload, correlation, options);
      }).pipe(
        Effect.mapError(() =>
          ownerUnavailable('profile_recovery_retry_unproven', 'The exact original retry could not be proven'),
        ),
      ),
  });
  const transition = yield* Schema.decodeUnknownEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: request.actorPrincipalId,
    compositionRevision: request.compositionRevision,
    correlationId: input.requestCorrelation,
    expectedRevision: request.expectedAttemptRevision,
    ownerInvocationId: request.ownerInvocationId,
    ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId: request.attemptId,
    requestDigest: initial.operation.requestDigest,
    tenantId: request.tenantId,
    transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  }).pipe(Effect.mapError(() => failure(CONFIGURATION_INVALID)));
  const driver = commerceEnrollmentOwnerTransitionDriverFor({
    attempt: runtime.store(initial),
    owner: {
      dispatch: () =>
        ownerUnavailable('profile_recovery_dispatch_forbidden', 'Operator recovery cannot dispatch a new transition'),
      reconcile: (reconciliation) =>
        Effect.gen(function* reconcileOnlyOneExistingOperation() {
          activeReconciliation = reconciliation;
          yield* revalidate(reconciliation).pipe(
            Effect.mapError(() =>
              ownerUnavailable('profile_recovery_evidence_changed', 'The approved recovery evidence changed'),
            ),
          );
          return yield* nativeOwner.reconcile(reconciliation);
        }),
    },
    required: true,
  });
  yield* driver.reconcile(transition).pipe(Effect.mapError(() => failure(JOURNAL_UNSETTLED)));
  const final = yield* runtime.observe(request);
  yield* assertAuthority(request, final);
  yield* assertReceipt(request, final);
  yield* assert(
    final.operation.portalEnrollmentOwnerOperationId === request.operationId &&
      final.operation.ownerInvocationId === request.ownerInvocationId &&
      final.operation.actorPrincipalId === request.actorPrincipalId &&
      final.operation.requestDigest === initial.operation.requestDigest &&
      final.operation.status === 'SUCCEEDED' &&
      final.operation.lease === undefined &&
      final.operation.completedAt !== undefined &&
      final.operation.resultReference !== undefined &&
      final.core.receiptStatus === 'succeeded' &&
      final.core.receiptRequestHash === initial.core.receiptRequestHash &&
      !final.core.durablePresent,
    JOURNAL_UNSETTLED,
  );
  yield* assert(
    Option.isSome(final.profile) &&
      final.profile.value.state === 'ACTIVE' &&
      final.profile.value.profileRef.resourceId === final.operation.resultReference,
    'result-unproven',
  );
  return final;
});

export const recoverAdmittedRetailProfile = Effect.fn('RetailProfileRecovery.run')(
  function* recoverAdmittedRetailProfile(options: {
    readonly approvalSha256?: string;
    readonly mode: typeof RecoveryModeSchema.Type;
    readonly request: RecoveryRequest;
    readonly sourceRevision: string;
  }): Effect.fn.Return<RecoveryReport, AdmittedRetailProfileRecoveryError, RetailProfileRecoveryRequirements> {
    const sourceRevision = yield* Schema.decodeUnknownEffect(RecoverySourceRevisionSchema)(options.sourceRevision).pipe(
      Effect.mapError(() => failure(CONFIGURATION_INVALID)),
    );
    const request = yield* Schema.decodeUnknownEffect(RecoveryRequestSchema)(options.request).pipe(
      Effect.mapError(() => failure(CONFIGURATION_INVALID)),
    );
    const runtime = yield* AdmittedRetailProfileRecoveryRuntime;
    const initial = yield* runtime.observe(request);
    const input = yield* validateObservation(
      request,
      initial,
      request.expectedAttemptRevision,
      request.expectedOperationRevision,
    );
    const approvalSha256 = yield* retailProfileRecoveryApproval(request, initial, sourceRevision);
    let final = initial;
    if (options.mode === 'reconcile') {
      yield* assert(options.approvalSha256 !== undefined, 'approval-required');
      yield* assert(options.approvalSha256 === approvalSha256, APPROVAL_MISMATCH);
      const current = yield* runtime.observe(request);
      yield* validateObservation(request, current, request.expectedAttemptRevision, request.expectedOperationRevision);
      yield* assert(
        (yield* retailProfileRecoveryApproval(request, current, sourceRevision)) === approvalSha256,
        APPROVAL_MISMATCH,
      );
      final = yield* reconcileExactProfile(request, current, input);
    }
    return {
      approvalSha256,
      attemptId: request.attemptId,
      attemptRevision: final.attempt.revision,
      operationId: request.operationId,
      operationRevision: final.operation.revision,
      ownerInvocationId: request.ownerInvocationId,
      receiptId: request.receiptId,
      schemaVersion: 1,
      sourceRevision,
      status: options.mode === 'check' ? 'checked' : 'reconciled',
      tenantId: request.tenantId,
    };
  },
);

/** Include root acquisition and disposal within the command's deadline. Unknown is never success. */
export const withRetailProfileRecoveryDeadline = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  mode: typeof RecoveryModeSchema.Type,
) =>
  operation.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(mode === 'check' ? 30 : 60),
      orElse: () => Effect.fail(failure('timeout')),
    }),
  );
