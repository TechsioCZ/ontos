import { Schema } from 'effect';

import { ProcessingEligibilityVerdict } from './eligibility-gate.ts';
import type { EligibilityEvidence, ProcessingEligibilityVerdictCase } from './eligibility-gate.ts';
import {
  PrivacyPurposeVersionIdSchema,
  PrivacyScopeIdSchema,
  PrivacySubjectResourceIdSchema,
} from './processing-scope.ts';

/**
 * Anti-corruption mapping of the Privacy owner's PUBLIC source-processing response (`DENIED | ALLOWED`, #1396) onto
 * the Communications vocabulary. It is structural, so the composition (d21-07) decodes the owner's response with the
 * owner's own published schema and hands the value here; this domain imports no other deployment. Privacy's
 * `evaluatedScope.subjectRef` is a reference object; only its resource id is kept, as an opaque reference.
 */
const OwnerEvidenceSchema = Schema.Struct({
  authoritativeReferences: Schema.Array(
    Schema.Struct({ kind: Schema.String, reference: Schema.String, revision: Schema.String }),
  ),
  evaluatedScope: Schema.Struct({
    controllerRef: Schema.String,
    dataCategoryRefs: Schema.Array(Schema.String),
    operation: Schema.String,
    processingScopeRef: Schema.Struct({ scopeId: PrivacyScopeIdSchema, scopeType: Schema.String }),
    purposeRef: Schema.String,
    purposeVersionId: PrivacyPurposeVersionIdSchema,
    recipientRefs: Schema.Array(Schema.String),
    subjectRef: Schema.Struct({ resourceId: PrivacySubjectResourceIdSchema }),
  }),
  outcome: Schema.Literals(['ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE']),
  policyRevisions: Schema.Array(Schema.Struct({ policyRef: Schema.String, revision: Schema.String })),
  reasonCodes: Schema.Array(Schema.String),
  trustedDecisionTime: Schema.DateTimeUtcFromString,
});
type OwnerEvidence = typeof OwnerEvidenceSchema.Type;

export const PrivacySourceEligibilityResponseSchema = Schema.Union([
  Schema.Struct({
    eligibility: Schema.optionalKey(
      Schema.Struct({ evidence: OwnerEvidenceSchema, outcome: Schema.Literals(['NOT_ALLOWED', 'INDETERMINATE']) }),
    ),
    evaluatedAt: Schema.DateTimeUtcFromString,
    outcome: Schema.Literal('DENIED'),
    reason: Schema.Literals(['AUTHORITY_NOT_CURRENT', 'PROCESSING_NOT_ALLOWED', 'PROTECTED_MATERIAL']),
  }),
  Schema.Struct({
    evaluatedAt: Schema.DateTimeUtcFromString,
    evidence: OwnerEvidenceSchema,
    outcome: Schema.Literal('ALLOWED'),
  }),
]);
export type PrivacySourceEligibilityResponse = typeof PrivacySourceEligibilityResponseSchema.Type;

const safeEvidenceOf = (evidence: OwnerEvidence): EligibilityEvidence => ({
  authoritativeReferences: evidence.authoritativeReferences,
  evaluatedScope: {
    controllerRef: evidence.evaluatedScope.controllerRef,
    dataCategoryRefs: evidence.evaluatedScope.dataCategoryRefs,
    operation: evidence.evaluatedScope.operation,
    privacySubjectRef: evidence.evaluatedScope.subjectRef.resourceId,
    processingScopeRef: evidence.evaluatedScope.processingScopeRef,
    purposeRef: evidence.evaluatedScope.purposeRef,
    purposeVersionId: evidence.evaluatedScope.purposeVersionId,
    recipientRefs: evidence.evaluatedScope.recipientRefs,
  },
  policyRevisions: evidence.policyRevisions,
  reasonCodes: evidence.reasonCodes,
  trustedDecisionTime: evidence.trustedDecisionTime,
});

const inconsistent = (evidence: OwnerEvidence) =>
  ProcessingEligibilityVerdict.Indeterminate({ cause: 'EVIDENCE_INCONSISTENT', evidence: safeEvidenceOf(evidence) });

/**
 * The three owner results, each only on matching owner evidence:
 * - ALLOWED needs evidence that itself says ALLOWED;
 * - a non-allowed evaluation is NOT_ALLOWED or INDETERMINATE exactly as the owner's evidence says, and a denial that
 *   carries no evidence of an evaluation is never a prohibition (`EVIDENCE_MISSING`);
 * - a recorded protection is a prohibition on the owner's own named basis;
 * - no exact current Privacy context means nothing was evaluated (`CONTEXT_NOT_SUPPORTED`).
 */
export const eligibilityVerdictOf = (response: PrivacySourceEligibilityResponse): ProcessingEligibilityVerdictCase => {
  if (response.outcome === 'ALLOWED') {
    return response.evidence.outcome === 'ALLOWED'
      ? ProcessingEligibilityVerdict.Allowed({ evidence: safeEvidenceOf(response.evidence) })
      : inconsistent(response.evidence);
  }
  if (response.reason === 'AUTHORITY_NOT_CURRENT') {
    return ProcessingEligibilityVerdict.Indeterminate({ cause: 'CONTEXT_NOT_SUPPORTED' });
  }
  if (response.reason === 'PROTECTED_MATERIAL') {
    return ProcessingEligibilityVerdict.NotAllowed({ basis: 'PROTECTED_MATERIAL' });
  }
  const { eligibility } = response;
  if (eligibility === undefined) {
    return ProcessingEligibilityVerdict.Indeterminate({ cause: 'EVIDENCE_MISSING' });
  }
  if (eligibility.evidence.outcome !== eligibility.outcome) {
    return inconsistent(eligibility.evidence);
  }
  return eligibility.outcome === 'NOT_ALLOWED'
    ? ProcessingEligibilityVerdict.NotAllowed({
        basis: 'EVALUATED_PROHIBITION',
        evidence: safeEvidenceOf(eligibility.evidence),
      })
    : ProcessingEligibilityVerdict.Indeterminate({
        cause: 'INPUTS_NOT_EVIDENCED',
        evidence: safeEvidenceOf(eligibility.evidence),
      });
};
