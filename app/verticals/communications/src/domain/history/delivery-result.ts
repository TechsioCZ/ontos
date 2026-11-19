import { Match } from 'effect';

import type { HistoryStatus } from '../../../shared/communication-history.ts';
import type { AttemptEffect, AttemptState, ObservationKind, TechnicalEvidence } from './vocabulary.ts';

/**
 * How one SUBMISSION answer reads in the history vocabulary (#1402). There is exactly ONE path, and it is the one production
 * uses: the pre-handoff worker stores what the Messaging Adapter answered as an attempt state plus the closed reason literal of
 * the answer, and `submissionFactOfAttempt` reads that stored attempt. The rules are the contract of ADR-0022:
 *
 * - ACCEPTED (`accepted: true`) is PROVIDER_ACCEPTED: the provider took the API submission. It is NEVER delivered;
 * - INDETERMINATE (an indeterminate acceptance) may or may not have been accepted. It is NEVER a sure failure;
 * - REJECTED proves that nothing was accepted (FAILED); UNAVAILABLE because of a provider answer (a 5xx, `provider_unavailable`)
 *   does not prove it (INDETERMINATE), exactly as the attempt state machine already treats it: nothing may be resent blindly;
 * - UNAVAILABLE with the reason `configuration` means the deployment could not even build the request: NO request was made,
 *   so provably nothing was submitted. It reads exactly like NOT_ATTEMPTED (still only prepared, the effect is absent);
 * - MESSAGE_INVALID (`EmailDeliveryInvalidMessage`: our own message was malformed and the provider was never asked) is
 *   expressible here as a PROVEN failure with its own evidence. The stored attempt state machine has NO state for it yet, so no
 *   stored attempt can read as MESSAGE_INVALID today. That is a documented gap for the Messaging Adapter (step 22) and the
 *   recovery lane (d21-10): they add the state by a forward migration and the case below needs no other change.
 */

/** What one submission answer proves on its own, before any later observation. */
export interface SubmissionFact {
  /** What the answer says about the external effect: it left, it provably did not, or nobody knows. */
  readonly effect: Exclude<AttemptEffect, 'CONTRADICTORY'>;
  /** The provider's own closed reason literal, when the answer has one. Never a message, status text or payload. */
  readonly reason: string | undefined;
  readonly status: Extract<
    HistoryStatus,
    'FAILED' | 'INDETERMINATE' | 'PREPARED' | 'PROVIDER_ACCEPTED' | 'PROVIDER_SUBMITTED'
  >;
  readonly technical: TechnicalEvidence;
}

/** A stored attempt state, or the answer no stored state carries yet (see MESSAGE_INVALID above). */
export type SubmissionState = AttemptState | 'MESSAGE_INVALID';

/** The reason of an UNAVAILABLE answer that says no request was made at all (a deployment without a usable configuration). */
export const NO_REQUEST_MADE_REASON = 'configuration';

const notSubmitted = (reason: string | undefined): SubmissionFact => ({
  effect: 'ABSENT',
  reason,
  status: 'PREPARED',
  technical: 'NOT_ATTEMPTED',
});

/** The submission fact of a stored attempt state (and the reason its evidence kept, if any). */
export const submissionFactOfAttempt = (state: SubmissionState, reason?: string): SubmissionFact =>
  Match.value(state).pipe(
    Match.when('ACCEPTED', (): SubmissionFact => ({
      effect: 'PRESENT',
      reason,
      status: 'PROVIDER_ACCEPTED',
      technical: 'PROVIDER_ACCEPTED',
    })),
    Match.when('REJECTED', (): SubmissionFact => ({
      effect: 'ABSENT',
      reason,
      status: 'FAILED',
      technical: 'PROVIDER_REJECTED',
    })),
    // `configuration`: no request was made, so provably nothing was submitted, which a provider that answered 5xx never proves
    Match.when('UNAVAILABLE', (): SubmissionFact =>
      reason === NO_REQUEST_MADE_REASON
        ? notSubmitted(reason)
        : { effect: 'UNKNOWN', reason, status: 'INDETERMINATE', technical: 'PROVIDER_UNAVAILABLE' },
    ),
    Match.when('INDETERMINATE', (): SubmissionFact => ({
      effect: 'UNKNOWN',
      reason,
      status: 'INDETERMINATE',
      technical: 'ACCEPTANCE_INDETERMINATE',
    })),
    // no adapter exists: provably nothing was submitted, so the intent is still only prepared
    Match.when('NOT_ATTEMPTED', (): SubmissionFact => notSubmitted(reason)),
    // our own message was malformed and the provider was never asked: a PROVEN failure, with its own evidence
    Match.when('MESSAGE_INVALID', (): SubmissionFact => ({
      effect: 'ABSENT',
      reason,
      status: 'FAILED',
      technical: 'MESSAGE_INVALID',
    })),
    // recorded BEFORE the call: the handoff was begun and no answer is recorded, so the effect is unknown
    Match.when('PREPARED', (): SubmissionFact => ({
      effect: 'UNKNOWN',
      reason,
      status: 'PROVIDER_SUBMITTED',
      technical: 'SUBMISSION_STARTED',
    })),
    Match.exhaustive,
  );

const PRESENCE_KINDS: ReadonlySet<ObservationKind> = new Set([
  'ACCEPTANCE_PROVEN',
  'DELIVERY_FAILED',
  'DELIVERY_PROVEN',
]);

/**
 * The effect of one attempt after its LATER observations. Evidence only ever adds: an unknown effect becomes known, and
 * evidence that disagrees with the answer or with another observation is reported as CONTRADICTORY, never resolved by
 * preferring one side. A failure after acceptance and a delivery both prove the provider had accepted the submission.
 */
export const effectAfterObservations = (
  submission: Exclude<AttemptEffect, 'CONTRADICTORY'>,
  observations: readonly ObservationKind[],
): AttemptEffect => {
  const present = observations.some((kind) => PRESENCE_KINDS.has(kind));
  const absent = observations.includes('NON_ACCEPTANCE_PROVEN');
  if (present && absent) {
    return 'CONTRADICTORY';
  }
  if (submission === 'UNKNOWN') {
    if (present) {
      return 'PRESENT';
    }
    return absent ? 'ABSENT' : 'UNKNOWN';
  }
  if (submission === 'PRESENT') {
    return absent ? 'CONTRADICTORY' : 'PRESENT';
  }
  return present ? 'CONTRADICTORY' : 'ABSENT';
};

/**
 * The ONE definition of "this attempt may have left the provider boundary" (#1403 review): the technical fact of its stored
 * answer, not its state label. Only an attempt that provably made no request (no adapter, or no usable configuration) did not;
 * every other attempt, answered or not, may have. The timeline, the stop of the pre-handoff step and the recovery limit all read
 * it here, so they can never disagree about whether a stopped message might already have been sent.
 */
export const attemptMayHaveLeft = (attempt: {
  readonly reason?: string | undefined;
  readonly state: SubmissionState;
}) => submissionFactOfAttempt(attempt.state, attempt.reason).technical !== 'NOT_ATTEMPTED';
