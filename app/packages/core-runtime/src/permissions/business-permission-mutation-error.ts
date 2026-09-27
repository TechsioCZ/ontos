import { Data } from 'effect';

export class BusinessPermissionMutationUnavailable extends Data.TaggedError('BusinessPermissionMutationUnavailable')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
