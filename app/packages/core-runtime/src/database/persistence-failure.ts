import { Data } from 'effect';

/**
 * A persistence operation failed. The driver failure travels as the native `Error.cause`, set by the
 * constructor, so diagnostics keep it without mutating contract errors. Handler boundaries translate it
 * into their public contract error with `Effect.catchTag('PersistenceFailure', …)`; the cause never
 * reaches an encoded response because contract schemas do not declare it.
 */
export class PersistenceFailure extends Data.TaggedError('PersistenceFailure')<{
  readonly cause: unknown;
  readonly reason: string;
}> {}
