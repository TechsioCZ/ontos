import { Data } from 'effect';

/** Czech reason becomes the HTTP 422 detail; preserve an underlying validation failure when present. */
export class ConnectionsInvalid extends Data.TaggedError('ConnectionsInvalid')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
