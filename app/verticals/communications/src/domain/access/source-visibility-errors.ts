import { Data } from 'effect';

/**
 * Expected failure: the source owner could not say. It is uncertainty, never permission and never a refusal.
 * `OWNER_UNAVAILABLE` is a transient outage a retry may repair; `NOT_COMPOSED` means no source owner publishes a visibility
 * Read in this deployment, so no retry can ever succeed and it must not be told as a retryable outage.
 */
export class SourceScopeVisibilityUnavailable extends Data.TaggedError('SourceScopeVisibilityUnavailable')<{
  readonly reason: 'NOT_COMPOSED' | 'OWNER_UNAVAILABLE';
}> {}
