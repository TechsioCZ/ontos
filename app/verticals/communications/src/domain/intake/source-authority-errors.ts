import { Data } from 'effect';

/** The source owner could not state the current facts of the occurrence; no decision is made on a guess. */
export class SourceOccurrenceUnavailable extends Data.TaggedError('SourceOccurrenceUnavailable')<{
  readonly reason: 'OWNER_UNAVAILABLE' | 'OCCURRENCE_UNKNOWN';
}> {}
