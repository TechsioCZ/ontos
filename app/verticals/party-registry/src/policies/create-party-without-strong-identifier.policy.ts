import { Effect, Schema } from 'effect';

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

const CreateWithoutStrongIdentifierPolicyConfigurationSchema = Schema.Struct({
  requireIdentityReview: Schema.Boolean,
});
export type CreateWithoutStrongIdentifierPolicyConfiguration =
  typeof CreateWithoutStrongIdentifierPolicyConfigurationSchema.Type;

const subjectEvidenceReason = (
  evidence: NonNullable<PartyCandidate['subjectEvidence']>
) => {
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
  candidate: Pick<PartyCandidate, 'partyType' | 'subjectEvidence'>
): PartyEvidenceEvaluation => {
  const evidence = candidate.subjectEvidence ?? [];
  let reasonCode: string = subjectEvidenceReason(evidence);
  const subjectEligible = reasonCode === 'proven_concrete_subject';
  const typeSupported =
    subjectEligible &&
    (candidate.partyType === 'UNRESOLVED' ||
      evidence.some(
        ({ observedSubject }) => observedSubject === candidate.partyType
      ));
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

const CreateWithoutStrongIdentifierDecisionSchema = Schema.Union([
  Schema.Struct({
    decision: Schema.Literal('ALLOW'),
    reasonCode: Schema.Literal('proven_concrete_subject'),
  }),
  Schema.Struct({
    decision: Schema.Literal('REVIEW_REQUIRED'),
    reasonCode: Schema.Literal('identity_review_required'),
  }),
  Schema.Struct({
    decision: Schema.Literal('DENY'),
    reasonCode: Schema.String,
  }),
]);
export type CreateWithoutStrongIdentifierDecision =
  typeof CreateWithoutStrongIdentifierDecisionSchema.Type;
export const decideCreateWithoutStrongIdentifier = (
  candidate: PartyCandidate,
  configuration: CreateWithoutStrongIdentifierPolicyConfiguration
): CreateWithoutStrongIdentifierDecision => {
  const evaluation = evaluatePartySubjectEvidence(candidate);
  if (!evaluation.subjectEligible || !evaluation.typeSupported) {
    return { decision: 'DENY', reasonCode: evaluation.reasonCode };
  }
  return configuration.requireIdentityReview
    ? { decision: 'REVIEW_REQUIRED', reasonCode: 'identity_review_required' }
    : { decision: 'ALLOW', reasonCode: 'proven_concrete_subject' };
};

export const requirePartySubjectEvidence = (
  candidate: Pick<PartyCandidate, 'partyType' | 'subjectEvidence'>
): Effect.Effect<PartyEvidenceEvaluation, PartyEvidenceInsufficientError> => {
  const evaluation = evaluatePartySubjectEvidence(candidate);
  return evaluation.subjectEligible && evaluation.typeSupported
    ? Effect.succeed(evaluation)
    : Effect.fail(
        new PartyEvidenceInsufficient({
          code: 'party_evidence_insufficient',
          reason: evaluation.reasonCode,
        })
      );
};
