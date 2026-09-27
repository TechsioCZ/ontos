import { Data } from 'effect';

/** The driver failure, when there is one, travels as the native `Error.cause` set by the constructor. */
export class DatabaseConfigError extends Data.TaggedError('DatabaseConfigError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
