import { Data } from 'effect';

/** Authenticated but not allowed. The Czech reason is shown to the person. */
export class ConnectionForbidden extends Data.TaggedError('ConnectionForbidden')<{
  readonly code: string;
  readonly reason: string;
}> {}
