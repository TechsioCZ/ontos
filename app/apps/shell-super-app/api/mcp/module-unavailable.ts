/** A composed module could not be reached or did not return its native JSON transport contract. */
import { Data } from 'effect';

export class ModuleUnavailable extends Data.TaggedError('ModuleUnavailable')<{
  readonly cause?: Error;
  readonly message: string;
}> {}
