import { Array as EffectArray, DateTime, Match, Order, Schema } from 'effect';

import type { HistoryStatus } from '../../../shared/communication-history.ts';
import { effectAfterObservations, submissionFactOfAttempt } from './delivery-result.ts';
import type { AttemptState, FailureClass, ObservationKind, TechnicalEvidence } from './vocabulary.ts';

/**
 * The truthful timeline of ONE Message Intent (#1402). It is a pure projection of facts that are already append-only in
 * the store (the intent, its stops, its attempts and the provider observations), so it can be recomputed at any time and
 * can never disagree with them, and a restart can never duplicate a meaning.
 *
 * Nothing here overwrites: every fact is one entry with the time it claims and the time it was recorded; a later fact
 * adds an entry and may change the HEADLINE status, never an earlier entry. The headline never says more than the proof:
 * it is DELIVERED only with a delivery observation, FAILED only with a proven failure (a TRANSIENT bounce is only
 * DELIVERY_DEFERRED), HELD_UNPROVEN when a stop proves nothing against the message, and INDETERMINATE whenever the external
 * effect is unknown or the evidence contradicts itself.
 *
 * ORDER RULE. The provider's clock is a claim, never an order: `observedAt` is informational and a skewed one can neither
 * flip the headline nor hide a fact. The LATEST conclusive delivery fact is decided by this owner's own order: the attempt
 * number first, then `recordedSeq` (the ingestion order, serialized per attempt, so it is the commit order within an
 * attempt). The ENTRIES are listed by the time they claim (`orderedAt`) with the explicit tie-break (kind, attempt number,
 * own sequence); an observation recorded after one that claims a later time is flagged `outOfOrder` and keeps both facts.
 */

export interface AttemptFacts {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly finishedAt: DateTime.Utc | undefined;
  readonly preparedAt: DateTime.Utc;
  /** The closed reason the provider answer carried, when it had one. */
  readonly reason: string | undefined;
  readonly state: AttemptState;
}

export interface ObservationFacts {
  readonly attemptId: string;
  readonly failureClass: FailureClass | undefined;
  readonly kind: ObservationKind;
  readonly observationId: string;
  /** The provider's own claim of when it happened. */
  readonly observedAt: DateTime.Utc;
  /** When this owner recorded it. */
  readonly recordedAt: DateTime.Utc;
  /** This owner's own ingestion order: the explicit, deterministic tiebreak of the timeline. */
  readonly recordedSeq: number;
}

/** A re-delivery of an observation identity with another content: the earlier observation stays, this is only the trace. */
export interface ConflictFacts {
  readonly attemptId: string;
  readonly kind: ObservationKind;
  /** The earlier, untouched observation of the same identity. */
  readonly observationId: string;
  /** The time the conflicting delivery claims. */
  readonly observedAt: DateTime.Utc;
  readonly recordedAt: DateTime.Utc;
  readonly recordedSeq: number;
}

export interface StopFacts {
  readonly categories: readonly string[];
  readonly evaluationSeq: number;
  readonly proven: boolean;
  readonly recordedAt: DateTime.Utc;
}

export interface IntentTimelineFacts {
  readonly attempts: readonly AttemptFacts[];
  /** Unresolved conflicts of provider evidence (none is ever resolved in this lane: d21-10 appends the resolution). */
  readonly conflicts: readonly ConflictFacts[];
  readonly intent: {
    readonly createdAt: DateTime.Utc;
    readonly intentId: string;
    /** The closed reason a SUPPRESSED or NOT_SENT intent was stopped at decision time. */
    readonly reason: string | undefined;
    readonly status: 'NOT_SENT' | 'PENDING_HANDOFF' | 'SUPPRESSED';
  };
  readonly observations: readonly ObservationFacts[];
  readonly stops: readonly StopFacts[];
}

export const HistoryEntryKindSchema = Schema.Literals([
  'ATTEMPT_PREPARED',
  'HANDOFF_STOPPED',
  'INTENT_PREPARED',
  'INTENT_SUPPRESSED',
  'OBSERVATION_CONFLICTED',
  'PROVIDER_OBSERVED',
  'SUBMISSION_ANSWERED',
]);
export type HistoryEntryKind = typeof HistoryEntryKindSchema.Type;

/** One fact of the timeline. `status` is what THIS entry alone proves; the headline is derived from all of them. */
export interface HistoryEntry {
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly kind: HistoryEntryKind;
  readonly observationId: string | null;
  readonly observationKind: ObservationKind | null;
  /** The time the fact claims (an observation: the provider's own time). */
  readonly occurredAt: DateTime.Utc;
  /**
   * The time the timeline orders by: `occurredAt`, but never before the attempt it belongs to was prepared (a provider cannot
   * observe a submission that was not begun yet; an earlier claim is a clock difference, kept as claimed in `occurredAt`).
   */
  readonly orderedAt: DateTime.Utc;
  /** True for an observation that was recorded AFTER another one that is later in the timeline (a late or out-of-order callback). */
  readonly outOfOrder: boolean;
  readonly reasonCodes: readonly string[];
  readonly recordedAt: DateTime.Utc;
  readonly status: HistoryStatus;
  readonly technical: TechnicalEvidence | null;
}

export interface IntentHistorySummary {
  /** Attempts whose answer and observations contradict each other: the headline is then INDETERMINATE, never a pick. */
  readonly contradictory: boolean;
  /** A delivery observation exists and is the latest delivery-class fact. */
  readonly deliveryProven: boolean;
  /** Provider evidence of this intent disagrees with itself: the headline stays, and the disagreement needs reconciliation. */
  readonly needsReconciliation: boolean;
  /** At least one attempt is, after all its observations, known to have been accepted by the provider. */
  readonly providerAccepted: boolean;
  readonly status: HistoryStatus;
}

export interface IntentHistory {
  readonly entries: readonly HistoryEntry[];
  readonly summary: IntentHistorySummary;
}

const ENTRY_RANK = {
  ATTEMPT_PREPARED: 3,
  HANDOFF_STOPPED: 2,
  INTENT_PREPARED: 0,
  INTENT_SUPPRESSED: 1,
  OBSERVATION_CONFLICTED: 6,
  PROVIDER_OBSERVED: 5,
  SUBMISSION_ANSWERED: 4,
} satisfies Record<HistoryEntryKind, number>;

const isTransient = ({ failureClass, kind }: Pick<ObservationFacts, 'failureClass' | 'kind'>) =>
  kind === 'DELIVERY_FAILED' && failureClass === 'BOUNCED_TRANSIENT';

const observationStatus = (observation: Pick<ObservationFacts, 'failureClass' | 'kind'>): HistoryStatus =>
  Match.value(observation.kind).pipe(
    Match.when('ACCEPTANCE_PROVEN', () => 'PROVIDER_ACCEPTED' as const),
    Match.when('DELIVERY_PROVEN', () => 'DELIVERED' as const),
    // a soft bounce is not a sure failure: the provider may still deliver; a permanent one, a drop and a non-acceptance are
    Match.when('DELIVERY_FAILED', () =>
      isTransient(observation) ? ('DELIVERY_DEFERRED' as const) : ('FAILED' as const),
    ),
    Match.when('NON_ACCEPTANCE_PROVEN', () => 'FAILED' as const),
    Match.exhaustive,
  );

const laterOf = (left: DateTime.Utc, right: DateTime.Utc) => (DateTime.isGreaterThan(left, right) ? left : right);

type Draft = Omit<HistoryEntry, 'outOfOrder'> & { readonly sequence: number };

const attemptDrafts = (facts: IntentTimelineFacts): readonly Draft[] =>
  facts.attempts.flatMap((attempt): Draft[] => {
    const fact = submissionFactOfAttempt(attempt.state, attempt.reason);
    const prepared: Draft = {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      kind: 'ATTEMPT_PREPARED',
      observationId: null,
      observationKind: null,
      occurredAt: attempt.preparedAt,
      orderedAt: attempt.preparedAt,
      reasonCodes: [],
      recordedAt: attempt.preparedAt,
      sequence: attempt.attemptNumber,
      status: 'PROVIDER_SUBMITTED',
      technical: 'SUBMISSION_STARTED',
    };
    if (attempt.finishedAt === undefined) {
      return [prepared];
    }
    return [
      prepared,
      {
        ...prepared,
        kind: 'SUBMISSION_ANSWERED',
        occurredAt: attempt.finishedAt,
        orderedAt: attempt.finishedAt,
        reasonCodes: fact.reason === undefined ? [] : [fact.reason],
        recordedAt: attempt.finishedAt,
        status: fact.status,
        technical: fact.technical,
      },
    ];
  });

const observationDrafts = (facts: IntentTimelineFacts): readonly Draft[] =>
  facts.observations.map((observation): Draft => {
    const attempt = facts.attempts.find(({ attemptId }) => attemptId === observation.attemptId);
    return {
      attemptId: observation.attemptId,
      attemptNumber: attempt?.attemptNumber ?? null,
      kind: 'PROVIDER_OBSERVED',
      observationId: observation.observationId,
      observationKind: observation.kind,
      occurredAt: observation.observedAt,
      orderedAt: attempt === undefined ? observation.observedAt : laterOf(observation.observedAt, attempt.preparedAt),
      reasonCodes: observation.failureClass === undefined ? [] : [observation.failureClass],
      recordedAt: observation.recordedAt,
      sequence: observation.recordedSeq,
      status: observationStatus(observation),
      technical: null,
    };
  });

const conflictDrafts = (facts: IntentTimelineFacts): readonly Draft[] =>
  facts.conflicts.map((conflict): Draft => {
    const attempt = facts.attempts.find(({ attemptId }) => attemptId === conflict.attemptId);
    return {
      attemptId: conflict.attemptId,
      attemptNumber: attempt?.attemptNumber ?? null,
      kind: 'OBSERVATION_CONFLICTED',
      // the observation that stays: the conflict never replaces it
      observationId: conflict.observationId,
      observationKind: conflict.kind,
      occurredAt: conflict.observedAt,
      orderedAt: attempt === undefined ? conflict.observedAt : laterOf(conflict.observedAt, attempt.preparedAt),
      reasonCodes: ['OBSERVATION_CONFLICT'],
      recordedAt: conflict.recordedAt,
      sequence: conflict.recordedSeq,
      // the evidence disagrees with itself: this entry alone proves nothing about the effect
      status: 'INDETERMINATE',
      technical: null,
    };
  });

const decisionDrafts = (facts: IntentTimelineFacts): readonly Draft[] => {
  const { intent } = facts;
  const pending = intent.status === 'PENDING_HANDOFF';
  const decided: Draft = {
    attemptId: null,
    attemptNumber: null,
    kind: pending ? 'INTENT_PREPARED' : 'INTENT_SUPPRESSED',
    observationId: null,
    observationKind: null,
    occurredAt: intent.createdAt,
    orderedAt: intent.createdAt,
    reasonCodes: intent.reason === undefined ? [] : [intent.reason],
    recordedAt: intent.createdAt,
    sequence: 0,
    status: pending ? 'PREPARED' : 'SUPPRESSED',
    technical: null,
  };
  const stops = facts.stops.map((stop): Draft => ({
    ...decided,
    kind: 'HANDOFF_STOPPED',
    occurredAt: stop.recordedAt,
    orderedAt: stop.recordedAt,
    reasonCodes: stop.categories,
    recordedAt: stop.recordedAt,
    sequence: stop.evaluationSeq,
    // a stop that only could not establish a fact proves nothing against the message
    status: stop.proven ? 'SUPPRESSED' : 'HELD_UNPROVEN',
  }));
  return [decided, ...stops];
};

const draftOrder = Order.combine(
  Order.mapInput(Order.Number, (draft: Draft) => draft.orderedAt.epochMilliseconds),
  Order.combine(
    Order.mapInput(Order.Number, (draft: Draft) => ENTRY_RANK[draft.kind]),
    Order.combine(
      Order.mapInput(Order.Number, (draft: Draft) => draft.attemptNumber ?? 0),
      Order.mapInput(Order.Number, (draft: Draft) => draft.sequence),
    ),
  ),
);

/** Every fact as one entry, in the explicit order (`orderedAt`, kind, attempt number, own sequence); deterministic for any input order. */
export const timelineOf = (facts: IntentTimelineFacts): readonly HistoryEntry[] => {
  const drafts = EffectArray.sort(
    [...decisionDrafts(facts), ...attemptDrafts(facts), ...observationDrafts(facts), ...conflictDrafts(facts)],
    draftOrder,
  );
  const observed = drafts.filter((draft) => draft.kind === 'PROVIDER_OBSERVED');
  return drafts.map(({ sequence, ...entry }): HistoryEntry => {
    const late =
      entry.kind === 'PROVIDER_OBSERVED' &&
      observed.some(
        (other) => other.orderedAt.epochMilliseconds > entry.orderedAt.epochMilliseconds && other.sequence < sequence,
      );
    return { ...entry, outOfOrder: late };
  });
};

const resolveAttempts = (facts: IntentTimelineFacts) =>
  facts.attempts.map((attempt) => {
    const kinds = facts.observations.flatMap(({ attemptId, kind }) => (attemptId === attempt.attemptId ? [kind] : []));
    const submission = submissionFactOfAttempt(attempt.state, attempt.reason);
    return {
      attempt,
      effect: effectAfterObservations(submission.effect, kinds),
      // a proven failure of the attempt itself: the provider refused it, or a reconciliation proved non-acceptance
      proven: submission.status === 'FAILED' || kinds.includes('NON_ACCEPTANCE_PROVEN'),
    };
  });

/**
 * The latest CONCLUSIVE delivery fact by the owner's own order (attempt number, then `recordedSeq`), never by the provider's
 * clock. Conclusive is a delivery, a permanent bounce or a drop; a transient bounce concludes nothing.
 */
const latestConclusiveDelivery = (facts: IntentTimelineFacts): ObservationFacts | undefined => {
  const attemptNumbers = new Map(facts.attempts.map(({ attemptId, attemptNumber }) => [attemptId, attemptNumber]));
  const byDecisionOrder = Order.combine(
    Order.mapInput(Order.Number, ({ attemptId }: ObservationFacts) => attemptNumbers.get(attemptId) ?? 0),
    Order.mapInput(Order.Number, ({ recordedSeq }: ObservationFacts) => recordedSeq),
  );
  return EffectArray.sort(
    facts.observations.filter(
      (observation) =>
        observation.kind === 'DELIVERY_PROVEN' || (observation.kind === 'DELIVERY_FAILED' && !isTransient(observation)),
    ),
    byDecisionOrder,
  ).at(-1);
};

/** The headline of one intent: the strongest thing the facts PROVE, and nothing stronger. */
export const summarizeIntent = (facts: IntentTimelineFacts): IntentHistorySummary => {
  const resolved = resolveAttempts(facts);
  const contradictory = resolved.some(({ effect }) => effect === 'CONTRADICTORY');
  const providerAccepted = resolved.some(({ effect }) => effect === 'PRESENT');
  const latestDelivery = latestConclusiveDelivery(facts);
  const deliveryProven = latestDelivery?.kind === 'DELIVERY_PROVEN' && !contradictory;
  const withStatus = (status: HistoryStatus): IntentHistorySummary => ({
    contradictory,
    deliveryProven,
    needsReconciliation: facts.conflicts.length > 0,
    providerAccepted,
    status,
  });
  // an attempt that provably submitted nothing (no adapter, or no request made) never let a stopped message leave
  const mayHaveLeft = facts.attempts.some(
    ({ reason, state }) => submissionFactOfAttempt(state, reason).technical !== 'NOT_ATTEMPTED',
  );
  if (facts.intent.status !== 'PENDING_HANDOFF') {
    return withStatus('SUPPRESSED');
  }
  if (facts.stops.length > 0 && !mayHaveLeft) {
    // one proven stop is final; a stop that only could not establish a fact is held, with its reason, for re-evaluation
    return withStatus(facts.stops.some(({ proven }) => proven) ? 'SUPPRESSED' : 'HELD_UNPROVEN');
  }
  if (contradictory) {
    return withStatus('INDETERMINATE');
  }
  if (latestDelivery !== undefined) {
    return withStatus(deliveryProven ? 'DELIVERED' : 'FAILED');
  }
  if (providerAccepted) {
    // accepted, then only a soft bounce: the provider may still deliver, so this is neither a delivery nor a sure failure
    return withStatus(facts.observations.some(isTransient) ? 'DELIVERY_DEFERRED' : 'PROVIDER_ACCEPTED');
  }
  const unknown = resolved.filter(({ effect }) => effect === 'UNKNOWN');
  if (unknown.length > 0) {
    // an attempt that began and has no answer yet is only SUBMITTED; any recorded unknown answer is INDETERMINATE
    return withStatus(
      unknown.every(({ attempt }) => attempt.state === 'PREPARED') ? 'PROVIDER_SUBMITTED' : 'INDETERMINATE',
    );
  }
  return withStatus(resolved.some(({ proven }) => proven) ? 'FAILED' : 'PREPARED');
};

export const historyOfIntent = (facts: IntentTimelineFacts): IntentHistory => ({
  entries: timelineOf(facts),
  summary: summarizeIntent(facts),
});
