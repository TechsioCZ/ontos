import { Effect } from 'effect';

import {
  PartyDeclaredSubjectEligibilityVersion,
  PartyDeclaredTypeRuleVersion,
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
  if (subjects.size !== 1 || (subjects.has(undefined) && evidence.length > 1)) {
    return 'one_concrete_subject_required';
  }
  if (evidence.some((item) => item.kind === 'CLIENT_SOURCE_ASSERTION') && evidence.length !== 1) {
    return 'one_client_source_assertion_required';
  }
  if (kinds.has('PERSON') && kinds.has('ORGANIZATION')) {
    return 'conflicting_type_evidence';
  }
  return 'proven_concrete_subject';
};

type SubjectCandidate = Pick<PartyCandidate, 'partyType' | 'subjectEvidence'> &
  Partial<Pick<PartyCandidate, 'officialIdentifiers'>> & {
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly businessName?: string | null;
  };

const hasSupportedFact = (candidate: SubjectCandidate): boolean =>
  [candidate.firstName, candidate.lastName, candidate.businessName].some(
    (name) => name !== undefined && name !== null && name.trim().length > 0,
  ) || (candidate.officialIdentifiers?.length ?? 0) > 0;

/** Evidence of a concrete subject is eligibility to enter matching, never a matching result.
 * Keep the historical actor-only evaluation stable for existing decision fingerprints. */
export const evaluatePartySubjectEvidence = (candidate: SubjectCandidate): PartyEvidenceEvaluation => {
  const evidence = candidate.subjectEvidence ?? [];
  const declared = evidence.some((item) => item.kind !== 'ACTOR_ATTESTATION');
  let reasonCode: string = subjectEvidenceReason(evidence);
  if (reasonCode === 'proven_concrete_subject' && declared) {
    reasonCode = hasSupportedFact(candidate) ? 'declared_concrete_subject' : 'declared_identity_fact_required';
  }
  const subjectEligible = reasonCode === 'proven_concrete_subject' || reasonCode === 'declared_concrete_subject';
  const source = evidence.find((item) => item.kind === 'CLIENT_SOURCE_ASSERTION');
  const unresolvedSupported =
    candidate.partyType === 'UNRESOLVED' && (source === undefined || source.observedSubject === 'CONCRETE_SUBJECT');
  const typeSupported =
    subjectEligible &&
    (unresolvedSupported || evidence.some(({ observedSubject }) => observedSubject === candidate.partyType));
  if (subjectEligible && !typeSupported) {
    reasonCode = 'party_type_evidence_required';
  }
  return {
    evidence,
    reasonCode,
    subjectEligibilityVersion: declared ? PartyDeclaredSubjectEligibilityVersion : PartySubjectEligibilityVersion,
    subjectEligible,
    typeRuleVersion: declared ? PartyDeclaredTypeRuleVersion : PartyTypeRuleVersion,
    typeSupported,
  };
};

export const requirePartySubjectEvidence = (
  candidate: SubjectCandidate,
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
