// @effect-diagnostics asyncFunction:off globalDate:off
import { db } from '@mvp2/core-runtime/db/client';
import { rowsFromResult, type CoreTransaction } from '@mvp2/core-runtime';
import { sql } from 'drizzle-orm';

export type ClaimDeliveriesOptions = {
  readonly batchSize: number;
  readonly claimTimeoutMs: number;
  readonly runtimeId: string;
};

export type ClaimedDelivery = {
  readonly attemptsCount: number;
  readonly executingModuleKey: string;
  readonly outboxAttemptId: string;
  readonly outboxDeliveryId: string;
  readonly outboxMessageId: string;
  readonly workerKey: string;
};

type ClaimCandidateRow = {
  readonly executingModuleKey: string;
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

const selectClaimCandidates = async (
  tx: CoreTransaction,
  batchSize: number,
): Promise<readonly ClaimCandidateRow[]> => {
  const result = await tx.execute(sql`
    select
      outbox_delivery_id as "outboxDeliveryId",
      outbox_message_id as "outboxMessageId",
      worker_key as "workerKey",
      executing_module_key as "executingModuleKey"
    from core.outbox_deliveries
    where status = 'pending'
      and available_at <= now()
    order by available_at, created_at, outbox_delivery_id
    limit ${batchSize}
    for update skip locked
  `);

  return rowsFromResult<ClaimCandidateRow>(result);
};

export const claimDueDeliveries = async ({
  batchSize,
  claimTimeoutMs,
  runtimeId,
}: ClaimDeliveriesOptions): Promise<readonly ClaimedDelivery[]> =>
  db.transaction(async (tx) => {
    const candidates = await selectClaimCandidates(tx, batchSize);
    const claimed: ClaimedDelivery[] = [];

    for (const candidate of candidates) {
      const updatedResult = await tx.execute(sql`
        update core.outbox_deliveries
        set
          status = 'processing',
          claimed_by = ${runtimeId},
          claimed_at = now(),
          claim_expires_at = now() + (${claimTimeoutMs}::integer * interval '1 millisecond'),
          attempts_count = attempts_count + 1,
          updated_at = now()
        where outbox_delivery_id = ${candidate.outboxDeliveryId}
        returning attempts_count as "attemptsCount"
      `);
      const updatedDelivery = rowsFromResult<UpdatedDeliveryRow>(updatedResult).at(0);

      if (updatedDelivery === undefined) {
        continue;
      }

      const attemptResult = await tx.execute(sql`
        insert into core.outbox_attempts (outbox_delivery_id)
        values (${candidate.outboxDeliveryId})
        returning outbox_attempt_id as "outboxAttemptId"
      `);
      const attempt = rowsFromResult<AttemptRow>(attemptResult).at(0);

      if (attempt === undefined) {
        continue;
      }

      claimed.push({
        attemptsCount: updatedDelivery.attemptsCount,
        executingModuleKey: candidate.executingModuleKey,
        outboxAttemptId: attempt.outboxAttemptId,
        outboxDeliveryId: candidate.outboxDeliveryId,
        outboxMessageId: candidate.outboxMessageId,
        workerKey: candidate.workerKey,
      });
    }

    return claimed;
  });
