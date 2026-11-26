import { Data } from 'effect';

import { safeCauseOf } from '../domain/intake/safe-cause.ts';

/** A retryable failure of the owner's own store: Core delivers the message again and the step is safe to repeat. */
export class HandoffStoreUnavailable extends Data.TaggedError('HandoffStoreUnavailable')<{
  readonly reason: string;
}> {}

/**
 * The typed, retryable failure. It keeps only the SAFE kind of the failure it replaces (non-enumerable): the raw cause of a
 * failed routine call carries its bound parameters, which include recipient references and the owner's mask.
 */
export const storeUnavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new HandoffStoreUnavailable({ reason }), 'cause', {
    enumerable: false,
    value: cause === undefined ? undefined : safeCauseOf(cause),
  });
