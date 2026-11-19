import { Data, Effect, Option } from 'effect';

import { CommunicationOutcome, isStaleSourceReason, RecipientDecision } from './decision.ts';
import { CommunicationRequirednessUnknown } from './required-errors.ts';
import type {
  CommunicationDecision,
  MessageIntentIdentity,
  NoMessageReason,
  StaleSourceReason,
  UnresolvedSlot,
  UnresolvedSlotReason,
} from './decision.ts';
import type { AudienceSlotKey, CandidateStopReason, CommunicationPurposeKey } from './vocabulary.ts';

/**
 * What the source workflow learns about a business-required type. Required is a business requirement on the
 * outcome, never an exception to Privacy, recipient or scope gates, never a delivery guarantee, and never a
 * rollback: the Communications result is information, and only the source owner decides its own workflow impact.
 */

/** One concrete reason a required communication was not fully prepared. */
export type RequiredFailureReasonCase = Data.TaggedEnum<{
  CandidateSuppressed: { readonly identity: MessageIntentIdentity; readonly reason: CandidateStopReason };
  NoMessage: { readonly reason: NoMessageReason };
  SlotUnresolved: { readonly reason: UnresolvedSlotReason; readonly slotKey: AudienceSlotKey };
}>;
export const RequiredFailureReason = Data.taggedEnum<RequiredFailureReasonCase>();

export type RequiredCommunicationOutcomeCase = Data.TaggedEnum<{
  /** Not every required candidate could be prepared. `partial` is true when some were prepared anyway. */
  Failed: {
    readonly partial: boolean;
    readonly prepared: readonly MessageIntentIdentity[];
    readonly reasons: readonly [RequiredFailureReasonCase, ...RequiredFailureReasonCase[]];
    /** The source owner alone decides pausing, recovery or only recording; Communications changes no source state. */
    readonly sourceImpact: 'SOURCE_OWNER_DECIDES';
  };
  /** The approved type is optional; nothing is owed to the source. */
  NotRequired: { readonly requiredness: 'OPTIONAL' };
  /** Every required candidate is prepared and eligible. This is not delivery. */
  Prepared: { readonly prepared: readonly MessageIntentIdentity[] };
  /**
   * No approved type usable by this issuer carries the purpose (unknown, or owned by another source), so requiredness
   * cannot be asserted and nothing was prepared. It is never a prepared required communication.
   */
  RequirednessUnknown: { readonly purpose: CommunicationPurposeKey };
  /**
   * BR-08: the source owner's own state or revision change made the request stale before the last stoppable boundary.
   * The stop is truthful but not a Communications failure; the source owner already knows its own change.
   */
  SourceStale: { readonly reason: StaleSourceReason };
}>;
export const RequiredCommunicationOutcome = Data.taggedEnum<RequiredCommunicationOutcomeCase>();
type FailedOutcome = Data.TaggedEnum.Value<RequiredCommunicationOutcomeCase, 'Failed'>;

interface RequiredEvaluation {
  readonly prepared: readonly MessageIntentIdentity[];
  readonly reasons: readonly RequiredFailureReasonCase[];
}

const unresolvedReasons = (slots: readonly UnresolvedSlot[]) =>
  slots.map(({ reason, slotKey }) => RequiredFailureReason.SlotUnresolved({ reason, slotKey }));

const evaluate = (decision: CommunicationDecision): RequiredEvaluation =>
  CommunicationOutcome.$match(decision.outcome, {
    Candidates: ({ candidates, unresolvedSlots }) => ({
      prepared: candidates.flatMap(({ identity, recipient }) =>
        RecipientDecision.$match(recipient, { Eligible: () => [identity], Suppressed: () => [] }),
      ),
      reasons: [
        ...unresolvedReasons(unresolvedSlots),
        ...candidates.flatMap(({ identity, recipient }) =>
          RecipientDecision.$match(recipient, {
            Eligible: () => [],
            Suppressed: ({ reason }) => [RequiredFailureReason.CandidateSuppressed({ identity, reason })],
          }),
        ),
      ],
    }),
    NoMessage: ({ reason, unresolvedSlots }) => ({
      prepared: [],
      reasons: [RequiredFailureReason.NoMessage({ reason }), ...unresolvedReasons(unresolvedSlots)],
    }),
  });

const outcomeFor = ({ prepared, reasons }: RequiredEvaluation): RequiredCommunicationOutcomeCase => {
  const [first, ...rest] = reasons;
  return first === undefined
    ? RequiredCommunicationOutcome.Prepared({ prepared })
    : RequiredCommunicationOutcome.Failed({
        partial: prepared.length > 0,
        prepared,
        reasons: [first, ...rest],
        sourceImpact: 'SOURCE_OWNER_DECIDES',
      });
};

const staleSourceReasonOf = (decision: CommunicationDecision) =>
  CommunicationOutcome.$match(decision.outcome, {
    Candidates: () => Option.none<StaleSourceReason>(),
    NoMessage: ({ reason }) => (isStaleSourceReason(reason) ? Option.some(reason) : Option.none()),
  });

/** Derive the typed outcome the source workflow receives for the decision of one request. */
export const requiredOutcomeOf = (decision: CommunicationDecision): RequiredCommunicationOutcomeCase =>
  Option.match(decision.type, {
    onNone: () => RequiredCommunicationOutcome.RequirednessUnknown({ purpose: decision.purpose }),
    onSome: ({ requiredness }) =>
      requiredness === 'OPTIONAL'
        ? RequiredCommunicationOutcome.NotRequired({ requiredness })
        : Option.match(staleSourceReasonOf(decision), {
            onNone: () => outcomeFor(evaluate(decision)),
            onSome: (reason) => RequiredCommunicationOutcome.SourceStale({ reason }),
          }),
  });

/**
 * Typed failure for a source workflow that wants the channel form. It carries the truthful failed outcome only;
 * raising it triggers no rollback, no resend and no change to the already-confirmed business fact.
 */
export class RequiredCommunicationNotPrepared extends Data.TaggedError('RequiredCommunicationNotPrepared')<{
  readonly outcome: FailedOutcome;
}> {}

/**
 * Succeeds with the decision unless a required communication could not be fully prepared (RequiredCommunicationNotPrepared)
 * or the purpose is not an approved type for this issuer (CommunicationRequirednessUnknown). A stale source (BR-08)
 * and an optional type succeed: Communications owes the source no failure there; read `requiredOutcomeOf` for detail.
 */
export const requireCommunicationPrepared = (decision: CommunicationDecision) =>
  RequiredCommunicationOutcome.$match(requiredOutcomeOf(decision), {
    Failed: (outcome) => Effect.fail(new RequiredCommunicationNotPrepared({ outcome })),
    NotRequired: () => Effect.succeed(decision),
    Prepared: () => Effect.succeed(decision),
    RequirednessUnknown: ({ purpose }) => Effect.fail(new CommunicationRequirednessUnknown({ purpose })),
    SourceStale: () => Effect.succeed(decision),
  });
