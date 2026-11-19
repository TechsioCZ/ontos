import { Data } from 'effect';

/** The owner could not read its own records. Never NO_DATA: the Read turns it into a retryable unavailable answer. */
export class PrivacyOwnerCoverageUnavailable extends Data.TaggedError('PrivacyOwnerCoverageUnavailable')<{
  readonly reason: string;
}> {}
