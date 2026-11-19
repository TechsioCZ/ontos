import { Data } from 'effect';

/** Expected failure: the source owner could not say. It is uncertainty, never permission and never a refusal. */
export class SourceScopeVisibilityUnavailable extends Data.TaggedError('SourceScopeVisibilityUnavailable')<{
  readonly reason: 'OWNER_UNAVAILABLE';
}> {}
