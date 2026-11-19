import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import type { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { observationIdOf } from '../domain/history/provider-observation.ts';
import type { ProviderObservationInput } from '../domain/history/provider-observation.ts';
import { CONFLICT_RESOLUTION_REASON_CODE } from '../domain/recovery/vocabulary.ts';
import { processIntentHandoff, storeUnavailable } from '../handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../handoff/process-intent-handoff.ts';
import { ingestProviderObservation, resolveObservationConflict } from '../history/provider-observations.ts';
import type { IngestAnswerSchema } from '../history/provider-observations.ts';
import { StoredIntentFactsSchema } from '../history/stored-intent-facts.ts';
import type { StoredIntentFacts } from '../history/stored-intent-facts.ts';
import { workerFinishAttemptRoutine, workerReadIntentRoutine } from '../persistence/communications-routines.ts';

/**
 * Reconciliation of an uncertain external effect (#1403). While an effect is unknown nothing is submitted: the pre-handoff step
 * skips the intent. What ends the doubt is EVIDENCE that step 22 reconciled, handed over through the one input contract of the
 * history (`ProviderObservationInput`) and appended as observations. Nothing here deletes or edits anything:
 *
 * - the original indeterminate answer stays, and so does every observation; the reconciliation is one more fact;
 * - a proven ACCEPTANCE ends the doubt the other way: it is recorded, and the next evaluation never repeats the send;
 * - a proven NON-acceptance lets the SAME intent continue, but only through the next evaluation of the pre-handoff step, which
 *   asks every Current gate again and needs an approved recovery rule: this flow never begins an attempt;
 * - a conflict of provider evidence is settled by a RESOLUTION fact appended when a reconciliation of the same attempt arrived
 *   after it, never by removing the conflict;
 * - an attempt that was begun and never answered (a crash between the call and its evidence) is closed as an unanswered
 *   INDETERMINATE once a reconciliation proved non-acceptance, so it can be the basis of a retry; it is never closed otherwise.
 *
 * There is no real step 22 yet: the evidence of this flow is the labelled double of the tests, and a production composition
 * calls this flow only when the Messaging Adapter exists. No endpoint, callback or scheduler is created here.
 */

/** The closed reason of an attempt that never recorded an answer; it is not a provider vocabulary reason. */
const NO_ANSWER_RECORDED = 'no_answer_recorded';

export interface ReconciliationInput {
  /** The evidence step 22 reconciled, each item bound to its own Tenant, intent and attempt. */
  readonly evidence: readonly ProviderObservationInput[];
  readonly intentId: typeof MessageIntentIdSchema.Type;
}

export interface ReconciliationOutcome {
  /** One answer per observation, in the order given. */
  readonly answers: readonly (typeof IngestAnswerSchema.Type)['outcome'][];
  /** Attempts closed as unanswered because a reconciliation proved they were not accepted. */
  readonly closedAttempts: number;
  /** Conflicts of provider evidence settled by an appended resolution. */
  readonly resolvedConflicts: number;
}

/** The observations that prove an effect: with any of them an unanswered attempt is never closed as "not accepted". */
const PRESENCE_KINDS: ReadonlySet<string> = new Set(['ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN']);

const sumOf = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);

interface Reconciliation {
  readonly attemptId: string;
  readonly observationId: string;
}

/** Appends a resolution for every unresolved conflict of an attempt that a reconciliation recorded after it settles. */
const settleConflicts = Effect.fn('Communications.settleConflicts')(function* settle(
  invoker: ScopedRoutineInvoker,
  intentId: typeof MessageIntentIdSchema.Type,
  facts: StoredIntentFacts,
  reconciliations: readonly Reconciliation[],
) {
  const settled = yield* Effect.forEach(
    facts.conflicts.filter(({ resolvedAt }) => resolvedAt === undefined),
    (conflict) =>
      Option.match(Option.fromNullishOr(reconciliations.find(({ attemptId }) => attemptId === conflict.attemptId)), {
        onNone: () => Effect.succeed(0),
        onSome: (basis) =>
          resolveObservationConflict(invoker, {
            basisObservationId: basis.observationId,
            conflictId: conflict.conflictId,
            intentId,
            reasonCode: CONFLICT_RESOLUTION_REASON_CODE,
          }).pipe(Effect.map((outcome) => (outcome === 'RESOLVED' ? 1 : 0))),
      }),
    { concurrency: 1 },
  );
  return sumOf(settled);
});

/** Closes an attempt that never recorded an answer, but only when a reconciliation proved it was not accepted. */
const closeUnansweredAttempts = Effect.fn('Communications.closeUnansweredAttempts')(function* close(
  invoker: ScopedRoutineInvoker,
  facts: StoredIntentFacts,
) {
  const proven = facts.attempts.filter(({ attemptId, state }) => {
    const kinds = facts.observations.flatMap((observation) =>
      observation.attemptId === attemptId ? [observation.kind] : [],
    );
    return (
      state === 'PREPARED' && kinds.includes('NON_ACCEPTANCE_PROVEN') && !kinds.some((kind) => PRESENCE_KINDS.has(kind))
    );
  });
  yield* Effect.forEach(
    proven,
    ({ attemptId }) =>
      invoker
        .invoke(workerFinishAttemptRoutine, [
          attemptId,
          'INDETERMINATE',
          { kind: 'INDETERMINATE', reason: NO_ANSWER_RECORDED },
        ])
        .pipe(Effect.mapError((cause) => storeUnavailable('The unanswered attempt could not be closed', cause))),
    { concurrency: 1, discard: true },
  );
  return proven.length;
});

/** One scoped transaction: append the evidence, settle what the evidence settles, and say what changed. */
export const reconcileProviderEvidence = Effect.fn('Communications.reconcileProviderEvidence')(function* reconcile(
  input: ReconciliationInput,
  scoped: ScopedRunner,
) {
  return yield* scoped(
    Effect.fn('Communications.reconcileInScope')(function* settleInScope(invoker) {
      const answers = yield* Effect.forEach(
        input.evidence,
        (observation) => ingestProviderObservation(invoker, observation),
        { concurrency: 1 },
      );
      // the evidence that the owner bound to this intent and that is, or already was, recorded as a RECONCILIATION
      const recorded = input.evidence.filter(
        (observation, index) =>
          observation.intentId === input.intentId &&
          observation.evidence.basis === 'RECONCILIATION' &&
          (answers[index] === 'RECORDED' || answers[index] === 'DUPLICATE'),
      );
      const reconciliations = yield* Effect.forEach(
        recorded,
        (observation) =>
          observationIdOf(observation).pipe(
            Effect.map((observationId): Reconciliation => ({ attemptId: observation.attemptId, observationId })),
          ),
        { concurrency: 1 },
      );
      const rows = yield* invoker
        .invoke(workerReadIntentRoutine, [input.intentId])
        .pipe(Effect.mapError((cause) => storeUnavailable('The Message Intent could not be read', cause)));
      const facts = yield* Schema.decodeUnknownEffect(StoredIntentFactsSchema)(rows[0]?.result).pipe(
        Effect.mapError((cause) => storeUnavailable('The Message Intent document was unreadable', cause)),
      );
      const { closedAttempts, resolvedConflicts } = yield* Effect.all(
        {
          closedAttempts: closeUnansweredAttempts(invoker, facts),
          resolvedConflicts: settleConflicts(invoker, input.intentId, facts, reconciliations),
        },
        { concurrency: 1 },
      );
      return { answers, closedAttempts, resolvedConflicts } satisfies ReconciliationOutcome;
    }),
  );
});

/**
 * Reconciles and then lets the SAME pre-handoff step evaluate the intent again: acceptance proven (nothing is sent), non-acceptance
 * proven (the same intent continues only if its approved rule and every Current gate allow it), or still unknown (nothing is sent).
 */
export const reconcileAndEvaluate = Effect.fn('Communications.reconcileAndEvaluate')(function* reconcileThenEvaluate(
  input: ReconciliationInput & { readonly tenantId: string },
  scoped: ScopedRunner,
) {
  const reconciliation = yield* reconcileProviderEvidence(input, scoped);
  const processing = yield* processIntentHandoff({ intentId: input.intentId, tenantId: input.tenantId }, scoped);
  return { processing, reconciliation };
});
