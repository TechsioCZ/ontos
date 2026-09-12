import { Schema } from 'effect';

export class OutboxWorkerCompletionPublicationError extends Schema.TaggedError<OutboxWorkerCompletionPublicationError>()(
  'OutboxWorkerCompletionPublicationError',
  {
    code: Schema.Literals([
      'outbox_worker_completion_invalid',
      'outbox_worker_completion_conflict',
      'outbox_worker_completion_unavailable',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
