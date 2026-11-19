import { DateTime } from 'effect';

import type {
  AttemptFacts,
  ConflictFacts,
  IntentTimelineFacts,
  ObservationFacts,
  StopFacts,
} from '../../../src/domain/history/timeline.ts';
import type { AttemptState, FailureClass, ObservationKind } from '../../../src/domain/history/vocabulary.ts';

/**
 * Fictional facts of the history. Every id, time and reason is invented; nothing here is provider evidence. A minute offset is
 * the only time axis, so an ordering in a test is always visible in its numbers.
 */
export const minute = (offset: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 12, offset));

export const INTENT_ID = '11111111-1111-4111-8111-111111111111';
export const ATTEMPT_1 = '22222222-2222-4222-8222-222222222221';
export const ATTEMPT_2 = '22222222-2222-4222-8222-222222222222';

interface AttemptOptions {
  readonly finished?: number;
  readonly id?: string;
  readonly number?: number;
  readonly prepared?: number;
  readonly reason?: string;
}

/** An attempt that began at `prepared` and, unless `state` is PREPARED, was answered at `finished`. */
export const attempt = (state: AttemptState, options: AttemptOptions = {}): AttemptFacts => {
  const prepared = options.prepared ?? 1;
  return {
    attemptId: options.id ?? ATTEMPT_1,
    attemptNumber: options.number ?? 1,
    finishedAt: state === 'PREPARED' ? undefined : minute(options.finished ?? prepared + 1),
    preparedAt: minute(prepared),
    reason: options.reason,
    state,
  };
};

interface ObservationOptions {
  readonly attemptId?: string;
  readonly failureClass?: FailureClass;
  readonly observed: number;
  readonly recorded?: number;
}

let sequence = 0;
/** One observation: `observed` is the provider's own minute, `recorded` this owner's. */
export const observation = (kind: ObservationKind, options: ObservationOptions): ObservationFacts => {
  sequence += 1;
  return {
    attemptId: options.attemptId ?? ATTEMPT_1,
    failureClass: options.failureClass,
    kind,
    observationId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    observedAt: minute(options.observed),
    recordedAt: minute(options.recorded ?? options.observed),
    recordedSeq: sequence,
  };
};

interface ConflictOptions {
  readonly attemptId?: string;
  readonly observationId?: string;
  readonly observed: number;
  readonly recorded?: number;
}

/** A re-delivery of the identity of `kind` with another content: only the trace, the first observation is untouched. */
export const conflict = (kind: ObservationKind, options: ConflictOptions): ConflictFacts => {
  sequence += 1;
  return {
    attemptId: options.attemptId ?? ATTEMPT_1,
    kind,
    observationId: options.observationId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    observedAt: minute(options.observed),
    recordedAt: minute(options.recorded ?? options.observed),
    recordedSeq: sequence,
  };
};

interface StopOptions {
  readonly at?: number;
  readonly categories?: readonly string[];
  readonly proven?: boolean;
  readonly seq?: number;
}

export const stop = (options: StopOptions = {}): StopFacts => ({
  categories: options.categories ?? ['PRIVACY_NOT_ALLOWED'],
  evaluationSeq: options.seq ?? 1,
  proven: options.proven ?? true,
  recordedAt: minute(options.at ?? 1),
});

interface FactsParts {
  readonly attempts?: readonly AttemptFacts[];
  readonly conflicts?: readonly ConflictFacts[];
  readonly intentStatus?: 'NOT_SENT' | 'PENDING_HANDOFF' | 'SUPPRESSED';
  readonly observations?: readonly ObservationFacts[];
  readonly reason?: string;
  readonly stops?: readonly StopFacts[];
}

export const factsOf = (parts: FactsParts): IntentTimelineFacts => ({
  attempts: parts.attempts ?? [],
  conflicts: parts.conflicts ?? [],
  intent: {
    createdAt: minute(0),
    intentId: INTENT_ID,
    reason: parts.reason,
    status: parts.intentStatus ?? 'PENDING_HANDOFF',
  },
  observations: parts.observations ?? [],
  stops: parts.stops ?? [],
});
