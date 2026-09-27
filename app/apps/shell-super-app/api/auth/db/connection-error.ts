import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class AuthDatabaseConnectionError extends Data.TaggedError('AuthDatabaseConnectionError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
