import { Data } from 'effect';

export class ContextPermissionMutationUnavailable extends Data.TaggedError('ContextPermissionMutationUnavailable')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
