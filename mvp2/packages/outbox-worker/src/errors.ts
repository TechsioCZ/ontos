import { Data } from 'effect';

export class OutboxWorkerError extends Data.TaggedError('OutboxWorkerError')<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export const outboxWorkerError = (message: string, cause?: unknown): OutboxWorkerError =>
  new OutboxWorkerError({ cause, message });
