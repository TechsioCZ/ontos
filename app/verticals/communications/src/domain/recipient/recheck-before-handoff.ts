import { Data, DateTime, Effect, Schema } from 'effect';

import { AudiencePolicySchema, isGroupComplete, isGroupMember } from '../catalog/audience.ts';
import type { AudiencePolicy, GroupMember } from '../catalog/audience.ts';
import type { MessageIntentIdentity } from '../catalog/decision.ts';
import { AudienceSlotSchema } from '../catalog/message-type.ts';
import type { AudienceSlot, TransactionalMessageType } from '../catalog/message-type.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import type { RecipientRole } from '../catalog/vocabulary.ts';
import { bindRecipient, withoutContact } from './bind-original-recipients.ts';
import { checkBoundRecipient, evaluatedRecipientOf, GATE_CONCURRENCY } from './assess-recipients.ts';
import type { RecipientCurrentGate } from './current-gate.ts';
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
 * (reference and evidence, never an address), the approved type revision it was decided under and the RECIPIENT RULE that
 * governed the decision (the audience policy and the audience slots, as approved then). The rule is kept as it was, so the decision
 * stays explainable after the catalog moves on (#1394 domain review, #1396 BR-14), and a later revision of the type does not
 * change what the decision was.
 */
export const HandoffContactKeySchema = Schema.String.pipe(Schema.brand('HandoffContactKey'));
export const HandoffPinSchema = Schema.Struct({
  contactKey: HandoffContactKeySchema,
  recipientRule: Schema.Struct({ audience: AudiencePolicySchema, slots: Schema.Array(AudienceSlotSchema) }),
  typeRevision: Schema.Number,
});
export type HandoffPin = typeof HandoffPinSchema.Type;

export const handoffPinOf = (
  type: Pick<TransactionalMessageType, 'audience' | 'result' | 'revision'>,
  binding: OriginalRecipientBinding,
): HandoffPin => ({
  contactKey: HandoffContactKeySchema.make(contactBindingKey(binding.originalContact)),
  recipientRule: { audience: type.audience, slots: type.result.kind === 'MESSAGE_INTENTS' ? type.result.slots : [] },
  typeRevision: type.revision,
});

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const members = new Set(right);
  return left.length === right.length && left.every((value) => members.has(value));
};

const sameSlot = (pinned: AudienceSlot, current: AudienceSlot) =>
  pinned.slotKey === current.slotKey &&
  pinned.recipientRole === current.recipientRole &&
  pinned.cardinality === current.cardinality &&
  pinned.source.contactOwner === current.source.contactOwner &&
  pinned.source.contactResourceType === current.source.contactResourceType &&
  sameSet(pinned.source.evidenceKinds, current.source.evidenceKinds);

const sameAudience = (pinned: AudiencePolicy, current: AudiencePolicy) =>
  pinned.mode === 'INDIVISIBLE' && current.mode === 'INDIVISIBLE'
    ? pinned.approvalRuleKey === current.approvalRuleKey && sameSet(pinned.slotKeys, current.slotKeys)
    : pinned.mode === current.mode;

/**
 * Whether the recipient rule that governed THIS candidate's decision is no longer the approved one: its audience slot (role,
 * cardinality, where the original contact comes from) or, for a member of an approved group under either rule, the audience policy.
 * A new revision of the type that leaves this rule as it was (a changed wording, another template or Privacy purpose) is not a change
 * of it, so a message decided under the earlier revision stays valid (R-D15).
 */
const recipientRuleChanged = (candidate: HandoffCandidate, type: TransactionalMessageType) => {
  const { audience, slots } = candidate.pin.recipientRule;
  const { slotKey } = candidate.identity;
  const pinnedSlot = slots.find((slot) => slot.slotKey === slotKey);
  const currentSlot =
    type.result.kind === 'MESSAGE_INTENTS' ? type.result.slots.find((slot) => slot.slotKey === slotKey) : undefined;
  if (pinnedSlot === undefined || currentSlot === undefined || !sameSlot(pinnedSlot, currentSlot)) {
    return true;
  }
  const inAGroup = isGroupMember(audience, slotKey) || isGroupMember(type.audience, slotKey);
  return inAGroup && !sameAudience(audience, type.audience);
};

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
  /**
   * The recipient rule that governed the decision of this message is no longer the approved one (not a recipient fact): nothing is
   * asked of any owner and the message stops with its own non-recipient reason. A mere new revision of the type never is one.
   */
  RuleChanged: { readonly identity: MessageIntentIdentity };
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

/** What the recheck made of one candidate: the recipient rule that governed it moved on, or its recipient was assessed. */
type Assessed =
  | { readonly assessment: RecipientAssessmentCase; readonly kind: 'ASSESSED' }
  | { readonly kind: 'RULE_CHANGED' };

const assessed = (assessment: RecipientAssessmentCase): Assessed => ({ assessment, kind: 'ASSESSED' });

const assessCandidate = (
  candidate: HandoffCandidate,
  input: RecipientEvaluationInput,
  duplicate: boolean,
): Effect.Effect<Assessed, never, RecipientCurrentGate> => {
  // a candidate that names no slot of the rule it was decided under is not this decision's message at all
  const decidedSlot = candidate.pin.recipientRule.slots.some(({ slotKey }) => slotKey === candidate.identity.slotKey);
  if (!decidedSlot || !belongsToRequest(candidate, input)) {
    return Effect.succeed(assessed(stoppedFor('RECIPIENT_IDENTITY_CHANGED', candidate)));
  }
  if (duplicate) {
    return Effect.succeed(assessed(stoppedFor('DUPLICATE_CANDIDATE', candidate)));
  }
  // not a recipient fact and not a reason to ask any owner: the rule that governed the decision is no longer the approved one
  if (recipientRuleChanged(candidate, input.type)) {
    return Effect.succeed({ kind: 'RULE_CHANGED' });
  }
  const slot =
    input.type.result.kind === 'MESSAGE_INTENTS'
      ? input.type.result.slots.find(({ slotKey }) => slotKey === candidate.identity.slotKey)
      : undefined;
  const [first, ...rest] = slot === undefined ? [] : originalsOf(candidate, slot.recipientRole, input);
  if (slot === undefined || first === undefined) {
    return Effect.succeed(assessed(stoppedFor('RECIPIENT_IDENTITY_CHANGED', candidate)));
  }
  const stage = bindRecipient(slot, input.scope, [first, ...rest]);
  if (stage.kind === 'settled') {
    return Effect.succeed(assessed(stage.assessment));
  }
  const originalKey = contactBindingKey(stage.contact);
  return candidate.pin.contactKey === originalKey &&
    contactBindingKey(candidate.binding.originalContact) === originalKey
    ? Effect.map(checkBoundRecipient(input, stage), assessed)
    : Effect.succeed(
        assessed(
          RecipientAssessment.RecipientNotAllowed({ reason: 'ORIGINAL_CONTACT_CHANGED', subject: stage.subject }),
        ),
      );
};

/** One candidate after the recheck: already handed off (not asked again), its rule changed, or its recipient evaluated. */
type Evaluation =
  | { readonly evaluated: EvaluatedRecipient; readonly kind: 'EVALUATED' }
  | { readonly kind: 'HANDED_OFF' }
  | { readonly kind: 'RULE_CHANGED' };

const isAllowed = (evaluation: Evaluation | undefined) =>
  evaluation?.kind === 'EVALUATED' && RecipientAssessment.$is('RecipientAllowed')(evaluation.evaluated.assessment);

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
 * candidate listed more than once is stopped in every stoppable copy. A candidate whose recipient rule is no longer the approved
 * one is stopped with its own non-recipient reason and no owner is asked. Verdicts keep the input order. Never fails:
 * an unreachable authority is a Stopped verdict, so no stale permission can let a handoff through.
 */
export const recheckBeforeHandoff = Effect.fn('Communications.recheckBeforeHandoff')(function* recheckAll(
  input: RecipientEvaluationInput,
  candidates: readonly HandoffCandidate[],
) {
  const evaluatedAt = yield* DateTime.now;
  const copies = Object.groupBy(candidates, candidateKey);
  const evaluations = yield* Effect.forEach(
    candidates,
    (candidate): Effect.Effect<Evaluation, never, RecipientCurrentGate> =>
      candidate.handoff === 'PROVEN_HANDED_OFF'
        ? Effect.succeed({ kind: 'HANDED_OFF' })
        : assessCandidate(candidate, input, (copies[candidateKey(candidate)]?.length ?? 0) > 1).pipe(
            Effect.map((result): Evaluation =>
              result.kind === 'RULE_CHANGED'
                ? result
                : { evaluated: evaluatedRecipientOf(input, evaluatedAt, result.assessment), kind: 'EVALUATED' },
            ),
          ),
    { concurrency: GATE_CONCURRENCY },
  );
  const members = candidates.map((candidate, index): GroupMember => ({
    ready: evaluations[index]?.kind === 'HANDED_OFF' || isAllowed(evaluations[index]),
    slotKey: candidate.identity.slotKey,
  }));
  const groupComplete = isGroupComplete(input.type.audience, members);
  return candidates.map((candidate, index): HandoffVerdictCase => {
    const evaluation = evaluations[index];
    const groupHeld = !groupComplete && isGroupMember(input.type.audience, candidate.identity.slotKey);
    if (evaluation?.kind === 'EVALUATED') {
      return verdictOf(candidate, evaluation.evaluated, groupHeld);
    }
    return evaluation?.kind === 'RULE_CHANGED'
      ? HandoffVerdict.RuleChanged({ identity: candidate.identity })
      : HandoffVerdict.AlreadyHandedOff({ identity: candidate.identity, reconciliationRequired: groupHeld });
  });
});
