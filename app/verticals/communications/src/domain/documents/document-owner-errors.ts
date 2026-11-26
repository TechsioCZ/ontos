import { Data } from 'effect';

/** Expected failure: the document owner (or Core Media) could not answer. Uncertainty, never permission and never a refusal. */
export class DocumentOwnerUnavailable extends Data.TaggedError('DocumentOwnerUnavailable')<{
  readonly reason: 'OWNER_UNAVAILABLE';
}> {}
