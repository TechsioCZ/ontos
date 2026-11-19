import { Option, Redacted } from 'effect';

import { CommunicationOutcome, RecipientDecision } from '../../../src/domain/catalog/decision.ts';
import type { CommunicationDecision, MessageIntentCandidate } from '../../../src/domain/catalog/decision.ts';
import { HandoffVerdict } from '../../../src/domain/recipient/recheck-before-handoff.ts';
import type { HandoffVerdictCase } from '../../../src/domain/recipient/recheck-before-handoff.ts';
import type { EvaluatedRecipient } from '../../../src/domain/recipient/assess-recipients.ts';
import { RecipientAssessment } from '../../../src/domain/recipient/recipient-assessment.ts';
import type { RecipientAssessmentCase } from '../../../src/domain/recipient/recipient-assessment.ts';
import { RequiredCommunicationOutcome, RequiredFailureReason } from '../../../src/domain/catalog/required-outcome.ts';
import type { RequiredCommunicationOutcomeCase } from '../../../src/domain/catalog/required-outcome.ts';

/** Plain, tag-free views of decisions so tests can assert them structurally without hand-written case analysis. */

export const recipientSummary = (candidate: MessageIntentCandidate) =>
  RecipientDecision.$match(candidate.recipient, {
    Eligible: ({ ref, role }) => ({ kind: 'Eligible' as const, resourceId: ref.resourceId, role }),
    Suppressed: ({ reason, ref, role }) => ({ kind: 'Suppressed' as const, reason, resourceId: ref.resourceId, role }),
  });

export const candidatesOf = (decision: CommunicationDecision): readonly MessageIntentCandidate[] =>
  CommunicationOutcome.$match(decision.outcome, {
    Candidates: ({ candidates }) => candidates,
    NoMessage: () => [],
  });

export const outcomeSummary = (decision: CommunicationDecision) =>
  CommunicationOutcome.$match(decision.outcome, {
    Candidates: ({ candidates, unresolvedSlots }) => ({
      candidates: candidates.map(recipientSummary),
      kind: 'Candidates' as const,
      unresolvedSlots,
    }),
    NoMessage: ({ reason, ruleKey, unresolvedSlots }) => ({
      kind: 'NoMessage' as const,
      reason,
      ruleKey,
      unresolvedSlots,
    }),
  });

export const pinOf = (decision: CommunicationDecision) => Option.getOrUndefined(decision.type);

const reasonSummary = RequiredFailureReason.$match({
  CandidateSuppressed: ({ identity, reason }) => ({
    kind: 'CandidateSuppressed' as const,
    reason,
    slotKey: identity.slotKey,
  }),
  NoMessage: ({ reason }) => ({ kind: 'NoMessage' as const, reason }),
  SlotUnresolved: ({ reason, slotKey }) => ({ kind: 'SlotUnresolved' as const, reason, slotKey }),
});

export const requiredSummary = (outcome: RequiredCommunicationOutcomeCase) =>
  RequiredCommunicationOutcome.$match(outcome, {
    Failed: ({ partial, prepared, reasons, sourceImpact }) => ({
      kind: 'Failed' as const,
      partial,
      preparedSlots: prepared.map(({ slotKey }) => slotKey),
      reasons: reasons.map(reasonSummary),
      sourceImpact,
    }),
    NotRequired: () => ({ kind: 'NotRequired' as const }),
    Prepared: ({ prepared }) => ({ kind: 'Prepared' as const, preparedSlots: prepared.map(({ slotKey }) => slotKey) }),
    RequirednessUnknown: () => ({ kind: 'RequirednessUnknown' as const }),
    SourceStale: ({ reason }) => ({ kind: 'SourceStale' as const, reason }),
  });

/** Plain view of one recipient assessment: its business outcome, recipient id and reason, never the endpoint. */
export const assessmentSummary = (assessment: RecipientAssessmentCase) =>
  RecipientAssessment.$match(assessment, {
    RecipientAllowed: ({ subject }) => ({
      outcome: 'recipient-allowed' as const,
      recipient: subject.binding.recipientRef.resourceId,
    }),
    RecipientNotAllowed: ({ reason, subject }) => ({
      outcome: 'recipient-not-allowed' as const,
      reason,
      recipient: subject.binding.recipientRef.resourceId,
    }),
    RecipientUnresolved: ({ reason, subject }) => ({
      outcome: 'recipient-unresolved' as const,
      reason,
      recipient: subject.binding.recipientRef.resourceId,
    }),
    SourceUnavailable: ({ authority, subject }) => ({
      authority,
      outcome: 'source-unavailable' as const,
      recipient: subject.binding.recipientRef.resourceId,
    }),
  });

/**
 * The usable endpoint values of the allowed assessments, revealed only here in tests to prove which endpoint was kept.
 * Production code never unwraps it outside the handoff adapter.
 */
export const revealedAddresses = (evaluated: readonly EvaluatedRecipient[]) =>
  evaluated.flatMap(({ assessment }) =>
    RecipientAssessment.$match(assessment, {
      RecipientAllowed: ({ endpoint }) => [Redacted.value(endpoint.value)],
      RecipientNotAllowed: () => [],
      RecipientUnresolved: () => [],
      SourceUnavailable: () => [],
    }),
  );

/** Plain, tag-free view of one handoff verdict. A proceeding verdict reveals which endpoint it would hand off to. */
export const verdictSummary = (verdict: HandoffVerdictCase) =>
  HandoffVerdict.$match(verdict, {
    AlreadyHandedOff: ({ reconciliationRequired }) => ({ kind: 'AlreadyHandedOff' as const, reconciliationRequired }),
    GroupStopped: ({ evidence }) => ({ kind: 'GroupStopped' as const, reason: evidence.reason }),
    Proceed: ({ endpoint }) => ({ address: Redacted.value(endpoint.value), kind: 'Proceed' as const }),
    Stopped: ({ assessment }) => ({ assessment: assessmentSummary(assessment), kind: 'Stopped' as const }),
  });

export const verdictSummaries = (verdicts: readonly HandoffVerdictCase[]) => verdicts.map(verdictSummary);
