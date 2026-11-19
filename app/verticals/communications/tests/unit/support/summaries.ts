import { Option } from 'effect';

import { CommunicationOutcome, RecipientDecision } from '../../../src/domain/catalog/decision.ts';
import type { CommunicationDecision, MessageIntentCandidate } from '../../../src/domain/catalog/decision.ts';
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
  });
