import { Schema } from 'effect';

import { DeliveryAttemptIdSchema } from '../../shared/communication-intake.ts';
import { FailureClassSchema, ObservationKindSchema, AttemptStateSchema } from '../domain/history/vocabulary.ts';
import type { IntentTimelineFacts } from '../domain/history/timeline.ts';

/**
 * The append-only facts of ONE intent as the scoped read routine `worker_read_intent` returns them, decoded with this owner's
 * own Schema (a stored document is never trusted as typed). They are exactly what the effect guard and the retry evaluation read:
 * attempts with the closed reason of their answer, provider observations by kind, conflicts with the time their resolution was
 * appended, handoff stops and recovery evaluations. No address, secret, link, markup or provider payload can be in it.
 */
const Instant = Schema.DateTimeUtcFromString;
const OptionalInstant = Schema.optionalKey(Instant);
const uuid = Schema.String.check(Schema.isUUID());
/** The identity of one provider observation, and of one conflict of provider evidence, each its own type. */
export const ObservationIdSchema = uuid.pipe(Schema.brand('ProviderObservationId'));
export const ObservationConflictIdSchema = uuid.pipe(Schema.brand('ProviderObservationConflictId'));

export const StoredIntentFactsSchema = Schema.Struct({
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: DeliveryAttemptIdSchema,
      attemptNumber: Schema.Number,
      finishedAt: OptionalInstant,
      preparedAt: Instant,
      reason: Schema.optionalKey(Schema.String),
      state: AttemptStateSchema,
    }),
  ),
  conflicts: Schema.Array(
    Schema.Struct({
      attemptId: DeliveryAttemptIdSchema,
      conflictId: ObservationConflictIdSchema,
      kind: ObservationKindSchema,
      observationId: ObservationIdSchema,
      observedAt: Instant,
      recordedAt: Instant,
      recordedSeq: Schema.Number,
      resolvedAt: OptionalInstant,
    }),
  ),
  observations: Schema.Array(
    Schema.Struct({
      attemptId: DeliveryAttemptIdSchema,
      failureClass: Schema.optionalKey(FailureClassSchema),
      kind: ObservationKindSchema,
      observationId: ObservationIdSchema,
      observedAt: Instant,
      recordedAt: Instant,
      recordedSeq: Schema.Number,
    }),
  ),
  recoveries: Schema.Array(
    Schema.Struct({
      basisAttemptId: DeliveryAttemptIdSchema,
      code: Schema.String,
      evaluationSeq: Schema.Number,
      outcome: Schema.Literals(['HALTED', 'STOPPED']),
      proven: Schema.Boolean,
      recordedAt: Instant,
    }),
  ),
  stops: Schema.Array(
    Schema.Struct({
      categories: Schema.Array(Schema.String),
      evaluationSeq: Schema.Number,
      proven: Schema.Boolean,
      recordedAt: Instant,
    }),
  ),
});
export type StoredIntentFacts = typeof StoredIntentFactsSchema.Type;

/** The facts the guard, the evaluator and the timeline read, in their own shape. */
export const timelineFactsOfStored = (
  facts: StoredIntentFacts,
): Pick<IntentTimelineFacts, 'attempts' | 'conflicts' | 'observations' | 'recoveries' | 'stops'> => ({
  attempts: facts.attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    finishedAt: attempt.finishedAt,
    preparedAt: attempt.preparedAt,
    reason: attempt.reason,
    state: attempt.state,
  })),
  conflicts: facts.conflicts.map(
    ({ attemptId, kind, observationId, observedAt, recordedAt, recordedSeq, resolvedAt }) => ({
      attemptId,
      kind,
      observationId,
      observedAt,
      recordedAt,
      recordedSeq,
      resolvedAt,
    }),
  ),
  observations: facts.observations.map(
    ({ attemptId, failureClass, kind, observationId, observedAt, recordedAt, recordedSeq }) => ({
      attemptId,
      failureClass,
      kind,
      observationId,
      observedAt,
      recordedAt,
      recordedSeq,
    }),
  ),
  recoveries: facts.recoveries,
  stops: facts.stops,
});
