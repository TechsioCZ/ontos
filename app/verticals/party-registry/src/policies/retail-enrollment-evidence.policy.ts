import type { RetailEnrollmentEvidence } from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { evaluatePartySubjectEvidence } from './create-party-without-strong-identifier.policy.ts';

export const RETAIL_ENROLLMENT_EVIDENCE_POLICY = 'party.retail-verified-enrollment.v1';

/** Only the dedicated, explicitly granted owner Action can submit this attestation. */
export const acceptsRetailEnrollmentEvidence = (
  candidate: PartyCandidate,
  evidence: RetailEnrollmentEvidence,
  scope: { readonly legalEntityId?: string; readonly tenantId: string },
  candidatePartyIds: readonly string[],
): boolean => {
  const evaluation = evaluatePartySubjectEvidence(candidate);
  return (
    candidate.partyType === 'PERSON' &&
    evaluation.subjectEligible &&
    evaluation.typeSupported &&
    candidatePartyIds.length === 0 &&
    evidence.emailOwnership === 'VERIFIED' &&
    ['RETAIL_SELF_ENROLLMENT', 'EXISTING_ACCOUNT'].includes(evidence.journey) &&
    evidence.tenantId === scope.tenantId &&
    evidence.sellingLegalEntityId === scope.legalEntityId &&
    candidate.evidenceRefs.includes(evidence.candidateEvidenceRef) &&
    candidate.provenance.source === 'commerce.customer-context' &&
    candidate.provenance.method === 'commerce.portal-enrollment.self-enrollment' &&
    candidate.subjectEvidence?.every((item) => item.subjectKey === evidence.providerSubjectId) === true
  );
};
