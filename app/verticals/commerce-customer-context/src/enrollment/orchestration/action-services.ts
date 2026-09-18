import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';

import type {
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
} from '../../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../attempts/attempt-persistence.ts';
import type { AttemptRecordResult, EnrollmentAttemptScopedRoutineInvoker } from '../attempts/attempt-persistence.ts';
import { commerceEnrollmentAttemptServiceForPersistence } from '../attempts/attempt-service.ts';
import type {
  CommerceEnrollmentAttemptReconciliationAuthority,
  CommerceEnrollmentAttemptService,
} from '../attempts/attempt-service.ts';
import { CommerceEnrollmentAttemptRejected } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { CommerceEnrollmentPreparedOwnerCapability } from './prepared-owner-authority.ts';
import type { CommerceEnrollmentPreparedOwnerEvidence } from './prepared-owner-authority.ts';

export interface CommerceEnrollmentAttemptActionServices {
  readonly attempt: CommerceEnrollmentAttemptService;
}

export interface CommerceEnrollmentPreparedAttemptActionServices extends CommerceEnrollmentAttemptActionServices {
  readonly preparedOwner: CommerceEnrollmentPreparedOwnerCapability['Service'];
  readonly reconcilePrepared: (
    input: ReconcileEnrollmentRequest,
    evidence: CommerceEnrollmentPreparedOwnerEvidence,
  ) => Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError>;
}

const unavailableReconciliationAuthority = (): CommerceEnrollmentAttemptReconciliationAuthority => ({
  resolve: (input) =>
    Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_unavailable',
        reason: 'Owner reconciliation authority is not installed for this Action',
        retryable: true,
      }),
    ),
});

const sameReconciliationBinding = (
  input: ReconcileEnrollmentRequest,
  evidence: CommerceEnrollmentPreparedOwnerEvidence,
): boolean =>
  input.expectedRevision === evidence.expectedRevision &&
  input.ownerInvocationId === evidence.ownerInvocationId &&
  input.ownerModuleKey === evidence.ownerModuleKey &&
  input.portalEnrollmentAttemptId === evidence.portalEnrollmentAttemptId &&
  input.tenantId === evidence.tenantId &&
  input.transitionKey === evidence.transitionKey;

const preparedReconciliationAuthority = (
  evidence: CommerceEnrollmentPreparedOwnerEvidence,
): CommerceEnrollmentAttemptReconciliationAuthority => ({
  resolve: (input) => {
    if (!sameReconciliationBinding(input, evidence) || evidence.resolution === undefined) {
      return Effect.fail(
        new CommerceEnrollmentAttemptRejected({
          attemptId: input.portalEnrollmentAttemptId,
          code: 'attempt_invalid',
          reason: 'The prepared owner evidence does not match the reconciliation request',
          retryable: false,
        }),
      );
    }
    const resolution: ReconcileEnrollmentResolution = evidence.resolution;
    return Effect.succeed(resolution);
  },
});

const attemptServiceForTransaction = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  scope: OperationalScope,
  authority: CommerceEnrollmentAttemptReconciliationAuthority,
): CommerceEnrollmentAttemptService =>
  commerceEnrollmentAttemptServiceForPersistence(
    commerceEnrollmentAttemptPersistenceForTransaction(transaction, scope),
    authority,
  );

/**
 * Start, claim and terminate use the durable scoped-routine façade.  Reconciliation is kept
 * unavailable in this service so a handler cannot accidentally record an outcome without owner
 * evidence.
 */
export const commerceEnrollmentAttemptActionServicesForTransaction = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<CommerceEnrollmentAttemptActionServices> =>
  Effect.succeed({
    attempt: attemptServiceForTransaction(transaction, scope, unavailableReconciliationAuthority()),
  });

/** Build the claim/record service bundle and require the invocation-bound prepared capability. */
export const commerceEnrollmentPreparedAttemptActionServicesForTransaction = Effect.fn(
  'ActionServices.commerceEnrollmentPreparedAttemptActionServicesForTransaction',
)(function* makeCommerceEnrollmentPreparedAttemptActionServices(
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  scope: OperationalScope,
) {
  const preparedOwner = yield* CommerceEnrollmentPreparedOwnerCapability;
  const persistence = commerceEnrollmentAttemptPersistenceForTransaction(transaction, scope);
  const attempt = commerceEnrollmentAttemptServiceForPersistence(persistence, unavailableReconciliationAuthority());
  const reconcilePrepared = (input: ReconcileEnrollmentRequest, evidence: CommerceEnrollmentPreparedOwnerEvidence) =>
    commerceEnrollmentAttemptServiceForPersistence(
      persistence,
      preparedReconciliationAuthority(evidence),
    ).reconcileOutcome(input);
  return Object.freeze({ attempt, preparedOwner, reconcilePrepared });
});
