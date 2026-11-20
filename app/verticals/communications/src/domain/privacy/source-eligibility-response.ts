import { Schema } from 'effect';

import { DECLARED_NOT_ECHOED, ProcessingEligibilityVerdict } from './eligibility-gate.ts';
import type { UnavailableReason } from './eligibility-errors.ts';
import type { EligibilityEvidence, ProcessingEligibilityVerdictCase } from './eligibility-gate.ts';
import {
  PrivacyPurposeVersionIdSchema,
  PrivacyScopeIdSchema,
  PrivacySubjectResourceIdSchema,
} from './processing-scope.ts';
import type { ProcessingScope } from './processing-scope.ts';

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

/** Why the owner evaluated nothing; the safe discriminator only the Communications consumer receives. */
const NotEvaluatedCauseSchema = Schema.Literals([
  'NO_CONTEXT',
  'MULTIPLE_CONTEXTS',
  'CONTEXT_NOT_CURRENT',
  'PURPOSE_NOT_CURRENT',
  'APPLICABILITY_NOT_CURRENT',
  'SUBJECT_NOT_FOUND',
]);

export const PrivacySourceEligibilityResponseSchema = Schema.Union([
  Schema.Struct({
    eligibility: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({ evidence: OwnerEvidenceSchema, outcome: Schema.Literals(['NOT_ALLOWED', 'INDETERMINATE']) }),
        Schema.Struct({ outcome: Schema.Literal('NOT_EVALUATED'), reasonCode: NotEvaluatedCauseSchema }),
      ]),
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

/**
 * `sent` is the scope the adapter actually put to the owner for THIS response. Privacy's published request and scope
 * carry no channel, no catalog purpose key and no subject locator, so the owner can echo none of them: they are filed
 * under `declaredScope` as `DECLARED_NOT_ECHOED` (the adapter's own binding), never as part of what Privacy evaluated.
 */
const safeEvidenceOf = (evidence: OwnerEvidence, sent: ProcessingScope): EligibilityEvidence => ({
  authoritativeReferences: evidence.authoritativeReferences,
  declaredScope: {
    basis: DECLARED_NOT_ECHOED,
    catalogPurposeRef: sent.catalogPurposeRef,
    channel: sent.channel,
    subject: sent.subject,
  },
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

const inconsistent = (evidence: OwnerEvidence, sent: ProcessingScope) =>
  ProcessingEligibilityVerdict.Indeterminate({
    cause: 'EVIDENCE_INCONSISTENT',
    evidence: safeEvidenceOf(evidence, sent),
  });

/**
 * The owner results, each only on matching owner evidence:
 * - ALLOWED needs evidence that itself says ALLOWED;
 * - a non-allowed evaluation is NOT_ALLOWED or INDETERMINATE exactly as the owner's evidence says, and a denial that
 *   carries no evidence of an evaluation is never a prohibition (`EVIDENCE_MISSING`);
 * - an owner that says it evaluated nothing names why: no exact context (`CONTEXT_NOT_SUPPORTED`), several contexts
 *   (`CONTEXT_AMBIGUOUS`) or an absent or retired purpose (`PURPOSE_NOT_CURRENT`); without that discriminator a missing
 *   context is `CONTEXT_NOT_SUPPORTED` and an unexplained denial is `EVIDENCE_MISSING`;
 * - a refusal as protected material has no evaluation evidence, so it is NOT a Privacy prohibition: it stops as its own
 *   `PROTECTED_MATERIAL` cause until the owner supplies evidence for it.
 */
export const eligibilityVerdictOf = (
  response: PrivacySourceEligibilityResponse,
  sent: ProcessingScope,
): ProcessingEligibilityVerdictCase => {
  if (response.outcome === 'ALLOWED') {
    return response.evidence.outcome === 'ALLOWED'
      ? ProcessingEligibilityVerdict.Allowed({ evidence: safeEvidenceOf(response.evidence, sent) })
      : inconsistent(response.evidence, sent);
  }
  const { eligibility } = response;
  if (eligibility?.outcome === 'NOT_EVALUATED') {
    if (eligibility.reasonCode === 'MULTIPLE_CONTEXTS') {
      return ProcessingEligibilityVerdict.Indeterminate({ cause: 'CONTEXT_AMBIGUOUS' });
    }
    return ProcessingEligibilityVerdict.Indeterminate({
      cause: eligibility.reasonCode === 'PURPOSE_NOT_CURRENT' ? 'PURPOSE_NOT_CURRENT' : 'CONTEXT_NOT_SUPPORTED',
    });
  }
  if (response.reason === 'AUTHORITY_NOT_CURRENT') {
    return ProcessingEligibilityVerdict.Indeterminate({ cause: 'CONTEXT_NOT_SUPPORTED' });
  }
  if (response.reason === 'PROTECTED_MATERIAL') {
    return ProcessingEligibilityVerdict.Indeterminate({ cause: 'PROTECTED_MATERIAL' });
  }
  if (eligibility === undefined) {
    return ProcessingEligibilityVerdict.Indeterminate({ cause: 'EVIDENCE_MISSING' });
  }
  if (eligibility.evidence.outcome !== eligibility.outcome) {
    return inconsistent(eligibility.evidence, sent);
  }
  return eligibility.outcome === 'NOT_ALLOWED'
    ? ProcessingEligibilityVerdict.NotAllowed({
        basis: 'EVALUATED_PROHIBITION',
        evidence: safeEvidenceOf(eligibility.evidence, sent),
      })
    : ProcessingEligibilityVerdict.Indeterminate({
        cause: 'INPUTS_NOT_EVIDENCED',
        evidence: safeEvidenceOf(eligibility.evidence, sent),
      });
};

/**
 * Why a Privacy Read produced no response at all, from the status of the owner's published problem. Only the owner
 * contract's authentication (401) and forbidden (403) problems say that this Principal may not read Privacy eligibility;
 * every other failure (unavailable authority, conflict, policy, internal, transport) says the owner did not decide.
 * Neither is ever a Privacy outcome.
 */
export const unavailableReasonOfOwnerProblem = (status: number): UnavailableReason =>
  status === 401 || status === 403 ? 'AUTHORIZATION_DENIED' : 'OWNER_UNAVAILABLE';
