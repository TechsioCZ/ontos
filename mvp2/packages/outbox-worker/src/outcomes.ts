// @effect-diagnostics asyncFunction:off globalDate:off
import { db } from '@mvp2/core-runtime/db/client';
import type { CoreTransaction, OutboxWorkerRegistration } from '@mvp2/core-runtime';
import { sql } from 'drizzle-orm';
import type { ClaimedDelivery } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';

export type PersistFailureOptions = {
  readonly claimedDelivery: ClaimedDelivery;
  readonly error: unknown;
  readonly registration: OutboxWorkerRegistration<unknown> | undefined;
  readonly runtimeConfig: OutboxWorkerRuntimeConfig;
};

const errorMessageForPersistence = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

export const persistDeliverySuccess = async (
  tx: CoreTransaction,
  claimedDelivery: ClaimedDelivery,
): Promise<void> => {
  await tx.execute(sql`
    update core.outbox_deliveries
    set
      status = 'done',
      claimed_by = null,
      claimed_at = null,
      claim_expires_at = null,
      updated_at = now()
    where outbox_delivery_id = ${claimedDelivery.outboxDeliveryId}
      and status = 'processing'
  `);

  await tx.execute(sql`
    update core.outbox_attempts
    set
      finished_at = now(),
      error_message = null
    where outbox_attempt_id = ${claimedDelivery.outboxAttemptId}
  `);
};

export const persistDeliveryFailure = async ({
  claimedDelivery,
  error,
  registration,
  runtimeConfig,
}: PersistFailureOptions): Promise<void> =>
  db.transaction(async (tx) => {
    const maxAttempts = maxAttemptsForDelivery(registration, runtimeConfig);
    const isDead = claimedDelivery.attemptsCount >= maxAttempts;
    const delayMs = retryDelayMs(registration, runtimeConfig, claimedDelivery.attemptsCount);
    const status = isDead ? 'dead' : 'pending';
    const errorMessage = errorMessageForPersistence(error).slice(0, 8_000);

    await tx.execute(sql`
      update core.outbox_attempts
      set
        finished_at = now(),
        error_message = ${errorMessage}
      where outbox_attempt_id = ${claimedDelivery.outboxAttemptId}
    `);

    await tx.execute(sql`
      update core.outbox_deliveries
      set
        status = ${status},
        available_at = case
          when ${isDead} then available_at
          else now() + (${delayMs}::integer * interval '1 millisecond')
        end,
        claimed_by = null,
        claimed_at = null,
        claim_expires_at = null,
        updated_at = now()
      where outbox_delivery_id = ${claimedDelivery.outboxDeliveryId}
        and status = 'processing'
    `);
  });
