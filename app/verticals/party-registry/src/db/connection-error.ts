import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class PartyDatabaseConnectionError extends Data.TaggedError('PartyDatabaseConnectionError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
