import { Data } from 'effect';

export class SpiceDbConfigError extends Data.TaggedError('SpiceDbConfigError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
