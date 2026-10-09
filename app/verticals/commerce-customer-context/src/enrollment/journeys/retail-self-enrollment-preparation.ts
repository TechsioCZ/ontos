import type { PartyRef } from '@app/party-registry/resources/party';
import { Effect, Option, Schema } from 'effect';

import type { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import { EnrollmentEvidenceReferenceSchema } from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptIdSchema } from '../../../shared/enrollment-contracts.ts';
import type { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import {
  ownerPreparationDenied as denied,
  ownerPreparationNotApplicable as notApplicable,
  ownerPreparationUnavailable as unavailable,
} from '../orchestration/prepared-owner-authority.ts';
import type {
  CommerceEnrollmentOwnerTransitionPreparationResult,
  CommerceEnrollmentPreparedOwnerBinding,
} from '../orchestration/prepared-owner-authority.ts';
import type { JourneyTransitionSpec } from './journey-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  retailSelfEnrollmentEvidenceReference,
  retailSelfEnrollmentRequestDigest,
} from './retail-self-enrollment-contracts.ts';
import type { RetailSelfEnrollmentStepIntent } from './retail-self-enrollment-contracts.ts';

/**
 * Preparation for one declared Retail self-enrollment transition.
 *
 * A step vouches for exactly one `(ownerModuleKey, transitionKey)` pair and only when the claimed
 * request digest is the digest this journey derives from its own trusted subject.  A caller can
 * therefore not present a digest of its own choosing, claim a transition the journey does not
 * declare, or reuse another Attempt's preparation: anything that does not bind exactly is denied,
 * and a subject the journey cannot yet vouch for is `not_applicable` rather than allowed.
 */

export interface RetailSelfEnrollmentPreparationSubject {
  readonly partyCandidateDigest: string;
  /** Known only after the Party Registry transition has durably resolved an exact Party. */
  readonly partyRef: Option.Option<PartyRef>;
  readonly portalEnrollmentAttemptId: typeof EnrollmentAttemptIdSchema.Type;
  readonly principalRef: typeof RetailPortalPrincipalRefSchema.Type;
  readonly sellingLegalEntityRef: typeof SellingLegalEntityRefSchema.Type;
}

const intentFor = (
  subject: RetailSelfEnrollmentPreparationSubject,
  step: JourneyTransitionSpec,
): RetailSelfEnrollmentStepIntent | null => {
  const { partyRef } = subject;
  if (step.transitionKey === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY) {
    return {
      partyCandidateDigest: subject.partyCandidateDigest,
      sellingLegalEntityRef: subject.sellingLegalEntityRef,
      step: 'PARTY_CANDIDATE',
    };
  }
  if (step.transitionKey === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY) {
    return Option.isNone(partyRef)
      ? null
      : {
          partyRef: partyRef.value,
          sellingLegalEntityRef: subject.sellingLegalEntityRef,
          step: 'RETAIL_CUSTOMER_PROFILE',
        };
  }
  if (step.transitionKey === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY) {
    return Option.isNone(partyRef)
      ? null
      : {
          partyRef: partyRef.value,
          principalRef: subject.principalRef,
          sellingLegalEntityRef: subject.sellingLegalEntityRef,
          step: 'RETAIL_PORTAL_BINDING',
        };
  }
  return { sellingLegalEntityRef: subject.sellingLegalEntityRef, step: 'PORTAL_ACCOUNT' };
};

export const retailSelfEnrollmentPrepareStep = (
  subject: RetailSelfEnrollmentPreparationSubject,
  step: JourneyTransitionSpec,
  binding: CommerceEnrollmentPreparedOwnerBinding,
): Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult> => {
  if (
    binding.ownerModuleKey !== step.ownerModuleKey ||
    binding.transitionKey !== step.transitionKey ||
    binding.portalEnrollmentAttemptId !== subject.portalEnrollmentAttemptId
  ) {
    return Effect.succeed(denied);
  }
  const intent = intentFor(subject, step);
  if (intent === null) {
    return Effect.succeed(notApplicable);
  }
  const expectedDigest = retailSelfEnrollmentRequestDigest({
    intent,
    ownerModuleKey: step.ownerModuleKey,
    portalEnrollmentAttemptId: subject.portalEnrollmentAttemptId,
    transitionKey: step.transitionKey,
  });
  if (binding.requestDigest !== undefined && binding.requestDigest !== expectedDigest) {
    return Effect.succeed(denied);
  }
  const reference = retailSelfEnrollmentEvidenceReference([
    'retail-self-enrollment',
    binding.ownerModuleKey,
    binding.transitionKey,
    binding.portalEnrollmentAttemptId,
    binding.actionInvocationId,
    binding.ownerInvocationId,
    String(binding.expectedRevision),
    expectedDigest,
  ]);
  return Schema.decodeEffect(EnrollmentEvidenceReferenceSchema)(reference).pipe(
    Effect.matchEffect({
      // A derived reference can only fail to decode if this module produced a malformed UUID. The
      // failure is preserved in the log and preparation fails closed rather than vouching for the
      // transition on evidence it could not name.
      onFailure: (error) =>
        Effect.annotateLogs(
          Effect.logDebug('Retail self-enrollment preparation could not name an evidence reference'),
          { cause: error.message, transitionKey: step.transitionKey },
        ).pipe(Effect.as(unavailable)),
      onSuccess: (evidenceRef) =>
        Effect.succeed<CommerceEnrollmentOwnerTransitionPreparationResult>({ evidenceRef, outcome: 'prepared' }),
    }),
  );
};
