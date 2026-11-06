import { Effect } from 'effect';

import {
  PartySubjectEligibilityVersion,
  PartyEvidenceInsufficient,
  PartyTypeRuleVersion,
} from '../../shared/domain/identity-contracts.ts';
import type {
  PartyCandidate,
  PartyEvidenceEvaluation,
  PartyEvidenceInsufficientError,
} from '../../shared/domain/identity-contracts.ts';

const subjectEvidenceReason = (evidence: NonNullable<PartyCandidate['subjectEvidence']>) => {
  const subjects = new Set(evidence.map((item) => item.subjectKey));
  const kinds = new Set(evidence.map((item) => item.observedSubject));
  if (evidence.length === 0) {
    return 'subject_evidence_required';
  }
  if (kinds.has('MANAGED_LEGAL_ENTITY')) {
    return 'managed_legal_entity_forbidden';
  }
  if (kinds.has('TECHNICAL_RECORD')) {
    return 'technical_record_forbidden';
  }
  if (subjects.size !== 1) {
    return 'one_concrete_subject_required';
  }
  if (kinds.has('PERSON') && kinds.has('ORGANIZATION')) {
    return 'conflicting_type_evidence';
  }
  return 'proven_concrete_subject';
};

/** Evaluates explicit actor attestations. The owner Action, not a reference prefix or provider
 * label, records who accepted them. A review decision never bypasses subject/type evidence. */
export const evaluatePartySubjectEvidence = (
  candidate: Pick<PartyCandidate, 'partyType' | 'subjectEvidence'>,
): PartyEvidenceEvaluation => {
  const evidence = candidate.subjectEvidence ?? [];
  let reasonCode: string = subjectEvidenceReason(evidence);
  const subjectEligible = reasonCode === 'proven_concrete_subject';
  const typeSupported =
    subjectEligible &&
    (candidate.partyType === 'UNRESOLVED' ||
      evidence.some(({ observedSubject }) => observedSubject === candidate.partyType));
  if (subjectEligible && !typeSupported) {
    reasonCode = 'party_type_evidence_required';
  }
  return {
    evidence,
    reasonCode,
    subjectEligibilityVersion: PartySubjectEligibilityVersion,
    subjectEligible,
    typeRuleVersion: PartyTypeRuleVersion,
    typeSupported,
  };
};

export const requirePartySubjectEvidence = (
  candidate: Pick<PartyCandidate, 'partyType' | 'subjectEvidence'>,
): Effect.Effect<PartyEvidenceEvaluation, PartyEvidenceInsufficientError> => {
  const evaluation = evaluatePartySubjectEvidence(candidate);
  return evaluation.subjectEligible && evaluation.typeSupported
    ? Effect.succeed(evaluation)
    : Effect.fail(
        new PartyEvidenceInsufficient({
          code: 'party_evidence_insufficient',
          reason: evaluation.reasonCode,
        }),
      );
};

/** Guest-specific evidence requires an explicit binding accepted in the already trusted LE.
 * Unbound tenant-wide identity operations keep their original eligibility semantics. */
export const partyGuestBindingFailure = (
  candidate: Pick<PartyCandidate, 'subjectEvidence'>,
  scope: { readonly tenantId: string; readonly legalEntityId?: string },
): string | undefined => {
  const evidence = candidate.subjectEvidence ?? [];
  const bound = evidence.find((item) => item.guestBinding !== undefined)?.guestBinding;
  if (bound === undefined) {
    return undefined;
  }
  if (
    scope.legalEntityId === undefined ||
    bound.legalEntityRef.tenantId !== scope.tenantId ||
    bound.legalEntityRef.resourceId !== scope.legalEntityId
  ) {
    return 'guest_binding_requires_trusted_legal_entity';
  }
  if (
    evidence.some(
      ({ guestBinding }) =>
        guestBinding === undefined ||
        guestBinding.correlationRoot !== bound.correlationRoot ||
        guestBinding.legalEntityRef.tenantId !== scope.tenantId ||
        guestBinding.legalEntityRef.resourceId !== scope.legalEntityId,
    )
  ) {
    return 'guest_binding_requires_one_exact_context';
  }
  return undefined;
};
