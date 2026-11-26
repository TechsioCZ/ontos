import { Data } from 'effect';

/** The owner's own store could not be read: never an empty answer, always a typed, retryable failure. */
export class SourceOutcomeUnavailable extends Data.TaggedError('SourceOutcomeUnavailable')<{
  readonly reason: string;
}> {}
