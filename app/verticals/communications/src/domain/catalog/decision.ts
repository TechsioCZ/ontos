import { Array as EffectArray, Data, Option, Order, Result, Schema } from 'effect';

import { isGroupComplete, isGroupMember } from './audience.ts';
import type { AudiencePolicy } from './audience.ts';
import type { CommunicationDecisionContext, CommunicationDecisionRequest, RecipientFact } from './decision-request.ts';
import type { AudienceSlot, TransactionalMessageType } from './message-type.ts';
import { findMessageTypeByPurpose } from './registry.ts';
import type { MessageTypeRegistry } from './registry.ts';
import { resourceRefKey } from './vocabulary.ts';
import type {
  ApprovedRuleKey,
  AudienceSlotKey,
  CandidateStopReason,
  CommunicationOccurrenceId,
  CommunicationPurposeKey,
  CommunicationResourceRef,
  CommunicationTenantId,
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

type SourceModuleId = CommunicationDecisionRequest['source']['moduleKey'];

/**
 * BR-08: a source state or revision that moved on makes the request stale. The source owner caused that change and
 * already knows it, so it is a stop with its reason, never a failure Communications reports against a required type.
 */
export const StaleSourceReasonSchema = Schema.Literals(['SOURCE_REVISION_NOT_CURRENT', 'SOURCE_STATE_INELIGIBLE']);
export type StaleSourceReason = typeof StaleSourceReasonSchema.Type;
export const isStaleSourceReason = Schema.is(StaleSourceReasonSchema);

/** Why an audience slot produced no candidate; the slot is skipped and no fallback recipient is invented. */
export const UnresolvedSlotReasonSchema = Schema.Literals(['RECIPIENT_AMBIGUOUS', 'RECIPIENT_AUTHORITY_MISSING']);
export type UnresolvedSlotReason = typeof UnresolvedSlotReasonSchema.Type;

export interface UnresolvedSlot {
  readonly reason: UnresolvedSlotReason;
  readonly slotKey: AudienceSlotKey;
}

/** The approved type a decision was made under; pinned so a later catalog change cannot rewrite the decision. */
export interface MessageTypePin {
  /** The audience rule the decision was made under, so a recheck before handoff cannot be rewritten by a catalog change. */
  readonly audience: AudiencePolicy;
  readonly privacyPurposeRefs: readonly PrivacyPurposeKey[];
  readonly requiredness: Requiredness;
  readonly revision: number;
  readonly typeId: MessageTypeId;
}

/**
 * Identity of one candidate; durable idempotency over it belongs to #1401. Equal input gives equal identities, in any
 * input order. It names every part that makes a candidate distinct: tenant, issuing source module, source occurrence
 * and its revision, approved type, audience slot and the FULL recipient reference (module, type and id), so two
 * recipients that merely share a resource id never collide. The type revision is deliberately not part of it: a
 * later catalog revision must not re-identify an occurrence already decided (BR-09); the decision pins it instead.
 */
export interface MessageIntentIdentity {
  readonly occurrenceId: CommunicationOccurrenceId;
  readonly recipient: CommunicationResourceRef;
  readonly revision: number;
  readonly slotKey: AudienceSlotKey;
  readonly sourceModule: SourceModuleId;
  readonly tenantId: CommunicationTenantId;
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

/** One kind of evaluated fact that was gathered for another occurrence or tenant than the request. */
export interface ContextMismatch {
  readonly fact: 'RECIPIENT_FACT' | 'SOURCE_FACTS';
  readonly field: 'occurrenceId' | 'tenantId';
}

/** Expected failure: the facts do not belong to the request, so no decision is made on them. */
export class CommunicationContextMismatch extends Data.TaggedError('CommunicationContextMismatch')<{
  readonly mismatches: readonly ContextMismatch[];
}> {}

const mismatchesOf = (
  fact: ContextMismatch['fact'],
  bound: { readonly occurrenceId: CommunicationOccurrenceId; readonly tenantId: CommunicationTenantId },
  request: CommunicationDecisionRequest,
): readonly ContextMismatch[] => [
  ...(bound.occurrenceId === request.occurrence.occurrenceId ? [] : [{ fact, field: 'occurrenceId' as const }]),
  ...(bound.tenantId === request.tenantId ? [] : [{ fact, field: 'tenantId' as const }]),
];

const contextMismatches = (request: CommunicationDecisionRequest, context: CommunicationDecisionContext) =>
  EffectArray.dedupeWith(
    [
      ...mismatchesOf('SOURCE_FACTS', context.source, request),
      ...context.recipients.flatMap((fact) => mismatchesOf('RECIPIENT_FACT', fact, request)),
    ],
    (a, b) => a.fact === b.fact && a.field === b.field,
  );

const pinOf = (type: TransactionalMessageType): MessageTypePin => ({
  audience: type.audience,
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

/**
 * When duplicate facts for one recipient disagree, the strongest stop wins so a stop is never lost: Privacy
 * NOT_ALLOWED, then Privacy INDETERMINATE, then the recipient stops. Only an explicit ALLOWED with no other stop is
 * eligible.
 */
const STOP_PRECEDENCE: readonly CandidateStopReason[] = [
  'PRIVACY_NOT_ALLOWED',
  'PRIVACY_INDETERMINATE',
  'RECIPIENT_NOT_ELIGIBLE',
  'RECIPIENT_AUTHORITY_UNAVAILABLE',
  'RECIPIENT_BASIS_MISSING',
];

const stopOf = (fact: RecipientFact): CandidateStopReason | undefined => {
  if (fact.privacy === 'NOT_ALLOWED') {
    return 'PRIVACY_NOT_ALLOWED';
  }
  return fact.privacy === 'INDETERMINATE' ? 'PRIVACY_INDETERMINATE' : fact.recipientStop;
};

/** One entry per distinct full recipient reference, sorted by it so the candidate order ignores the input order. */
const distinctRecipients = (facts: readonly RecipientFact[]) =>
  Object.entries(EffectArray.groupBy(facts, (fact) => resourceRefKey(fact.ref)))
    .toSorted(([a], [b]) => Order.String(a, b))
    .map(([, group]) => {
      const stops = new Set(group.flatMap((fact) => stopOf(fact) ?? []));
      return { ref: group[0].ref, stop: STOP_PRECEDENCE.find((reason) => stops.has(reason)) };
    });

const recipientDecisionOf = (
  { ref, stop }: { readonly ref: CommunicationResourceRef; readonly stop: CandidateStopReason | undefined },
  role: RecipientRole,
): RecipientDecisionCase =>
  stop === undefined
    ? RecipientDecision.Eligible({ ref, role })
    : RecipientDecision.Suppressed({ reason: stop, ref, role });

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
    candidates: matching.map((entry) => ({
      identity: {
        occurrenceId: request.occurrence.occurrenceId,
        recipient: entry.ref,
        revision: request.occurrence.revision,
        slotKey: slot.slotKey,
        sourceModule: request.source.moduleKey,
        tenantId: request.tenantId,
        typeId: type.typeId,
      },
      purpose: type.purpose,
      recipient: recipientDecisionOf(entry, slot.recipientRole),
    })),
    unresolved: [],
  };
};

/**
 * An approved indivisible audience (#1395, BR-07) prepares nothing unless every slot it covers has at least one
 * member and every member is eligible: otherwise each eligible member is stopped with AUDIENCE_GROUP_INCOMPLETE.
 * A member that is already suppressed keeps its own, more specific reason. Members outside the group, and any
 * individual audience, are untouched.
 */
const applyAudiencePolicy = (
  audience: AudiencePolicy,
  candidates: readonly MessageIntentCandidate[],
): readonly MessageIntentCandidate[] => {
  const members = candidates.filter(({ identity }) => isGroupMember(audience, identity.slotKey));
  const complete = isGroupComplete(
    audience,
    members.map(({ identity, recipient }) => ({
      ready: RecipientDecision.$is('Eligible')(recipient),
      slotKey: identity.slotKey,
    })),
  );
  return complete
    ? candidates
    : candidates.map((candidate) =>
        isGroupMember(audience, candidate.identity.slotKey) && RecipientDecision.$is('Eligible')(candidate.recipient)
          ? {
              ...candidate,
              recipient: RecipientDecision.Suppressed({
                reason: 'AUDIENCE_GROUP_INCOMPLETE',
                ref: candidate.recipient.ref,
                role: candidate.recipient.role,
              }),
            }
          : candidate,
      );
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
  const candidates = applyAudiencePolicy(
    type.audience,
    resolutions.flatMap((resolution) => resolution.candidates),
  );
  const unresolvedSlots = resolutions.flatMap((resolution) => resolution.unresolved);
  return EffectArray.isReadonlyArrayNonEmpty(candidates)
    ? CommunicationOutcome.Candidates({ candidates, unresolvedSlots })
    : CommunicationOutcome.NoMessage({ reason: 'RECIPIENT_AUTHORITY_MISSING', unresolvedSlots });
};

/**
 * Decide what one committed source request becomes. Pure and deterministic: the same request, context and
 * registry always give the same decision and candidate identities whatever the recipient input order, and a
 * catalog revision is pinned in the result. Facts gathered for another occurrence or tenant fail with
 * CommunicationContextMismatch and decide nothing. An unknown purpose, a type owned by another source (no type
 * details are returned to that issuer), a deactivated or stale type, an inactive onboarding contract or an
 * ineligible source state ends in NO_MESSAGE with its reason; nothing is ever sent implicitly and the source
 * business fact is untouched.
 */
export const decideCommunication = (
  registry: MessageTypeRegistry,
  request: CommunicationDecisionRequest,
  context: CommunicationDecisionContext,
): Result.Result<CommunicationDecision, CommunicationContextMismatch> => {
  const mismatches = contextMismatches(request, context);
  if (mismatches.length > 0) {
    return Result.fail(new CommunicationContextMismatch({ mismatches }));
  }
  const head = {
    purpose: request.purpose,
    request: { occurrence: request.occurrence, source: request.source, tenantId: request.tenantId },
  };
  const noType = (reason: NoMessageReason) =>
    Result.succeed<CommunicationDecision>({
      ...head,
      outcome: CommunicationOutcome.NoMessage({ reason, unresolvedSlots: [] }),
      type: Option.none(),
    });
  return Option.match(findMessageTypeByPurpose(registry, request.purpose), {
    onNone: () => noType('UNKNOWN_PURPOSE'),
    onSome: (type) =>
      // Another owner's type is never described to this issuer: no pin, so no id, requiredness or Privacy refs.
      type.sourceOwner === request.source.moduleKey
        ? Result.succeed<CommunicationDecision>({
            ...head,
            outcome: outcomeOf(type, request, context),
            type: Option.some(pinOf(type)),
          })
        : noType('SOURCE_NOT_AUTHORIZED_FOR_TYPE'),
  });
};
