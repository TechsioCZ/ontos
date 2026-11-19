import { Data, DateTime, Effect, Schema } from 'effect';

import { isGroupComplete } from '../catalog/audience.ts';
import type { GroupMember } from '../catalog/audience.ts';
import type { MessageIntentIdentity } from '../catalog/decision.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import { bindRecipient } from './bind-original-recipients.ts';
import { checkBoundRecipient, evaluatedRecipientOf, GATE_CONCURRENCY } from './assess-recipients.ts';
import type { EvaluatedRecipient, RecipientEvaluationInput } from './assess-recipients.ts';
import type { OriginalRecipientBinding, ProtectedEndpoint } from './original-binding.ts';
import { RecipientAssessment } from './recipient-assessment.ts';
import type { RecipientAssessmentCase } from './recipient-assessment.ts';
import { groupStoppedEvidenceOf } from './recipient-evidence.ts';
import type { RecipientEvidence } from './recipient-evidence.ts';

/**
 * Last stoppable handoff recheck (#1395, BR-03, BR-07, AC-08). Before an intent is handed off, its ORIGINAL
 * recipient and endpoint are checked against the owners again, per recipient. An approved indivisible audience then
 * holds together: if one required member cannot proceed, no stoppable member is handed off. A member already proven
 * handed off is never "undone": it is kept as it happened and flagged for truthful reconciliation (step 22/#1402).
 */

/** Whether the intent can still be stopped. Provider acceptance proves a handoff happened, nothing more. */
export const HandoffStateSchema = Schema.Literals(['PROVEN_HANDED_OFF', 'STOPPABLE']);
export type HandoffState = typeof HandoffStateSchema.Type;

export interface HandoffCandidate {
  /** The original binding the intent was decided under; a retry never swaps it for another. */
  readonly binding: OriginalRecipientBinding;
  readonly handoff: HandoffState;
  readonly identity: MessageIntentIdentity;
}

export type HandoffVerdictCase = Data.TaggedEnum<{
  /** Already handed off before this check. The effect is preserved; `reconciliationRequired` marks a broken group. */
  AlreadyHandedOff: { readonly identity: MessageIntentIdentity; readonly reconciliationRequired: boolean };
  /** Individually allowed, but its approved indivisible group cannot complete, so nothing is handed off. */
  GroupStopped: { readonly evidence: RecipientEvidence; readonly identity: MessageIntentIdentity };
  /** The original endpoint may be handed off now. `endpoint` is protected and never stored. */
  Proceed: {
    readonly endpoint: ProtectedEndpoint;
    readonly evidence: RecipientEvidence;
    readonly identity: MessageIntentIdentity;
  };
  /** The recipient is not allowed, unresolved or unavailable; the concrete message stops with that truthful reason. */
  Stopped: {
    readonly assessment: Exclude<RecipientAssessmentCase, { readonly _tag: 'RecipientAllowed' }>;
    readonly evidence: RecipientEvidence;
    readonly identity: MessageIntentIdentity;
  };
}>;
export const HandoffVerdict = Data.taggedEnum<HandoffVerdictCase>();

const belongsToRequest = (candidate: HandoffCandidate, input: RecipientEvaluationInput) => {
  const { identity } = candidate;
  return (
    identity.tenantId === input.request.tenantId &&
    identity.occurrenceId === input.request.occurrence.occurrenceId &&
    identity.revision === input.request.occurrence.revision &&
    identity.sourceModule === input.request.source.moduleKey &&
    identity.typeId === input.type.typeId &&
    resourceRefKey(identity.recipient) === resourceRefKey(candidate.binding.recipientRef)
  );
};

/** A candidate whose intent, binding and request no longer agree is stopped, never re-addressed. */
const identityChanged = (candidate: HandoffCandidate) =>
  RecipientAssessment.RecipientNotAllowed({
    reason: 'RECIPIENT_IDENTITY_CHANGED',
    subject: { binding: candidate.binding, slotKey: candidate.identity.slotKey },
  });

const assessCandidate = (candidate: HandoffCandidate, input: RecipientEvaluationInput) => {
  const slot =
    input.type.result.kind === 'MESSAGE_INTENTS'
      ? input.type.result.slots.find(({ slotKey }) => slotKey === candidate.identity.slotKey)
      : undefined;
  if (slot === undefined || !belongsToRequest(candidate, input)) {
    return Effect.succeed(identityChanged(candidate));
  }
  const stage = bindRecipient(slot, input.scope, [candidate.binding]);
  return stage.kind === 'settled' ? Effect.succeed(stage.assessment) : checkBoundRecipient(input, stage);
};

const isAllowed = (evaluated: EvaluatedRecipient | undefined) =>
  evaluated !== undefined && RecipientAssessment.$is('RecipientAllowed')(evaluated.assessment);

const verdictOf = (
  candidate: HandoffCandidate,
  { assessment, evidence }: EvaluatedRecipient,
  groupComplete: boolean,
): HandoffVerdictCase => {
  const { identity } = candidate;
  if (!RecipientAssessment.$is('RecipientAllowed')(assessment)) {
    return HandoffVerdict.Stopped({ assessment, evidence, identity });
  }
  return groupComplete
    ? HandoffVerdict.Proceed({ endpoint: assessment.endpoint, evidence, identity })
    : HandoffVerdict.GroupStopped({ evidence: groupStoppedEvidenceOf(evidence), identity });
};

/**
 * Re-check every stoppable candidate against the owners' Current facts, individually, then apply the approved
 * audience rule. Candidates already proven handed off are not asked again. Verdicts keep the input order. Never fails:
 * an unreachable authority is a Stopped verdict, so no stale permission can let a handoff through.
 */
export const recheckBeforeHandoff = Effect.fn('Communications.recheckBeforeHandoff')(function* recheckAll(
  input: RecipientEvaluationInput,
  candidates: readonly HandoffCandidate[],
) {
  const evaluatedAt = yield* DateTime.now;
  const evaluated = yield* Effect.forEach(
    candidates,
    (candidate) =>
      candidate.handoff === 'PROVEN_HANDED_OFF'
        ? Effect.undefined
        : assessCandidate(candidate, input).pipe(
            Effect.map((assessment) => evaluatedRecipientOf(input, evaluatedAt, assessment)),
          ),
    { concurrency: GATE_CONCURRENCY },
  );
  const members = candidates.map((candidate, index): GroupMember => ({
    ready: candidate.handoff === 'PROVEN_HANDED_OFF' || isAllowed(evaluated[index]),
    slotKey: candidate.identity.slotKey,
  }));
  const groupComplete = isGroupComplete(input.type.audience, members);
  return candidates.map((candidate, index): HandoffVerdictCase => {
    const result = evaluated[index];
    return result === undefined
      ? HandoffVerdict.AlreadyHandedOff({ identity: candidate.identity, reconciliationRequired: !groupComplete })
      : verdictOf(candidate, result, groupComplete);
  });
});
