// @effect-diagnostics globalDate:off
import type { CoreTransaction } from '@mvp2/core-runtime/db/types';
import { rowsFromResult } from '@mvp2/core-runtime/sql-result';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { runCoreTransaction } from './db-effect.ts';
import { type OutboxWorkerError, outboxWorkerError } from './errors.ts';

export type ClaimDeliveriesOptions = {
  readonly batchSize: number;
  readonly runtimeId: string;
};

export type ClaimedDelivery = {
  readonly attemptsCount: number;
  readonly consumerModuleKey: string;
  readonly outboxAttemptId: string;
  readonly outboxDeliveryId: string;
  readonly outboxMessageId: string;
  readonly workerKey: string;
};

type ClaimCandidateRow = {
  readonly consumerModuleKey: string;
  readonly outboxDeliveryId: string;
  readonly outboxMessageId: string;
  readonly workerKey: string;
};

type UpdatedDeliveryRow = {
  readonly attemptsCount: number;
};

type AttemptRow = {
  readonly outboxAttemptId: string;
};

const selectClaimCandidates = (
  tx: CoreTransaction,
  batchSize: number,
): Effect.Effect<readonly ClaimCandidateRow[], OutboxWorkerError> =>
  Effect.tryPromise({
    try: () =>
      tx.execute(sql`
    select
      outbox_delivery_id as "outboxDeliveryId",
      outbox_message_id as "outboxMessageId",
      worker_key as "workerKey",
      consumer_module_key as "consumerModuleKey"
    from core.outbox_deliveries
    where status = 'pending'
      and available_at <= now()
    order by available_at, created_at, outbox_delivery_id
    limit ${batchSize}
    for update skip locked
  `),
    catch: (error) => outboxWorkerError('Failed to select claim candidates.', error),
  }).pipe(Effect.map(rowsFromResult<ClaimCandidateRow>));

export const claimDueDeliveries = ({
  batchSize,
  runtimeId,
}: ClaimDeliveriesOptions): Effect.Effect<readonly ClaimedDelivery[], OutboxWorkerError> =>
  runCoreTransaction((tx) =>
    Effect.gen(function* () {
      const candidates = yield* selectClaimCandidates(tx, batchSize);
      const claimed: ClaimedDelivery[] = [];

      for (const candidate of candidates) {
        const updatedResult = yield* Effect.tryPromise({
          try: () =>
            tx.execute(sql`
        update core.outbox_deliveries
        set
          status = 'processing',
          claimed_by = ${runtimeId},
          claimed_at = now(),
          attempts_count = attempts_count + 1,
          updated_at = now()
        where outbox_delivery_id = ${candidate.outboxDeliveryId}
        returning attempts_count as "attemptsCount"
      `),
          catch: (error) =>
            outboxWorkerError('Failed to mark outbox delivery as processing.', error),
        });
        const updatedDelivery = rowsFromResult<UpdatedDeliveryRow>(updatedResult).at(0);

        if (updatedDelivery === undefined) {
          continue;
        }

        const attemptResult = yield* Effect.tryPromise({
          try: () =>
            tx.execute(sql`
        insert into core.outbox_attempts (outbox_delivery_id)
        values (${candidate.outboxDeliveryId})
        returning outbox_attempt_id as "outboxAttemptId"
      `),
          catch: (error) => outboxWorkerError('Failed to create outbox delivery attempt.', error),
        });
        const attempt = rowsFromResult<AttemptRow>(attemptResult).at(0);

        if (attempt === undefined) {
          continue;
        }

        claimed.push({
          attemptsCount: updatedDelivery.attemptsCount,
          consumerModuleKey: candidate.consumerModuleKey,
          outboxAttemptId: attempt.outboxAttemptId,
          outboxDeliveryId: candidate.outboxDeliveryId,
          outboxMessageId: candidate.outboxMessageId,
          workerKey: candidate.workerKey,
        });
      }

      return claimed;
    }),
  );
