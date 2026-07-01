// @effect-diagnostics globalDate:off
import type { CoreTransaction } from '@mvp2/core-runtime/db/types';
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import type { ClaimedDelivery } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';
import { runCoreTransaction } from './db-effect.ts';
import { OutboxWorkerError, outboxWorkerError } from './errors.ts';

export type PersistFailureOptions = {
  readonly claimedDelivery: ClaimedDelivery;
  readonly error: unknown;
  readonly registration: OutboxWorkerRegistration<unknown> | undefined;
  readonly runtimeConfig: OutboxWorkerRuntimeConfig;
};

const errorMessageForPersistence = (error: unknown): string =>
  error instanceof OutboxWorkerError && error.cause !== undefined
    ? `${error.message}: ${errorMessageForPersistence(error.cause)}`
    : error instanceof Error
      ? error.message
      : String(error);

const retryDelayMs = (
  registration: OutboxWorkerRegistration<unknown> | undefined,
  runtimeConfig: OutboxWorkerRuntimeConfig,
  attemptsCount: number,
): number => {
  const backoff = registration?.descriptor.defaults?.retryBackoff;

  if (backoff?.kind === 'fixed') {
    return backoff.delayMs;
  }

  if (backoff?.kind === 'exponential') {
    const delay = backoff.initialDelayMs * 2 ** Math.max(0, attemptsCount - 1);
    return Math.min(delay, backoff.maxDelayMs);
  }

  return runtimeConfig.retryBackoffMs;
};

const maxAttemptsForDelivery = (
  registration: OutboxWorkerRegistration<unknown> | undefined,
  runtimeConfig: OutboxWorkerRuntimeConfig,
): number => registration?.descriptor.defaults?.maxAttempts ?? runtimeConfig.maxAttempts;

export const persistDeliverySuccess = (
  tx: CoreTransaction,
  claimedDelivery: ClaimedDelivery,
): Effect.Effect<void, OutboxWorkerError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        tx.execute(sql`
    update core.outbox_deliveries
    set
      status = 'done',
      claimed_by = null,
      claimed_at = null,
      updated_at = now()
    where outbox_delivery_id = ${claimedDelivery.outboxDeliveryId}
      and status = 'processing'
  `),
      catch: (error) => outboxWorkerError('Failed to mark outbox delivery as done.', error),
    });

    yield* Effect.tryPromise({
      try: () =>
        tx.execute(sql`
    update core.outbox_attempts
    set
      finished_at = now(),
      error_message = null
    where outbox_attempt_id = ${claimedDelivery.outboxAttemptId}
  `),
      catch: (error) => outboxWorkerError('Failed to finish successful outbox attempt.', error),
    });
  });

export const persistDeliveryFailure = ({
  claimedDelivery,
  error,
  registration,
  runtimeConfig,
}: PersistFailureOptions): Effect.Effect<void, OutboxWorkerError> =>
  runCoreTransaction((tx) =>
    Effect.gen(function* () {
      const maxAttempts = maxAttemptsForDelivery(registration, runtimeConfig);
      const isDead = claimedDelivery.attemptsCount >= maxAttempts;
      const delayMs = retryDelayMs(registration, runtimeConfig, claimedDelivery.attemptsCount);
      const status = isDead ? 'dead' : 'pending';
      const errorMessage = errorMessageForPersistence(error).slice(0, 8_000);

      yield* Effect.tryPromise({
        try: () =>
          tx.execute(sql`
      update core.outbox_attempts
      set
        finished_at = now(),
        error_message = ${errorMessage}
      where outbox_attempt_id = ${claimedDelivery.outboxAttemptId}
    `),
        catch: (txError) => outboxWorkerError('Failed to finish failed outbox attempt.', txError),
      });

      yield* Effect.tryPromise({
        try: () =>
          tx.execute(sql`
      update core.outbox_deliveries
      set
        status = ${status},
        available_at = case
          when ${isDead} then available_at
          else now() + (${delayMs}::integer * interval '1 millisecond')
        end,
        claimed_by = null,
        claimed_at = null,
        updated_at = now()
      where outbox_delivery_id = ${claimedDelivery.outboxDeliveryId}
        and status = 'processing'
    `),
        catch: (txError) => outboxWorkerError('Failed to update failed outbox delivery.', txError),
      });
    }),
  );
