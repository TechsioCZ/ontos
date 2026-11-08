import { Data } from 'effect';

/**
 * Authority or the engine could not be read, so no safe decision exists. This is never a denial:
 * the decision function turns it into the `UNAVAILABLE` outcome, which callers surface as a
 * retryable 503 (guarantee: an unavailable engine is not a deny).
 */
export class AccessDecisionUnavailable extends Data.TaggedError('AccessDecisionUnavailable')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

export const accessDecisionUnavailable = (reason: string, cause?: unknown): AccessDecisionUnavailable =>
  new AccessDecisionUnavailable(cause === undefined ? { reason } : { cause, reason });
