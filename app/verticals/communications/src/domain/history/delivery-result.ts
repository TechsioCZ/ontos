import type { EmailDeliveryError, EmailDeliveryReceipt } from '@app/email-delivery/server';
import { Match } from 'effect';

import type { HistoryStatus } from '../../../shared/communication-history.ts';
import type { ProviderEvidenceCase } from '../handoff/message-handoff.ts';
import type { AttemptEffect, AttemptState, ObservationKind, TechnicalEvidence } from './vocabulary.ts';

/**
 * How one SUBMISSION answer reads in the history vocabulary (#1402). The answer comes from `@app/email-delivery` (through the
 * Messaging Adapter of step 22 and the handoff port of the intake lane) and is mapped here, in ONE place, so no other code
 * decides what a provider answer means. The rules are the contract of ADR-0022:
 *
 * - `accepted: true` is PROVIDER_ACCEPTED: the provider took the API submission. It is NEVER delivered;
 * - an indeterminate acceptance is INDETERMINATE: it may or may not have been accepted. It is NEVER a sure failure;
 * - Rejected, Unavailable and InvalidMessage are DISTINCT technical evidence. A rejection and an invalid message prove that
 *   nothing was accepted (FAILED); an unavailable provider does not prove it (INDETERMINATE), exactly as the attempt state
 *   machine already treats it: nothing may be resent blindly after it.
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

/** The submission fact of a stored attempt state (and the reason its evidence kept, if any). */
export const submissionFactOfAttempt = (state: AttemptState, reason?: string): SubmissionFact =>
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
    Match.when('UNAVAILABLE', (): SubmissionFact => ({
      effect: 'UNKNOWN',
      reason,
      status: 'INDETERMINATE',
      technical: 'PROVIDER_UNAVAILABLE',
    })),
    Match.when('INDETERMINATE', (): SubmissionFact => ({
      effect: 'UNKNOWN',
      reason,
      status: 'INDETERMINATE',
      technical: 'ACCEPTANCE_INDETERMINATE',
    })),
    // no adapter exists: provably nothing was submitted, so the intent is still only prepared
    Match.when('NOT_ATTEMPTED', (): SubmissionFact => ({
      effect: 'ABSENT',
      reason,
      status: 'PREPARED',
      technical: 'NOT_ATTEMPTED',
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

/** The submission fact of an answer of the handoff port (the vocabulary the pre-handoff worker records). */
export const submissionFactOfEvidence = (evidence: ProviderEvidenceCase): SubmissionFact =>
  submissionFactOfAttempt(evidence.kind, evidence.kind === 'ACCEPTED' ? undefined : evidence.reason);

/** A provider answer exactly as `EmailDeliveryService.send` produces it: a receipt, or one of its four typed errors. */
export type EmailDeliveryResult = EmailDeliveryError | EmailDeliveryReceipt;

/** The submission fact of a result of `EmailDeliveryService`, covering every outcome the service can produce. */
export const submissionFactOfEmailDelivery = (result: EmailDeliveryResult): SubmissionFact => {
  if ('accepted' in result) {
    return submissionFactOfAttempt('ACCEPTED');
  }
  return Match.value(result).pipe(
    Match.tag('EmailDeliveryAcceptanceIndeterminate', ({ reason }) => submissionFactOfAttempt('INDETERMINATE', reason)),
    Match.tag('EmailDeliveryRejected', ({ reason }) => submissionFactOfAttempt('REJECTED', reason)),
    Match.tag('EmailDeliveryUnavailable', ({ reason }) => submissionFactOfAttempt('UNAVAILABLE', reason)),
    // our own message was malformed and the provider was never asked: a PROVEN failure, with its own evidence
    Match.tag('EmailDeliveryInvalidMessage', ({ reason }): SubmissionFact => ({
      effect: 'ABSENT',
      reason,
      status: 'FAILED',
      technical: 'MESSAGE_INVALID',
    })),
    Match.exhaustive,
  );
};

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
