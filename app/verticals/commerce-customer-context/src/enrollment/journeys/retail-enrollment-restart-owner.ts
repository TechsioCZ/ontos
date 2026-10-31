import { Effect, Option } from 'effect';
import type { EnrollmentAttemptSnapshot } from '../../../shared/enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerEffect } from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../orchestration/owner-transition-production.ts';
import { decodeOwnerOutcome, decodeOwnerResolution, ownerUnavailable } from '../orchestration/owner-effect-codec.ts';
import { readRetailEnrollmentRestartContext } from './retail-enrollment-restart.ts';
import { retailSelfEnrollmentEvidenceReference } from './retail-self-enrollment-contracts.ts';

/** A new, honest native proof transition. It never copies or replays a predecessor owner operation. */
export const retailEnrollmentRetainedResultsOwnerEffect = (
  run: CommerceEnrollmentOwnerTransactionRun,
  attempt: EnrollmentAttemptSnapshot,
): CommerceEnrollmentOwnerEffect => {
  const verify = Effect.suspend(() =>
    attempt.targetLegalEntityId === undefined
      ? Effect.fail(ownerUnavailable('retail_restart_proof_unavailable', 'The selling Legal Entity is missing'))
      : run({ legalEntityId: attempt.targetLegalEntityId, tenantId: attempt.tenantId }, (transaction) =>
          readRetailEnrollmentRestartContext(transaction, attempt.portalEnrollmentAttemptId, false),
        ).pipe(
          Effect.mapError((cause) => ownerUnavailable('retail_restart_proof_unavailable', cause.reason, cause)),
          Effect.flatMap((proof) =>
            Option.isSome(proof)
              ? Effect.succeed(proof.value.sourceAttemptId)
              : Effect.fail(
                  ownerUnavailable('retail_restart_proof_unavailable', 'The native predecessor proof is invalid'),
                ),
          ),
        ),
  );
  return {
    dispatch: () =>
      verify.pipe(
        Effect.flatMap((resultReference) =>
          decodeOwnerOutcome(
            {
              outcomeCode: 'retail_enrollment_results_retained',
              resultReference,
              status: 'SUCCEEDED',
            },
            'retail_restart_proof_unavailable',
            'The native retention outcome is invalid',
          ),
        ),
      ),
    reconcile: (input) =>
      verify.pipe(
        Effect.flatMap((resultReference) =>
          decodeOwnerResolution(
            {
              actorPrincipalId: input.actorPrincipalId,
              outcomeCode: 'retail_enrollment_results_retained',
              reconciliationRef: retailSelfEnrollmentEvidenceReference([
                'retail-enrollment-retained',
                input.ownerInvocationId,
                resultReference,
              ]),
              resultReference,
              status: 'SUCCEEDED',
            },
            'retail_restart_proof_unavailable',
            'The native retention reconciliation is invalid',
          ),
        ),
      ),
  };
};
