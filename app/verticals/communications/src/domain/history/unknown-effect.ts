import { DateTime, Option, Schema } from 'effect';

import { effectAfterObservations, submissionFactOfAttempt } from './delivery-result.ts';
import type { IntentTimelineFacts } from './timeline.ts';

/**
 * The guard the retry lane (d21-10, #1403) calls BEFORE it begins any attempt that could duplicate an earlier one (H-08).
 * It decides nothing about policy: it only says whether the HISTORY allows another potentially duplicating send. A fresh
 * Current eligibility is an input, never assumed.
 *
 * - while any attempt has an UNKNOWN effect (no answer recorded, an indeterminate or unavailable answer) no further send is
 *   allowed: only a reconciliation that proves non-acceptance ends the doubt;
 * - once any attempt is known to have been ACCEPTED no technical retry exists: a second send would duplicate it, and a
 *   deliberate Explicit Resend is a new intent, not an attempt of this one;
 * - contradictory evidence is never resolved in favour of sending;
 * - a proven absence of every earlier effect still needs a Current eligibility evaluated AFTER the reconciliation evidence
 *   was recorded, and it must have allowed the message. A retained or earlier answer is not Current.
 */

export const UnknownEffectBlockSchema = Schema.Literals([
  'ACCEPTANCE_ALREADY_PROVEN',
  'CONTRADICTORY_EVIDENCE',
  'ELIGIBILITY_NOT_ELIGIBLE',
  'ELIGIBILITY_NOT_FRESH',
  'RECONCILIATION_REQUIRED',
]);
export type UnknownEffectBlock = typeof UnknownEffectBlockSchema.Type;

/** A Current eligibility evaluation as the retry lane obtained it: when it was evaluated and what it answered. */
export interface FreshEligibility {
  readonly eligible: boolean;
  readonly evaluatedAt: DateTime.Utc;
}

/** Why another potentially duplicating send is NOT allowed now; none means the history allows it. */
export const unknownEffectBlock = (
  facts: IntentTimelineFacts,
  eligibility: Option.Option<FreshEligibility>,
): Option.Option<UnknownEffectBlock> => {
  const effects = new Set(
    facts.attempts.map((attempt) =>
      effectAfterObservations(
        submissionFactOfAttempt(attempt.state, attempt.reason).effect,
        facts.observations.flatMap(({ attemptId, kind }) => (attemptId === attempt.attemptId ? [kind] : [])),
      ),
    ),
  );
  if (effects.has('CONTRADICTORY')) {
    return Option.some('CONTRADICTORY_EVIDENCE');
  }
  if (effects.has('PRESENT')) {
    return Option.some('ACCEPTANCE_ALREADY_PROVEN');
  }
  if (effects.has('UNKNOWN')) {
    return Option.some('RECONCILIATION_REQUIRED');
  }
  if (Option.isNone(eligibility)) {
    // nothing was ever in doubt AND no evaluation was supplied: the guard cannot vouch for a Current fact it was not given
    return Option.some('ELIGIBILITY_NOT_FRESH');
  }
  // the latest reconciliation proof; with none recorded there is nothing the evaluation has to come after
  const reconciledAt = Math.max(
    Number.NEGATIVE_INFINITY,
    ...facts.observations.flatMap(({ kind, recordedAt }) =>
      kind === 'NON_ACCEPTANCE_PROVEN' ? [DateTime.toEpochMillis(recordedAt)] : [],
    ),
  );
  if (DateTime.toEpochMillis(eligibility.value.evaluatedAt) <= reconciledAt) {
    return Option.some('ELIGIBILITY_NOT_FRESH');
  }
  return eligibility.value.eligible ? Option.none() : Option.some('ELIGIBILITY_NOT_ELIGIBLE');
};

/**
 * Whether the history allows another potentially duplicating send of this intent. False until reconciliation evidence
 * exists, and false forever after an acceptance: the retry lane calls this and never decides it on its own.
 */
export const canAttemptAfterUnknownEffect = (
  facts: IntentTimelineFacts,
  eligibility: Option.Option<FreshEligibility>,
): boolean => Option.isNone(unknownEffectBlock(facts, eligibility));
