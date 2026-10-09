import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class DatabaseConnectionError extends Data.TaggedError('DatabaseConnectionError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
