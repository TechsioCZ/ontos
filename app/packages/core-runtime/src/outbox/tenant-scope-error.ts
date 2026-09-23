import { Schema } from 'effect';

export class OutboxWorkerTenantScopeError extends Schema.TaggedError<OutboxWorkerTenantScopeError>()(
  'OutboxWorkerTenantScopeError',
  {
    code: Schema.Literals(['outbox_worker_tenant_scope_context_invalid', 'outbox_worker_tenant_scope_unavailable']),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
