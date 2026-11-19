import { Data, Effect, Option } from 'effect';

import { CommunicationOutcome, RecipientDecision } from './decision.ts';
import type {
  CommunicationDecision,
  MessageIntentIdentity,
  NoMessageReason,
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
  /** No approved type carries the purpose, so requiredness cannot be asserted. */
  RequirednessUnknown: { readonly purpose: CommunicationPurposeKey };
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

/** Derive the typed outcome the source workflow receives for the decision of one request. */
export const requiredOutcomeOf = (decision: CommunicationDecision): RequiredCommunicationOutcomeCase =>
  Option.match(decision.type, {
    onNone: () => RequiredCommunicationOutcome.RequirednessUnknown({ purpose: decision.purpose }),
    onSome: ({ requiredness }) =>
      requiredness === 'OPTIONAL'
        ? RequiredCommunicationOutcome.NotRequired({ requiredness })
        : outcomeFor(evaluate(decision)),
  });

/**
 * Typed failure for a source workflow that wants the channel form. It carries the truthful failed outcome only;
 * raising it triggers no rollback, no resend and no change to the already-confirmed business fact.
 */
export class RequiredCommunicationNotPrepared extends Data.TaggedError('RequiredCommunicationNotPrepared')<{
  readonly outcome: FailedOutcome;
}> {}

/** Succeeds with the decision unless a required communication could not be fully prepared. */
export const requireCommunicationPrepared = (decision: CommunicationDecision) =>
  RequiredCommunicationOutcome.$match(requiredOutcomeOf(decision), {
    Failed: (outcome) => Effect.fail(new RequiredCommunicationNotPrepared({ outcome })),
    NotRequired: () => Effect.succeed(decision),
    Prepared: () => Effect.succeed(decision),
    RequirednessUnknown: () => Effect.succeed(decision),
  });
