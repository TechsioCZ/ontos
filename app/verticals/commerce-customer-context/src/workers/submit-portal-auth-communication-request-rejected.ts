import { Schema } from 'effect';

/** Expected failure of the Portal Auth source worker: retryable while Communications is unreachable, final for a foreign delivery. */
export class SubmitPortalAuthCommunicationRequestRejected extends Schema.TaggedError<SubmitPortalAuthCommunicationRequestRejected>()(
  'SubmitPortalAuthCommunicationRequestRejected',
  {
    code: Schema.Literals(['COMMUNICATIONS_UNAVAILABLE', 'WORKER_CONTEXT_INVALID']),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
