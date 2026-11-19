import { Option } from 'effect';

import type { PrivacyAssessmentCase } from '../../../src/domain/privacy/assess-privacy.ts';
import { PrivacyAssessment } from '../../../src/domain/privacy/assess-privacy.ts';
import { ProcessingEligibilityVerdict } from '../../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityVerdictCase } from '../../../src/domain/privacy/eligibility-gate.ts';
import { RecoveryAdmission, RequiredHandoffOutcome } from '../../../src/domain/privacy/handoff-decision.ts';
import type {
  RecoveryAdmissionCase,
  RequiredHandoffOutcomeCase,
} from '../../../src/domain/privacy/handoff-decision.ts';
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

export const requiredSummary = (outcome: RequiredHandoffOutcomeCase) =>
  RequiredHandoffOutcome.$match(outcome, {
    Failed: ({ partial, reconciliation, sourceImpact, stopped }) => ({
      kind: 'Failed' as const,
      partial,
      reconciliation: reconciliation.map(({ recipient }) => recipient.resourceId),
      sourceImpact,
      stopped: stopped.map(({ identity, primary }) => ({
        category: primary.category,
        recipient: identity.recipient.resourceId,
      })),
    }),
    NotRequired: () => ({ kind: 'NotRequired' as const }),
    Ready: ({ identities }) => ({
      kind: 'Ready' as const,
      recipients: identities.map(({ recipient }) => recipient.resourceId),
    }),
    SourceStale: () => ({ kind: 'SourceStale' as const }),
  });

export const recoverySummary = (admission: RecoveryAdmissionCase) =>
  RecoveryAdmission.$match(admission, {
    Admitted: () => ({ kind: 'Admitted' as const }),
    Refused: ({ reason }) => ({ kind: 'Refused' as const, reason }),
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
    Suppressed: ({ evidence }) =>
      Option.match(evidence.privacy, {
        onNone: () => [],
        onSome: (assessment) => reasonCodesOf(assessment),
      }),
  });
