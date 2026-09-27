import { Data } from 'effect';

export class OutboxWorkerLegalEntityScopeError extends Data.TaggedError('OutboxWorkerLegalEntityScopeError')<{
  readonly cause?: unknown;
  readonly code:
    | 'outbox_worker_scope_context_invalid'
    | 'outbox_worker_scope_empty'
    | 'outbox_worker_scope_unavailable';
  readonly reason: string;
  readonly retryable: boolean;
}> {}
