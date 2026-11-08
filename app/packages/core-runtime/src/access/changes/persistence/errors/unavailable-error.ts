import { Schema } from 'effect';

/** Persistence is unavailable, so the caller retries the same operation unchanged. */
export class AccessChangesStoreUnavailableError extends Schema.TaggedError<AccessChangesStoreUnavailableError>()(
  'AccessChangesStoreUnavailableError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('access_changes_store_unavailable'),
    reason: Schema.String,
  },
) {}

export const storeUnavailable = (reason: string, cause?: unknown): AccessChangesStoreUnavailableError =>
  cause === undefined
    ? new AccessChangesStoreUnavailableError({ code: 'access_changes_store_unavailable', reason })
    : new AccessChangesStoreUnavailableError({ cause, code: 'access_changes_store_unavailable', reason });
