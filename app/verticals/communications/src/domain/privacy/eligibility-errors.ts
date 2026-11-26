import { Data, Schema } from 'effect';

/**
 * Why no decision was reached. None of these is a Privacy outcome and none may ever become `NOT_ALLOWED`:
 * - AUTHORIZATION_DENIED: the calling Principal may not read Privacy eligibility (also after access was withdrawn);
 * - OWNER_UNAVAILABLE: the Privacy owner, its authority or the call did not answer (timeout, outage, defect);
 * - CONTEXT_AMBIGUOUS: the request or the located subject does not resolve to exactly one Privacy context.
 */
const UnavailableReasonSchema = Schema.Literals(['AUTHORIZATION_DENIED', 'OWNER_UNAVAILABLE', 'CONTEXT_AMBIGUOUS']);
export type UnavailableReason = typeof UnavailableReasonSchema.Type;

export class ProcessingEligibilityUnavailable extends Data.TaggedError('ProcessingEligibilityUnavailable')<{
  readonly reason: UnavailableReason;
}> {}
