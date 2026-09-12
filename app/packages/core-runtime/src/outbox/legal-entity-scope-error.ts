import { Schema } from 'effect';

export class OutboxWorkerLegalEntityScopeError extends Schema.TaggedError<OutboxWorkerLegalEntityScopeError>()(
  'OutboxWorkerLegalEntityScopeError',
  {
    code: Schema.Literals([
      'outbox_worker_scope_context_invalid',
      'outbox_worker_scope_empty',
      'outbox_worker_scope_unavailable',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
