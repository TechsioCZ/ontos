import { Array as EffectArray, Data, Option, Schema } from 'effect';

import type { CommunicationDecisionContext, CommunicationDecisionRequest, RecipientFact } from './decision-request.ts';
import type { AudienceSlot, TransactionalMessageType } from './message-type.ts';
import { findMessageTypeByPurpose } from './registry.ts';
import type { MessageTypeRegistry } from './registry.ts';
import type {
  ApprovedRuleKey,
  AudienceSlotKey,
  CandidateStopReason,
  CommunicationOccurrenceId,
  CommunicationPurposeKey,
  CommunicationResourceRef,
  MessageTypeId,
  PrivacyPurposeKey,
  RecipientRole,
  Requiredness,
} from './vocabulary.ts';

/**
 * Communication Decision: one committed source request in, 0..N Message Intent candidates or a truthful
 * NO_MESSAGE out. NO_MESSAGE means no concrete candidate exists (nothing approved, admissible or addressable);
 * SUPPRESSED means a concrete candidate exists and a current fact stopped it. The two are never conflated, and
 * neither claims transport, delivery or a change to the source business fact.
 */

/**
 * Why no concrete candidate exists at all:
 * - UNKNOWN_PURPOSE: no approved type carries the request's purpose;
 * - SOURCE_NOT_AUTHORIZED_FOR_TYPE: the approved type belongs to another source owner than the issuer;
 * - TYPE_DEACTIVATED, TYPE_STALE: the approved type is switched off or its approved rule is no longer current;
 * - SOURCE_ONBOARDING_INACTIVE: the type is approved but its source owner has not activated its producer;
 * - SOURCE_STATE_INELIGIBLE: the source occurrence is in a state the type does not cover;
 * - SOURCE_REVISION_NOT_CURRENT: the request reflects a source revision that is not the current one;
 * - APPROVED_NO_MESSAGE: the approved rule for this context is an explicit zero-message rule;
 * - RECIPIENT_AUTHORITY_MISSING: every audience slot lacks an unambiguous approved recipient.
 */
export const NoMessageReasonSchema = Schema.Literals([
  'UNKNOWN_PURPOSE',
  'SOURCE_NOT_AUTHORIZED_FOR_TYPE',
  'TYPE_DEACTIVATED',
  'TYPE_STALE',
  'SOURCE_ONBOARDING_INACTIVE',
  'SOURCE_STATE_INELIGIBLE',
  'SOURCE_REVISION_NOT_CURRENT',
  'APPROVED_NO_MESSAGE',
  'RECIPIENT_AUTHORITY_MISSING',
]);
export type NoMessageReason = typeof NoMessageReasonSchema.Type;

/** Why an audience slot produced no candidate; the slot is skipped and no fallback recipient is invented. */
export const UnresolvedSlotReasonSchema = Schema.Literals(['RECIPIENT_AMBIGUOUS', 'RECIPIENT_AUTHORITY_MISSING']);
export type UnresolvedSlotReason = typeof UnresolvedSlotReasonSchema.Type;

export interface UnresolvedSlot {
  readonly reason: UnresolvedSlotReason;
  readonly slotKey: AudienceSlotKey;
}

/** The approved type a decision was made under; pinned so a later catalog change cannot rewrite the decision. */
export interface MessageTypePin {
  readonly privacyPurposeRefs: readonly PrivacyPurposeKey[];
  readonly requiredness: Requiredness;
  readonly revision: number;
  readonly typeId: MessageTypeId;
}

/** Identity of one candidate; durable idempotency over it belongs to d21-07. Equal input gives equal identities. */
export interface MessageIntentIdentity {
  readonly occurrenceId: CommunicationOccurrenceId;
  readonly recipientResourceId: CommunicationResourceRef['resourceId'];
  readonly revision: number;
  readonly slotKey: AudienceSlotKey;
  readonly typeId: MessageTypeId;
}

/** The candidate's own recipient decision. Nothing here is an address or a Privacy verdict. */
export type RecipientDecisionCase = Data.TaggedEnum<{
  Eligible: { readonly ref: CommunicationResourceRef; readonly role: RecipientRole };
  Suppressed: {
    readonly reason: CandidateStopReason;
    readonly ref: CommunicationResourceRef;
    readonly role: RecipientRole;
  };
}>;
export const RecipientDecision = Data.taggedEnum<RecipientDecisionCase>();

export interface MessageIntentCandidate {
  readonly identity: MessageIntentIdentity;
  readonly purpose: CommunicationPurposeKey;
  readonly recipient: RecipientDecisionCase;
}

export type CommunicationOutcomeCase = Data.TaggedEnum<{
  /** One or more concrete candidates; each may be eligible or individually suppressed. */
  Candidates: {
    readonly candidates: readonly [MessageIntentCandidate, ...MessageIntentCandidate[]];
    readonly unresolvedSlots: readonly UnresolvedSlot[];
  };
  /** No concrete candidate. `ruleKey` names the approved rule behind APPROVED_NO_MESSAGE. */
  NoMessage: {
    readonly reason: NoMessageReason;
    readonly ruleKey?: ApprovedRuleKey;
    readonly unresolvedSlots: readonly UnresolvedSlot[];
  };
}>;
export const CommunicationOutcome = Data.taggedEnum<CommunicationOutcomeCase>();

export interface CommunicationDecision {
  readonly outcome: CommunicationOutcomeCase;
  readonly purpose: CommunicationPurposeKey;
  readonly request: Pick<CommunicationDecisionRequest, 'occurrence' | 'source' | 'tenantId'>;
  /** Absent when no approved type carries the purpose. */
  readonly type: Option.Option<MessageTypePin>;
}

const pinOf = (type: TransactionalMessageType): MessageTypePin => ({
  privacyPurposeRefs: type.privacyPurposeRefs,
  requiredness: type.requiredness,
  revision: type.revision,
  typeId: type.typeId,
});

/** First admission rule that stops the whole type, in a fixed order so the stated reason is deterministic. */
const admissionBlock = (
  type: TransactionalMessageType,
  request: CommunicationDecisionRequest,
  context: CommunicationDecisionContext,
): NoMessageReason | undefined => {
  if (type.sourceOwner !== request.source.moduleKey) {
    return 'SOURCE_NOT_AUTHORIZED_FOR_TYPE';
  }
  if (type.status === 'DEACTIVATED') {
    return 'TYPE_DEACTIVATED';
  }
  if (type.status === 'STALE') {
    return 'TYPE_STALE';
  }
  if (type.onboarding !== 'ACTIVE') {
    return 'SOURCE_ONBOARDING_INACTIVE';
  }
  if (!type.eligibleSourceStates.includes(context.source.state)) {
    return 'SOURCE_STATE_INELIGIBLE';
  }
  if (type.currentness.requireLatestSourceRevision && request.occurrence.revision !== context.source.latestRevision) {
    return 'SOURCE_REVISION_NOT_CURRENT';
  }
  return undefined;
};

const refKey = (ref: CommunicationResourceRef) => `${ref.moduleId}|${ref.resourceType}|${ref.resourceId}`;

/** One fact per distinct recipient; when duplicates disagree the blocking one wins, so a stop is never lost. */
const distinctRecipients = (facts: readonly RecipientFact[]) =>
  Object.values(EffectArray.groupBy(facts, (fact) => refKey(fact.ref))).map(
    (group) => group.find((fact) => fact.stop !== undefined) ?? group[0],
  );

const recipientDecisionOf = (fact: RecipientFact): RecipientDecisionCase =>
  fact.stop === undefined
    ? RecipientDecision.Eligible({ ref: fact.ref, role: fact.role })
    : RecipientDecision.Suppressed({ reason: fact.stop, ref: fact.ref, role: fact.role });

interface SlotResolution {
  readonly candidates: readonly MessageIntentCandidate[];
  readonly unresolved: readonly UnresolvedSlot[];
}

const resolveSlot = (
  slot: AudienceSlot,
  type: TransactionalMessageType,
  request: CommunicationDecisionRequest,
  recipients: readonly RecipientFact[],
): SlotResolution => {
  const matching = distinctRecipients(recipients.filter((fact) => fact.role === slot.recipientRole));
  const unresolved = (reason: UnresolvedSlotReason): SlotResolution => ({
    candidates: [],
    unresolved: [{ reason, slotKey: slot.slotKey }],
  });
  if (matching.length === 0) {
    return unresolved('RECIPIENT_AUTHORITY_MISSING');
  }
  if (slot.cardinality === 'EXACTLY_ONE' && matching.length > 1) {
    return unresolved('RECIPIENT_AMBIGUOUS');
  }
  return {
    candidates: matching.map((fact) => ({
      identity: {
        occurrenceId: request.occurrence.occurrenceId,
        recipientResourceId: fact.ref.resourceId,
        revision: request.occurrence.revision,
        slotKey: slot.slotKey,
        typeId: type.typeId,
      },
      purpose: type.purpose,
      recipient: recipientDecisionOf(fact),
    })),
    unresolved: [],
  };
};

const outcomeOf = (
  type: TransactionalMessageType,
  request: CommunicationDecisionRequest,
  context: CommunicationDecisionContext,
): CommunicationOutcomeCase => {
  const blocked = admissionBlock(type, request, context);
  if (blocked !== undefined) {
    return CommunicationOutcome.NoMessage({ reason: blocked, unresolvedSlots: [] });
  }
  if (type.result.kind === 'NO_MESSAGE') {
    return CommunicationOutcome.NoMessage({
      reason: 'APPROVED_NO_MESSAGE',
      ruleKey: type.result.ruleKey,
      unresolvedSlots: [],
    });
  }
  const resolutions = type.result.slots.map((slot) => resolveSlot(slot, type, request, context.recipients));
  const candidates = resolutions.flatMap((resolution) => resolution.candidates);
  const unresolvedSlots = resolutions.flatMap((resolution) => resolution.unresolved);
  return EffectArray.isReadonlyArrayNonEmpty(candidates)
    ? CommunicationOutcome.Candidates({ candidates, unresolvedSlots })
    : CommunicationOutcome.NoMessage({ reason: 'RECIPIENT_AUTHORITY_MISSING', unresolvedSlots });
};

/**
 * Decide what one committed source request becomes. Pure and deterministic: the same request, context and
 * registry always give the same decision and candidate identities, and a catalog revision is pinned in the result.
 * An unknown purpose, a deactivated or stale type, an inactive onboarding contract or an ineligible source state
 * ends in NO_MESSAGE with its reason; nothing is ever sent implicitly and the source business fact is untouched.
 */
export const decideCommunication = (
  registry: MessageTypeRegistry,
  request: CommunicationDecisionRequest,
  context: CommunicationDecisionContext,
): CommunicationDecision => {
  const head = {
    purpose: request.purpose,
    request: { occurrence: request.occurrence, source: request.source, tenantId: request.tenantId },
  };
  return Option.match(findMessageTypeByPurpose(registry, request.purpose), {
    onNone: () => ({
      ...head,
      outcome: CommunicationOutcome.NoMessage({ reason: 'UNKNOWN_PURPOSE', unresolvedSlots: [] }),
      type: Option.none(),
    }),
    onSome: (type) => ({ ...head, outcome: outcomeOf(type, request, context), type: Option.some(pinOf(type)) }),
  });
};
