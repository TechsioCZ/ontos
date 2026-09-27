import { Data } from 'effect';

export class OutboxWorkerCompletionPublicationError extends Data.TaggedError('OutboxWorkerCompletionPublicationError')<{
  readonly cause?: unknown;
  readonly code:
    | 'outbox_worker_completion_invalid'
    | 'outbox_worker_completion_conflict'
    | 'outbox_worker_completion_unavailable';
  readonly reason: string;
  readonly retryable: boolean;
}> {}
