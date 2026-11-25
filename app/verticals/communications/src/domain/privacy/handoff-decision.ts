import { Data, DateTime, Effect, Option } from 'effect';

import { isGroupComplete, isGroupMember } from '../catalog/audience.ts';
import type { AudiencePolicy } from '../catalog/audience.ts';
import type { MessageIntentIdentity } from '../catalog/decision.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import { GATE_CONCURRENCY } from '../recipient/assess-recipients.ts';
import type { RecipientEvaluationInput } from '../recipient/assess-recipients.ts';
import type { OriginalRecipientBinding } from '../recipient/original-binding.ts';
import { HandoffVerdict, recheckBeforeHandoff } from '../recipient/recheck-before-handoff.ts';
import type { HandoffPin } from '../recipient/recheck-before-handoff.ts';
import { assessPrivacyEligibility, PrivacyAssessment } from './assess-privacy.ts';
import type { PrivacyAssessmentCase } from './assess-privacy.ts';
import type { EligibilityEvidence, ProcessingEligibilityGate } from './eligibility-gate.ts';
import { processingScopeKey } from './processing-scope.ts';
import type { ProcessingScope } from './processing-scope.ts';
import { decideMessage, decideUnaskedMessage, HandoffFact, MessageHandoffDecision } from './suppression.ts';
import type {
  AskedMessageFacts,
  HandoffFactCase,
  MessageHandoffDecisionCase,
  ProviderFactCase,
  SourceCurrentnessCase,
  SuppressionReason,
  UnaskedMessageFacts,
} from './suppression.ts';
import type { RecipientCurrentGate } from '../recipient/current-gate.ts';

/**
 * The last stoppable handoff decision (#1396, BR-05, BR-06, BR-09). Every message of a request is decided on its own
 * from Current facts asked again NOW: its ORIGINAL recipient and endpoint (d21-03), Privacy Processing Eligibility for
 * its exact scope, the still-valid source, and the provider facts step 22 evidenced. This holds equally for queued and
 * retried work: a retained ALLOWED, a TTL or a previous decision is never an input. An approved indivisible audience is
 * the only place one message's result reaches another.
 */

/** One message to decide again. Its binding, identity and pin are exactly what the first decision fixed. */
export interface MessageHandoffItem {
  readonly binding: OriginalRecipientBinding;
  readonly handoff: HandoffFactCase;
  readonly identity: MessageIntentIdentity;
  readonly pin: HandoffPin;
  readonly provider: ProviderFactCase;
  /** The exact Privacy scope declared for THIS message to THIS recipient; never shared between messages. */
  readonly scope: ProcessingScope;
}

export interface MessageHandoffInput {
  readonly recipient: RecipientEvaluationInput;
  readonly source: SourceCurrentnessCase;
  /**
   * The audience slots of members of the same request that are known to be unable to proceed and are therefore not asked about
   * again (not pending, or stopped for good): they count as members that are not ready, so an approved indivisible group
   * that one of them belongs to can never be complete.
   */
  readonly withheld?: readonly MessageIntentIdentity['slotKey'][];
}

/** One message before its recipient verdict: asked about Privacy and carrying the answer, or not asked about at all. */
type Staged =
  | {
      readonly handoff: AskedMessageFacts['handoff'];
      readonly item: MessageHandoffItem;
      readonly kind: 'ASKED';
      readonly privacy: PrivacyAssessmentCase;
    }
  | { readonly handoff: UnaskedMessageFacts['handoff']; readonly item: MessageHandoffItem; readonly kind: 'UNASKED' };

const assessFor = (input: MessageHandoffInput, item: MessageHandoffItem) => {
  const { request, type } = input.recipient;
  const query = {
    occurrence: request.occurrence,
    recipient: { recipientRef: item.binding.recipientRef, role: item.binding.role },
    scope: item.scope,
    sourceModule: request.source.moduleKey,
    tenantId: request.tenantId,
    typeId: type.typeId,
  };
  if (type.privacyPurposeRefs.includes(item.scope.catalogPurposeRef)) {
    return assessPrivacyEligibility(query);
  }
  // A scope for a purpose the approved type does not declare is never sent to Privacy as if it were the type's.
  return DateTime.now.pipe(
    Effect.map((assessedAt) =>
      PrivacyAssessment.Unavailable({
        assessedAt,
        reason: 'CONTEXT_AMBIGUOUS',
        scopeKey: processingScopeKey(item.scope),
      }),
    ),
  );
};

/**
 * An approved indivisible audience (#1395, BR-09) hands off nothing unless every member is ready. A member already
 * proven handed off is never undone: it keeps what happened and records the broken group as a later condition.
 * Individual audiences, and members outside the approved group, are untouched.
 */
const applyAudienceGroup = (
  audience: AudiencePolicy,
  entries: readonly {
    readonly decision: MessageHandoffDecisionCase;
    readonly slotKey: MessageIntentIdentity['slotKey'];
  }[],
  withheld: readonly MessageIntentIdentity['slotKey'][],
): readonly MessageHandoffDecisionCase[] => {
  const members = [
    ...entries.map(({ decision, slotKey }) => ({
      ready:
        MessageHandoffDecision.$is('Proceed')(decision) || MessageHandoffDecision.$is('AlreadyHandedOff')(decision),
      slotKey,
    })),
    ...withheld.map((slotKey) => ({ ready: false, slotKey })),
  ];
  if (isGroupComplete(audience, members)) {
    return entries.map(({ decision }) => decision);
  }
  const held: SuppressionReason = {
    category: 'AUDIENCE_GROUP_INCOMPLETE',
    cause: 'AUDIENCE_GROUP_INCOMPLETE',
    proven: true,
  };
  return entries.map(({ decision, slotKey }) => {
    if (!isGroupMember(audience, slotKey)) {
      return decision;
    }
    if (MessageHandoffDecision.$is('Proceed')(decision)) {
      const { evidence, identity } = decision;
      return MessageHandoffDecision.Suppressed({ evidence, identity, primary: held, reasons: [held] });
    }
    return MessageHandoffDecision.$is('AlreadyHandedOff')(decision)
      ? MessageHandoffDecision.AlreadyHandedOff({ identity: decision.identity, later: [...decision.later, held] })
      : decision;
  });
};

/**
 * Decide every message again before its last stoppable handoff, individually. Never fails: an owner that cannot
 * answer is a stopped message with its own uncertain reason, so no stale permission can let a handoff through. Results
 * keep the input order. A message whose provider effect is unknown is not asked about and is never resent blindly.
 */
export const decideMessageHandoffs = Effect.fn('Communications.decideMessageHandoffs')(function* decideAll(
  input: MessageHandoffInput,
  items: readonly MessageHandoffItem[],
): Effect.fn.Return<readonly MessageHandoffDecisionCase[], never, ProcessingEligibilityGate | RecipientCurrentGate> {
  const evaluatedAt = yield* DateTime.now;
  const recheckable = items.filter((item) => !HandoffFact.$is('EffectUnknown')(item.handoff));
  // Position of each item among the rechecked ones, by position and not by identity, so a repeated item keeps its own verdict.
  const recheckPosition = items.map((item, index) =>
    HandoffFact.$is('EffectUnknown')(item.handoff)
      ? -1
      : items.slice(0, index).filter((earlier) => !HandoffFact.$is('EffectUnknown')(earlier.handoff)).length,
  );
  const verdicts = yield* recheckBeforeHandoff(
    input.recipient,
    recheckable.map(({ binding, handoff, identity, pin }) => ({
      binding,
      handoff: HandoffFact.$is('ProvenHandedOff')(handoff) ? ('PROVEN_HANDED_OFF' as const) : ('STOPPABLE' as const),
      identity,
      pin,
    })),
  );
  // A message that may still be handed off is asked about Privacy; one that is not (proven or unknown handoff) is never
  const staged = yield* Effect.forEach(
    items,
    (item): Effect.Effect<Staged, never, ProcessingEligibilityGate> => {
      const { handoff } = item;
      return HandoffFact.$is('NotAttempted')(handoff)
        ? Effect.map(assessFor(input, item), (privacy): Staged => ({ handoff, item, kind: 'ASKED', privacy }))
        : Effect.succeed<Staged>({ handoff, item, kind: 'UNASKED' });
    },
    { concurrency: GATE_CONCURRENCY },
  );
  const decisions = staged.map((entry, index) => {
    const { item } = entry;
    const verdict =
      verdicts[recheckPosition[index] ?? -1] ??
      HandoffVerdict.AlreadyHandedOff({ identity: item.identity, reconciliationRequired: true });
    const facts = {
      evaluatedAt,
      identity: item.identity,
      provider: item.provider,
      recipient: verdict,
      scope: item.scope,
      source: input.source,
    };
    return {
      decision:
        entry.kind === 'ASKED'
          ? decideMessage({ ...facts, handoff: entry.handoff, privacy: entry.privacy })
          : decideUnaskedMessage({ ...facts, handoff: entry.handoff }),
      slotKey: item.identity.slotKey,
    };
  });
  return applyAudienceGroup(input.recipient.type.audience, decisions, input.withheld ?? []);
});

/**
 * Recovery after a stop (BR-13): only a NEW Current evaluation that lets the same message proceed may admit another
 * attempt; the earlier stop and its evidence stay exactly as recorded. "New" is the Privacy owner's own decision: the
 * proceeding message needs an `ALLOWED` whose trusted decision time is later than the owner decision behind the stop
 * (or, when the stop had none, later than the stop itself), never merely a later local clock reading. A message that
 * already left, or whose provider effect is unknown, is never admitted here: reconciliation, not a retry, decides it.
 * Idempotence of the later send belongs to the intent (#1401).
 */
export type RecoveryAdmissionCase = Data.TaggedEnum<{
  /** `priorStop` is the unchanged record the admission was decided against; recovery never replaces it. */
  Admitted: { readonly identity: MessageIntentIdentity; readonly priorStop: StopRecord };
  Refused: {
    readonly identity: MessageIntentIdentity;
    readonly reason:
      | 'ALREADY_HANDED_OFF'
      | 'DIFFERENT_MESSAGE'
      | 'NOT_A_NEW_EVALUATION'
      | 'RECONCILIATION_REQUIRED'
      | 'STILL_SUPPRESSED';
  };
}>;
export const RecoveryAdmission = Data.taggedEnum<RecoveryAdmissionCase>();

export interface StopRecord {
  /** When Communications evaluated the stop. */
  readonly evaluatedAt: DateTime.Utc;
  readonly identity: MessageIntentIdentity;
  /** The Privacy owner's trusted decision time behind the stop, when the owner evidenced a decision. */
  readonly ownerDecidedAt: Option.Option<DateTime.Utc>;
}

const decisionTimeOf = (evidence: EligibilityEvidence | undefined): Option.Option<DateTime.Utc> =>
  evidence === undefined ? Option.none() : Option.some(evidence.trustedDecisionTime);

const ownerDecisionTimeOf = (assessment: PrivacyAssessmentCase): Option.Option<DateTime.Utc> =>
  PrivacyAssessment.$match(assessment, {
    Allowed: ({ evidence }) => decisionTimeOf(evidence),
    Indeterminate: ({ evidence }) => decisionTimeOf(evidence),
    NotAllowed: ({ evidence }) => decisionTimeOf(evidence),
    Unavailable: () => Option.none(),
  });

/** The record of a stop, taken from the stop decision itself so a caller cannot invent its time. */
export const stopRecordOf = (
  decision: Extract<MessageHandoffDecisionCase, { readonly _tag: 'Suppressed' }>,
): StopRecord => ({
  evaluatedAt: decision.evidence.evaluatedAt,
  identity: decision.identity,
  ownerDecidedAt: ownerDecisionTimeOf(decision.evidence.privacy),
});

const messageKey = (identity: MessageIntentIdentity) =>
  [
    identity.tenantId,
    identity.sourceModule,
    identity.occurrenceId,
    identity.revision,
    identity.typeId,
    identity.slotKey,
    resourceRefKey(identity.recipient),
  ].join('|');

export const admitRecoveryAfterStop = (prior: StopRecord, next: MessageHandoffDecisionCase): RecoveryAdmissionCase => {
  const { identity } = next;
  const sameMessage = messageKey(identity) === messageKey(prior.identity);
  if (!sameMessage) {
    return RecoveryAdmission.Refused({ identity, reason: 'DIFFERENT_MESSAGE' });
  }
  const since = Option.getOrElse(prior.ownerDecidedAt, () => prior.evaluatedAt);
  return MessageHandoffDecision.$match(next, {
    AlreadyHandedOff: () => RecoveryAdmission.Refused({ identity, reason: 'ALREADY_HANDED_OFF' }),
    Proceed: ({ evidence }) => {
      // Only an ALLOWED the owner decided after the stop is a new evaluation; its own decision time is what counts.
      const decidedAt = PrivacyAssessment.$is('Allowed')(evidence.privacy)
        ? decisionTimeOf(evidence.privacy.evidence)
        : Option.none();
      const isNew = Option.match(decidedAt, {
        onNone: () => false,
        onSome: (time) => DateTime.isGreaterThan(time, since),
      });
      return isNew
        ? RecoveryAdmission.Admitted({ identity, priorStop: prior })
        : RecoveryAdmission.Refused({ identity, reason: 'NOT_A_NEW_EVALUATION' });
    },
    ReconciliationRequired: () => RecoveryAdmission.Refused({ identity, reason: 'RECONCILIATION_REQUIRED' }),
    Suppressed: () => RecoveryAdmission.Refused({ identity, reason: 'STILL_SUPPRESSED' }),
  });
};
