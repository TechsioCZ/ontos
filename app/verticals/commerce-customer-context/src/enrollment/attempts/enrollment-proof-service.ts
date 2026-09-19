import { DateTime, Effect, Schema } from 'effect';

import {
  CommerceEnrollmentProofRejected,
  CommerceEnrollmentProofUnavailable,
} from '../../../api/portal-auth/enrollment-proof-port.ts';
import type { CommerceEnrollmentProofService } from '../../../api/portal-auth/enrollment-proof-port.ts';
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
      return yield* Schema.decodeEffect(EnrollmentProofSchema)(proof).pipe(Effect.mapError((cause) => rejected(cause)));
    }),
  };
};
