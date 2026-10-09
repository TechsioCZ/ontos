import { Data } from 'effect';

export class PrincipalResolverUnavailableError extends Data.TaggedError('PrincipalResolverUnavailableError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
