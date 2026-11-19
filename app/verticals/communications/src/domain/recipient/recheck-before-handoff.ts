import { Data, DateTime, Effect, Schema } from 'effect';

import { isGroupComplete, isGroupMember } from '../catalog/audience.ts';
import type { GroupMember } from '../catalog/audience.ts';
import type { MessageIntentIdentity } from '../catalog/decision.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import type { RecipientRole } from '../catalog/vocabulary.ts';
import { bindRecipient, withoutContact } from './bind-original-recipients.ts';
import { checkBoundRecipient, evaluatedRecipientOf, GATE_CONCURRENCY } from './assess-recipients.ts';
import type { EvaluatedRecipient, RecipientEvaluationInput } from './assess-recipients.ts';
import { contactBindingKey } from './original-binding.ts';
import type { OriginalRecipientBinding, ProtectedEndpoint } from './original-binding.ts';
import { RecipientAssessment } from './recipient-assessment.ts';
import type { NotAllowedReason, RecipientAssessmentCase } from './recipient-assessment.ts';
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

/**
 * What the decision fixed about an intent, pinned so a recheck can prove nothing moved: the original contact binding
 * (reference and evidence, never an address) and the approved type revision the audience rule was decided under.
 */
export const HandoffContactKeySchema = Schema.String.pipe(Schema.brand('HandoffContactKey'));
export const HandoffPinSchema = Schema.Struct({ contactKey: HandoffContactKeySchema, typeRevision: Schema.Number });
export type HandoffPin = typeof HandoffPinSchema.Type;

export const handoffPinOf = (
  type: Pick<TransactionalMessageType, 'revision'>,
  binding: OriginalRecipientBinding,
): HandoffPin => ({
  contactKey: HandoffContactKeySchema.make(contactBindingKey(binding.originalContact)),
  typeRevision: type.revision,
});

export interface HandoffCandidate {
  /** The binding this retry carries. It must still equal the ORIGINAL binding of `RecipientEvaluationInput.bindings`. */
  readonly binding: OriginalRecipientBinding;
  readonly handoff: HandoffState;
  readonly identity: MessageIntentIdentity;
  readonly pin: HandoffPin;
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

/** A candidate that cannot be handed off for a fixed reason; its binding never echoes a contact nobody proved. */
const stoppedFor = (reason: NotAllowedReason, candidate: HandoffCandidate) =>
  RecipientAssessment.RecipientNotAllowed({
    reason,
    subject: { binding: withoutContact(candidate.binding), slotKey: candidate.identity.slotKey },
  });

const candidateKey = ({ identity }: HandoffCandidate) => `${identity.slotKey}|${resourceRefKey(identity.recipient)}`;

/**
 * Every binding the source originally sent for the candidate's recipient in its slot. The recheck is judged against
 * these, never against what the retry carries, so a retry can neither swap the contact nor drop an ambiguity.
 */
const originalsOf = (candidate: HandoffCandidate, role: RecipientRole, input: RecipientEvaluationInput) =>
  input.bindings.filter(
    ({ recipientRef, role: bindingRole }) =>
      bindingRole === role && resourceRefKey(recipientRef) === resourceRefKey(candidate.identity.recipient),
  );

const assessCandidate = (candidate: HandoffCandidate, input: RecipientEvaluationInput, duplicate: boolean) => {
  const slot =
    input.type.result.kind === 'MESSAGE_INTENTS'
      ? input.type.result.slots.find(({ slotKey }) => slotKey === candidate.identity.slotKey)
      : undefined;
  if (slot === undefined || !belongsToRequest(candidate, input)) {
    return Effect.succeed(stoppedFor('RECIPIENT_IDENTITY_CHANGED', candidate));
  }
  if (duplicate) {
    return Effect.succeed(stoppedFor('DUPLICATE_CANDIDATE', candidate));
  }
  if (candidate.pin.typeRevision !== input.type.revision) {
    return Effect.succeed(stoppedFor('TYPE_REVISION_CHANGED', candidate));
  }
  const [first, ...rest] = originalsOf(candidate, slot.recipientRole, input);
  if (first === undefined) {
    return Effect.succeed(stoppedFor('RECIPIENT_IDENTITY_CHANGED', candidate));
  }
  const stage = bindRecipient(slot, input.scope, [first, ...rest]);
  if (stage.kind === 'settled') {
    return Effect.succeed(stage.assessment);
  }
  const originalKey = contactBindingKey(stage.contact);
  return candidate.pin.contactKey === originalKey &&
    contactBindingKey(candidate.binding.originalContact) === originalKey
    ? checkBoundRecipient(input, stage)
    : Effect.succeed(
        RecipientAssessment.RecipientNotAllowed({ reason: 'ORIGINAL_CONTACT_CHANGED', subject: stage.subject }),
      );
};

const isAllowed = (evaluated: EvaluatedRecipient | undefined) =>
  evaluated !== undefined && RecipientAssessment.$is('RecipientAllowed')(evaluated.assessment);

/** The one place a group verdict is decided: only a member of an incomplete approved group is held back by it. */
const verdictOf = (
  candidate: HandoffCandidate,
  { assessment, evidence }: EvaluatedRecipient,
  groupHeld: boolean,
): HandoffVerdictCase => {
  const { identity } = candidate;
  if (!RecipientAssessment.$is('RecipientAllowed')(assessment)) {
    return HandoffVerdict.Stopped({ assessment, evidence, identity });
  }
  return groupHeld
    ? HandoffVerdict.GroupStopped({ evidence: groupStoppedEvidenceOf(evidence), identity })
    : HandoffVerdict.Proceed({ endpoint: assessment.endpoint, evidence, identity });
};

/**
 * Re-check every stoppable candidate against the owners' Current facts, individually, then apply the approved
 * audience rule to the members of its group only. Candidates already proven handed off are not asked again. A
 * candidate listed more than once is stopped in every stoppable copy. Verdicts keep the input order. Never fails:
 * an unreachable authority is a Stopped verdict, so no stale permission can let a handoff through.
 */
export const recheckBeforeHandoff = Effect.fn('Communications.recheckBeforeHandoff')(function* recheckAll(
  input: RecipientEvaluationInput,
  candidates: readonly HandoffCandidate[],
) {
  const evaluatedAt = yield* DateTime.now;
  const copies = Object.groupBy(candidates, candidateKey);
  const evaluated = yield* Effect.forEach(
    candidates,
    (candidate) =>
      candidate.handoff === 'PROVEN_HANDED_OFF'
        ? Effect.undefined
        : assessCandidate(candidate, input, (copies[candidateKey(candidate)]?.length ?? 0) > 1).pipe(
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
    const groupHeld = !groupComplete && isGroupMember(input.type.audience, candidate.identity.slotKey);
    return result === undefined
      ? HandoffVerdict.AlreadyHandedOff({ identity: candidate.identity, reconciliationRequired: groupHeld })
      : verdictOf(candidate, result, groupHeld);
  });
});
