import { Array as EffectArray, Option, Order } from 'effect';
import type { DateTime } from 'effect';

import type { RecoveryPolicy } from '../catalog/message-type.ts';
import { submissionFactOfAttempt } from '../history/delivery-result.ts';
import type { IntentTimelineFacts } from '../history/timeline.ts';
import { canAttemptAfterUnknownEffect, effectBlockOf } from '../history/unknown-effect.ts';
import { PERMANENT_REJECTION_REASON, rejectionClassOf } from './vocabulary.ts';
import type { RecoveryHaltCode, RecoveryStopReason, RetryBasis } from './vocabulary.ts';

/**
 * Retry eligibility of ONE Message Intent (#1403): whether the pre-handoff step may begin ANOTHER attempt of the SAME intent.
 * It is decided in two pure halves so the step never asks another owner a question whose answer cannot matter:
 *
 * 1. `assessAttemptHistory`: what the append-only history and the approved recovery rule of the type allow, BEFORE any gate.
 *    Evidence of the attempts is the only input here: no attempt yet, an attempt that provably submitted nothing, a provider
 *    refusal (temporary or permanent), a reconciled non-acceptance, an unknown effect, an acceptance. Nothing but a PROVEN
 *    non-acceptance (or nothing submitted at all) ever leads to another attempt, and never a timeout, never an unavailable
 *    provider and never an indeterminate answer, whatever the approved rule says.
 * 2. `confirmContinuation`: the Current gates (source validity, ORIGINAL endpoint and recipient, Privacy for the stored scope,
 *    language and template pin) asked AGAIN now. A retained earlier answer is never an input: the verdict needs the cleared
 *    gates and the history guard `canAttemptAfterUnknownEffect`, evaluated after the latest reconciliation evidence.
 *
 * A continuation is the same intent: recipient, endpoint, language, template revision and Privacy scope are pins of the immutable
 * intent that no part of this evaluation reads or changes. No count, interval, backoff or waiting time exists here: the only
 * number is the owner's own approved limit carried by the type's recovery rule, and without a rule nothing is automatic.
 */

/** What the history and the recovery rule of the type say about the next step, before any Current gate. */
export type HistoryAssessment =
  /** No attempt exists yet: the first handoff of the intent (no recovery rule is involved). */
  | { readonly kind: 'FIRST_ATTEMPT' }
  /** Another attempt may follow `previousAttemptId` for this proven reason, if the Current gates allow it now. */
  | { readonly basis: RetryBasis; readonly kind: 'CONTINUE'; readonly previousAttemptId: string }
  /** Nothing is begun and nothing is recorded: an acceptance is proven, or the effect is unknown or contradicted. */
  | { readonly kind: 'SKIP'; readonly reason: 'ALREADY_FINISHED' | 'RECONCILIATION_REQUIRED' }
  /** Proven non-acceptance, but automatic action is not performed for this closed reason; the source owner decides. */
  | { readonly attemptId: string; readonly code: RecoveryHaltCode; readonly kind: 'HALT' }
  /** A proven fact stops the continuation for good (a documented permanent refusal). */
  | { readonly attemptId: string; readonly kind: 'STOP'; readonly reasons: readonly [RecoveryStopReason] };

const byAttemptNumber = Order.mapInput(
  Order.Number,
  (attempt: IntentTimelineFacts['attempts'][number]) => attempt.attemptNumber,
);

type RecoveryFactsInput = Pick<IntentTimelineFacts, 'attempts' | 'conflicts' | 'observations'>;

/** The proof that the provider did not accept the latest attempt, when a reconciliation recorded one. */
const reconciledNonAcceptance = (facts: RecoveryFactsInput, attemptId: string) =>
  EffectArray.sort(
    facts.observations.filter(
      ({ attemptId: observed, kind }) => observed === attemptId && kind === 'NON_ACCEPTANCE_PROVEN',
    ),
    Order.mapInput(Order.Number, (observation: RecoveryFactsInput['observations'][number]) => observation.recordedSeq),
  ).at(-1);

export const assessAttemptHistory = (facts: RecoveryFactsInput, policy: RecoveryPolicy): HistoryAssessment => {
  const blocked = effectBlockOf(facts);
  if (Option.isSome(blocked)) {
    // an acceptance is never repeated; an unknown or contradicted effect is reconciled first, never retried (R-05)
    return {
      kind: 'SKIP',
      reason: blocked.value === 'ACCEPTANCE_ALREADY_PROVEN' ? 'ALREADY_FINISHED' : 'RECONCILIATION_REQUIRED',
    };
  }
  const latest = EffectArray.sort(facts.attempts, byAttemptNumber).at(-1);
  if (latest === undefined) {
    return { kind: 'FIRST_ATTEMPT' };
  }
  const answer = submissionFactOfAttempt(latest.state, latest.reason);
  if (answer.technical === 'NOT_ATTEMPTED') {
    // no request left the process (no adapter, or no usable configuration): the intent was never in doubt, no rule is needed
    return { basis: { kind: 'PRIOR_NOT_ATTEMPTED' }, kind: 'CONTINUE', previousAttemptId: latest.attemptId };
  }
  const rejected = latest.state === 'REJECTED';
  const basis: Option.Option<RetryBasis> = rejected
    ? Option.some({ kind: 'PRIOR_REJECTED' })
    : Option.map(Option.fromNullishOr(reconciledNonAcceptance(facts, latest.attemptId)), ({ observationId }) => ({
        kind: 'RECONCILED_NON_ACCEPTANCE' as const,
        observationId,
      }));
  if (Option.isNone(basis)) {
    // every attempt is provably absent here, so one of the two proofs must exist; anything else is not proof
    return { kind: 'SKIP', reason: 'RECONCILIATION_REQUIRED' };
  }
  if (rejected && rejectionClassOf(latest.reason) === 'PERMANENT') {
    return { attemptId: latest.attemptId, kind: 'STOP', reasons: [PERMANENT_REJECTION_REASON] };
  }
  if (policy.kind === 'NONE') {
    return { attemptId: latest.attemptId, code: 'NO_RECOVERY_RULE', kind: 'HALT' };
  }
  const submitted = facts.attempts.filter(
    ({ reason, state }) => submissionFactOfAttempt(state, reason).technical !== 'NOT_ATTEMPTED',
  ).length;
  if (submitted >= policy.maxAttempts) {
    return { attemptId: latest.attemptId, code: 'RECOVERY_LIMIT_REACHED', kind: 'HALT' };
  }
  return { basis: basis.value, kind: 'CONTINUE', previousAttemptId: latest.attemptId };
};

/** The Current gates as the step asked them NOW: cleared, or stopped with every distinct reason (proven ones first). */
export type CurrentGates =
  | { readonly kind: 'CLEARED' }
  | { readonly kind: 'STOPPED'; readonly reasons: readonly RecoveryStopReason[] };

export type Continuation =
  /** Begin the FIRST attempt of the intent. */
  | { readonly kind: 'BEGIN_FIRST' }
  /** Begin the next attempt of the SAME intent, after `previousAttemptId`, for the proven reason `basis`. */
  | { readonly basis: RetryBasis; readonly kind: 'BEGIN_RETRY'; readonly previousAttemptId: string }
  | { readonly kind: 'SKIP'; readonly reason: 'RECONCILIATION_REQUIRED' }
  | { readonly kind: 'STOP'; readonly reasons: readonly RecoveryStopReason[] };

/**
 * The final verdict of a continuation (`FIRST_ATTEMPT` or `CONTINUE`) once the Current gates answered. The history guard is the
 * last word: the evaluation counts as Current only if it was made AFTER every reconciliation evidence was recorded, so an answer
 * obtained earlier can never open a send (R-06).
 */
export const confirmContinuation = (
  facts: RecoveryFactsInput,
  assessment: Extract<HistoryAssessment, { readonly kind: 'CONTINUE' | 'FIRST_ATTEMPT' }>,
  gates: CurrentGates,
  evaluatedAt: DateTime.Utc,
): Continuation => {
  if (gates.kind === 'STOPPED') {
    return { kind: 'STOP', reasons: gates.reasons };
  }
  if (!canAttemptAfterUnknownEffect(facts, Option.some({ eligible: true, evaluatedAt }))) {
    return { kind: 'SKIP', reason: 'RECONCILIATION_REQUIRED' };
  }
  return assessment.kind === 'FIRST_ATTEMPT'
    ? { kind: 'BEGIN_FIRST' }
    : { basis: assessment.basis, kind: 'BEGIN_RETRY', previousAttemptId: assessment.previousAttemptId };
};
