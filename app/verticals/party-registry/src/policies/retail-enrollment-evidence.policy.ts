import type {
  RetailEnrollmentEvidence,
  RetailEnrollmentSubject,
} from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import { PartySubjectEligibilityVersion, PartyTypeRuleVersion } from '../../shared/domain/identity-contracts.ts';
import type { PartyCandidate, PartyEvidenceEvaluation } from '../../shared/domain/identity-contracts.ts';
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

/** The original native Create must first be proved committed and owned by the current caller. */
export const acceptsRetailEnrollmentDecision = (
  evaluation: PartyEvidenceEvaluation,
  evidence: RetailEnrollmentSubject,
  scope: { readonly legalEntityId?: string; readonly tenantId: string },
): boolean =>
  evaluation.subjectEligible &&
  evaluation.typeSupported &&
  evaluation.subjectEligibilityVersion === PartySubjectEligibilityVersion &&
  evaluation.typeRuleVersion === PartyTypeRuleVersion &&
  evaluation.sourceInputFingerprint === undefined &&
  scope.legalEntityId !== undefined &&
  evidence.tenantId === scope.tenantId &&
  evidence.sellingLegalEntityId === scope.legalEntityId &&
  evidence.authenticationNamespaceId === 'ontos.commerce.portal.better-auth.v1' &&
  ['RETAIL_SELF_ENROLLMENT', 'EXISTING_ACCOUNT'].includes(evidence.journey) &&
  evaluation.evidence.length > 0 &&
  evaluation.evidence.every(
    (item) =>
      item.kind === 'ACTOR_ATTESTATION' &&
      item.basis === 'DIRECT_INTERACTION' &&
      item.observedSubject === 'PERSON' &&
      item.guestBinding === undefined &&
      item.subjectKey === evidence.providerSubjectId &&
      item.evidenceRef === evidence.candidateEvidenceRef,
  );
