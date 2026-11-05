import { Schema } from 'effect';

/** Persistence is unavailable, so the caller retries the same read or command unchanged. */
export class AccessIntentUnavailableError extends Schema.TaggedError<AccessIntentUnavailableError>()(
  'AccessIntentUnavailableError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('access_intent_unavailable'),
    reason: Schema.String,
  },
) {}

export const intentUnavailable = (reason: string, cause?: unknown): AccessIntentUnavailableError =>
  cause === undefined
    ? new AccessIntentUnavailableError({ code: 'access_intent_unavailable', reason })
    : new AccessIntentUnavailableError({ cause, code: 'access_intent_unavailable', reason });
