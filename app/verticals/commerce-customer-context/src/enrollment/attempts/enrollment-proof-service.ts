import { DateTime, Effect, Layer, Schema } from 'effect';

import {
  CommerceEnrollmentProofRejected,
  CommerceEnrollmentProofService,
  CommerceEnrollmentProofUnavailable,
} from '../../../api/portal-auth/enrollment-proof-port.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../orchestration/owner-transition-production.ts';
import {
  EnrollmentProofSchema,
  VerifyEnrollmentProofInputSchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import type { CommercePortalAccountSubject } from '../../../shared/enrollment-contracts.ts';
import type { ExternalUserSubject } from '../../../shared/portal-auth-contracts.ts';
import type { CommerceEnrollmentOwnerScope, EnrollmentAttemptScopedRoutineInvoker } from './attempt-persistence.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from './attempt-persistence.ts';
import { CommerceEnrollmentAttemptUnavailable } from './errors.ts';
import type { CommerceEnrollmentAttemptError } from './errors.ts';

const COMMERCE_ENROLLMENT_PROOF_POLICY_VERSION = 'commerce-enrollment-proof.v1';

const rejected = (cause?: unknown) => {
  const error = new CommerceEnrollmentProofRejected({});
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};
const unavailable = (cause?: unknown) => {
  const error = new CommerceEnrollmentProofUnavailable({});
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};

const mapAttemptErrorToProof = (error: CommerceEnrollmentAttemptError) =>
  Schema.is(CommerceEnrollmentAttemptUnavailable)(error) ? unavailable(error) : rejected();

const subjectMatches = (
  actual: CommercePortalAccountSubject | undefined,
  expected: Pick<ExternalUserSubject, 'authenticationNamespaceId' | 'providerSubjectId' | 'subjectType'>,
) =>
  actual !== undefined &&
  actual.authenticationNamespaceId === expected.authenticationNamespaceId &&
  actual.providerSubjectId === expected.providerSubjectId &&
  actual.subjectType === expected.subjectType;

/**
 * The provider bridge receives this service as a private owner capability.  It can authorize
 * account creation only for the exact transition lease already claimed in Commerce, and it can
 * issue a compact proof only from a governed Attempt read.  Neither method accepts credentials,
 * session tokens, invitation secrets or arbitrary provider payloads.
 */
export const commerceEnrollmentProofServiceForTransaction = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  scope: CommerceEnrollmentOwnerScope,
): CommerceEnrollmentProofService['Service'] => {
  const persistence = commerceEnrollmentAttemptPersistenceForTransaction(transaction, scope);
  return {
    authorizeAccountCreation: (input: {
      readonly enrollmentAttemptId: string;
      readonly ownerInvocationId: string;
      readonly tenantId: string;
    }) =>
      persistence
        .authorizeAccountCreation({
          ownerInvocationId: input.ownerInvocationId,
          portalEnrollmentAttemptId: input.enrollmentAttemptId,
          tenantId: input.tenantId,
        })
        .pipe(Effect.mapError(mapAttemptErrorToProof)),
    verify: Effect.fn('CommerceEnrollmentProofService.verify')(function* verifyEnrollmentProof(
      input: ExternalUserSubject & { readonly enrollmentAttemptId: string; readonly tenantId: string },
    ) {
      const decodedInput = yield* Schema.decodeEffect(VerifyEnrollmentProofInputSchema)({
        authenticationNamespaceId: input.authenticationNamespaceId,
        portalEnrollmentAttemptId: input.enrollmentAttemptId,
        providerSubjectId: input.providerSubjectId,
        subjectType: input.subjectType,
        tenantId: input.tenantId,
      }).pipe(Effect.mapError((cause) => rejected(cause)));
      if (decodedInput.tenantId !== scope.tenantId) {
        return yield* rejected();
      }
      const attempt = yield* persistence
        .read({
          portalEnrollmentAttemptId: decodedInput.portalEnrollmentAttemptId,
          tenantId: decodedInput.tenantId,
        })
        .pipe(Effect.mapError(mapAttemptErrorToProof));
      if (
        isEnrollmentAttemptTerminal(attempt.state) ||
        attempt.state === 'RECONCILIATION_REQUIRED' ||
        !subjectMatches(attempt.accountSubject, decodedInput)
      ) {
        return yield* rejected();
      }
      const proof = {
        enrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        evidenceRef: attempt.lastOwnerInvocationId ?? attempt.portalEnrollmentAttemptId,
        observedAt: DateTime.nowUnsafe(),
        policyVersion: COMMERCE_ENROLLMENT_PROOF_POLICY_VERSION,
        revision: attempt.revision,
      };
      return yield* Schema.decodeEffect(EnrollmentProofSchema, { onExcessProperty: 'error' })(proof).pipe(
        Effect.mapError((cause) => rejected(cause)),
      );
    }),
  };
};

type CommerceEnrollmentProofFailure =
  | InstanceType<typeof CommerceEnrollmentProofRejected>
  | InstanceType<typeof CommerceEnrollmentProofUnavailable>;

type ProofOutcome<Value> =
  | { readonly failure: CommerceEnrollmentProofFailure; readonly kind: 'refused' }
  | { readonly kind: 'answered'; readonly value: Value };

/**
 * One proof read, one committed transaction, scoped to the Tenant its own input names. The proof
 * refusal is carried out of the transaction as a value: the runner's callback may only fail with an
 * Attempt error, and collapsing a refusal into one would turn a definitive denial into a retryable
 * transaction failure.
 */
const runProof = <Value>(
  run: CommerceEnrollmentOwnerTransactionRun,
  tenantId: string,
  operation: (
    service: CommerceEnrollmentProofService['Service'],
  ) => Effect.Effect<Value, CommerceEnrollmentProofFailure>,
): Effect.Effect<Value, CommerceEnrollmentProofFailure> => {
  const scope: CommerceEnrollmentOwnerScope = { tenantId };
  return run(scope, (transaction) =>
    operation(commerceEnrollmentProofServiceForTransaction(transaction, scope)).pipe(
      Effect.match({
        onFailure: (failure): ProofOutcome<Value> => ({ failure, kind: 'refused' }),
        onSuccess: (value): ProofOutcome<Value> => ({ kind: 'answered', value }),
      }),
    ),
  ).pipe(
    Effect.mapError(mapAttemptErrorToProof),
    Effect.flatMap((outcome) =>
      outcome.kind === 'refused' ? Effect.fail(outcome.failure) : Effect.succeed(outcome.value),
    ),
  );
};

/**
 * The deployed proof capability. Both methods are Tenant-scoped inside PostgreSQL by the durable
 * routines themselves and authorize the exact (Attempt, owner invocation) pair there, so the scope
 * installed per call selects the rows the caller already named rather than standing in for that
 * authorization.
 */
const commerceEnrollmentProofServiceForRun = (
  run: CommerceEnrollmentOwnerTransactionRun,
): CommerceEnrollmentProofService['Service'] =>
  Object.freeze({
    authorizeAccountCreation: (input) =>
      runProof(run, input.tenantId, (service) => service.authorizeAccountCreation(input)),
    verify: (input) => runProof(run, input.tenantId, (service) => service.verify(input)),
  });

export const CommerceEnrollmentProofServiceLive = Layer.effect(
  CommerceEnrollmentProofService,
  Effect.gen(function* makeCommerceEnrollmentProofServiceLive() {
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    return commerceEnrollmentProofServiceForRun(runner.run);
  }),
);
