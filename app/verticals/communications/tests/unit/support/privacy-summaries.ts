import type { PrivacyAssessmentCase } from '../../../src/domain/privacy/assess-privacy.ts';
import { PrivacyAssessment } from '../../../src/domain/privacy/assess-privacy.ts';
import { ProcessingEligibilityVerdict } from '../../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityVerdictCase } from '../../../src/domain/privacy/eligibility-gate.ts';
import { MessageHandoffDecision } from '../../../src/domain/privacy/suppression.ts';
import type { MessageHandoffDecisionCase } from '../../../src/domain/privacy/suppression.ts';

/** Plain, tag-free views of Privacy results so tests can assert them structurally without hand-written case analysis. */

export const assessmentSummary = (assessment: PrivacyAssessmentCase) =>
  PrivacyAssessment.$match(assessment, {
    Allowed: () => ({ kind: 'Allowed' as const }),
    Indeterminate: ({ cause }) => ({ cause, kind: 'Indeterminate' as const }),
    NotAllowed: ({ basis, evidence }) => ({
      basis,
      kind: 'NotAllowed' as const,
      reasonCodes: evidence === undefined ? [] : evidence.reasonCodes,
    }),
    Unavailable: ({ reason }) => ({ kind: 'Unavailable' as const, reason }),
  });

export const verdictSummary = (verdict: ProcessingEligibilityVerdictCase) =>
  ProcessingEligibilityVerdict.$match(verdict, {
    Allowed: () => ({ kind: 'Allowed' as const }),
    Indeterminate: ({ cause }) => ({ cause, kind: 'Indeterminate' as const }),
    NotAllowed: ({ basis }) => ({ basis, kind: 'NotAllowed' as const }),
  });

const reasonCodesOf = (assessment: PrivacyAssessmentCase): readonly string[] =>
  PrivacyAssessment.$match(assessment, {
    Allowed: () => [],
    Indeterminate: () => [],
    NotAllowed: ({ evidence }) => (evidence === undefined ? [] : evidence.reasonCodes),
    Unavailable: () => [],
  });

/** The owner's blocking facts recorded with a stop, so a test can prove the evidence reference is kept. */
export const blockingFactsOf = (decision: MessageHandoffDecisionCase): readonly string[] =>
  MessageHandoffDecision.$match(decision, {
    AlreadyHandedOff: () => [],
    Proceed: () => [],
    ReconciliationRequired: () => [],
    Suppressed: ({ evidence }) => reasonCodesOf(evidence.privacy),
  });
