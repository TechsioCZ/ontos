// @effect-diagnostics processEnv:off nodeBuiltinImport:off globalDate:off
import { hostname } from 'node:os';

export type OutboxWorkerRuntimeConfig = {
  readonly claimBatchSize: number;
  readonly claimTimeoutMs: number;
  readonly materializeBatchSize: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
  readonly retryBackoffMs: number;
  readonly runtimeId: string;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const readOutboxWorkerRuntimeConfig = (): OutboxWorkerRuntimeConfig => ({
  claimBatchSize: parsePositiveInteger(process.env['OUTBOX_WORKER_CLAIM_BATCH_SIZE'], 10),
  claimTimeoutMs: parsePositiveInteger(process.env['OUTBOX_WORKER_CLAIM_TIMEOUT_MS'], 60_000),
  materializeBatchSize: parsePositiveInteger(
    process.env['OUTBOX_WORKER_MATERIALIZE_BATCH_SIZE'],
    100,
  ),
  maxAttempts: parsePositiveInteger(process.env['OUTBOX_WORKER_MAX_ATTEMPTS'], 5),
  pollIntervalMs: parsePositiveInteger(process.env['OUTBOX_WORKER_POLL_INTERVAL_MS'], 1_000),
  retryBackoffMs: parsePositiveInteger(process.env['OUTBOX_WORKER_RETRY_BACKOFF_MS'], 5_000),
  runtimeId:
    process.env['OUTBOX_WORKER_RUNTIME_ID']?.trim() || `outbox-worker:${hostname()}:${process.pid}`,
});
