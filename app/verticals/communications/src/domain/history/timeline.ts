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
 * it is DELIVERED only with a delivery observation, FAILED only with a proven failure, and INDETERMINATE whenever the
 * external effect is unknown or the evidence contradicts itself.
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

export interface StopFacts {
  readonly categories: readonly string[];
  readonly evaluationSeq: number;
  readonly proven: boolean;
  readonly recordedAt: DateTime.Utc;
}

export interface IntentTimelineFacts {
  readonly attempts: readonly AttemptFacts[];
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
  PROVIDER_OBSERVED: 5,
  SUBMISSION_ANSWERED: 4,
} satisfies Record<HistoryEntryKind, number>;

const observationStatus = (kind: ObservationKind): HistoryStatus =>
  Match.value(kind).pipe(
    Match.when('ACCEPTANCE_PROVEN', () => 'PROVIDER_ACCEPTED' as const),
    Match.when('DELIVERY_PROVEN', () => 'DELIVERED' as const),
    // a proven non-acceptance and a failure after acceptance are both proven failures of this message
    Match.whenOr('DELIVERY_FAILED', 'NON_ACCEPTANCE_PROVEN', () => 'FAILED' as const),
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
      status: observationStatus(observation.kind),
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
    status: 'SUPPRESSED',
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
    [...decisionDrafts(facts), ...attemptDrafts(facts), ...observationDrafts(facts)],
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

const DELIVERY_CLASS: ReadonlySet<ObservationKind> = new Set(['DELIVERY_FAILED', 'DELIVERY_PROVEN']);

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

/** The headline of one intent: the strongest thing the facts PROVE, and nothing stronger. */
export const summarizeIntent = (facts: IntentTimelineFacts): IntentHistorySummary => {
  const resolved = resolveAttempts(facts);
  const contradictory = resolved.some(({ effect }) => effect === 'CONTRADICTORY');
  const providerAccepted = resolved.some(({ effect }) => effect === 'PRESENT');
  const latestDelivery = timelineOf(facts).findLast(
    ({ observationKind }) => observationKind !== null && DELIVERY_CLASS.has(observationKind),
  );
  const deliveryProven = latestDelivery?.observationKind === 'DELIVERY_PROVEN' && !contradictory;
  const withStatus = (status: HistoryStatus): IntentHistorySummary => ({
    contradictory,
    deliveryProven,
    providerAccepted,
    status,
  });
  const mayHaveLeft = facts.attempts.some(({ state }) => state !== 'NOT_ATTEMPTED');
  if (facts.intent.status !== 'PENDING_HANDOFF' || (facts.stops.length > 0 && !mayHaveLeft)) {
    return withStatus('SUPPRESSED');
  }
  if (contradictory) {
    return withStatus('INDETERMINATE');
  }
  if (latestDelivery !== undefined) {
    return withStatus(deliveryProven ? 'DELIVERED' : 'FAILED');
  }
  if (providerAccepted) {
    return withStatus('PROVIDER_ACCEPTED');
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
