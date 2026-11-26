import { Schema } from 'effect';

/** Expected failure: the previous issuance of an enrollment replay and its outcome cannot be established. Nothing new is sent. */
export class VerificationReplayUnavailable extends Schema.TaggedError<VerificationReplayUnavailable>()(
  'VerificationReplayUnavailable',
  { reason: Schema.Literals(['OUTCOME_UNAVAILABLE', 'PREVIOUS_ISSUANCE_EXPIRED', 'PREVIOUS_ISSUANCE_STOPPED']) },
) {}
