import { Data } from 'effect';

export class ResourceContainmentMutationUnavailable extends Data.TaggedError('ResourceContainmentMutationUnavailable')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
