import { Schema } from 'effect';

/** Expected failure of the Portal Auth source worker: retryable while Communications, Privacy or Auth's own store is unreachable, final for a foreign delivery. */
export class SubmitPortalAuthCommunicationRequestRejected extends Schema.TaggedError<SubmitPortalAuthCommunicationRequestRejected>()(
  'SubmitPortalAuthCommunicationRequestRejected',
  {
    code: Schema.Literals([
      'AUTH_STORE_UNAVAILABLE',
      'COMMUNICATIONS_UNAVAILABLE',
      'PRIVACY_UNAVAILABLE',
      'WORKER_CONTEXT_INVALID',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
