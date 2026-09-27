import { Data } from 'effect';

export class OutboxWorkerTenantScopeError extends Data.TaggedError('OutboxWorkerTenantScopeError')<{
  readonly cause?: unknown;
  readonly code: 'outbox_worker_tenant_scope_context_invalid' | 'outbox_worker_tenant_scope_unavailable';
  readonly reason: string;
  readonly retryable: boolean;
}> {}
