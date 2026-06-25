// @effect-diagnostics asyncFunction:off globalDate:off
import { db } from '@mvp2/core-runtime/db/client';
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import type { CoreTransaction } from '@mvp2/core-runtime';
import { sql } from 'drizzle-orm';
import { matchingRegistrationsForTopic } from './topic-matching.ts';
import { rowsFromResult } from './sql-result.ts';

export type MaterializeDeliveriesOptions = {
  readonly batchSize: number;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
};

export type MaterializeDeliveriesResult = {
  readonly deliveriesInserted: number;
  readonly messagesMatched: number;
};

type UnmatchedMessageRow = {
  readonly outboxMessageId: string;
  readonly topic: string;
};

const selectUnmatchedMessages = async (
  tx: CoreTransaction,
  batchSize: number,
): Promise<readonly UnmatchedMessageRow[]> => {
  const result = await tx.execute(sql`
    select
      outbox_message_id as "outboxMessageId",
      topic
    from core.outbox_messages
    where matched_at is null
    order by created_at, outbox_message_id
    limit ${batchSize}
    for update skip locked
  `);

  return rowsFromResult<UnmatchedMessageRow>(result);
};

const insertDelivery = async (
  tx: CoreTransaction,
  message: UnmatchedMessageRow,
  registration: OutboxWorkerRegistration<unknown>,
): Promise<number> => {
  const result = await tx.execute(sql`
    insert into core.outbox_deliveries (
      outbox_message_id,
      worker_key,
      executing_module_key
    )
    values (
      ${message.outboxMessageId},
      ${registration.descriptor.workerKey},
      ${registration.descriptor.executingModuleKey}
    )
    on conflict (outbox_message_id, worker_key) do nothing
    returning outbox_delivery_id as "outboxDeliveryId"
  `);

  return rowsFromResult<{ readonly outboxDeliveryId: string }>(result).length;
};

export const materializeDeliveries = async ({
  batchSize,
  registrations,
}: MaterializeDeliveriesOptions): Promise<MaterializeDeliveriesResult> =>
  db.transaction(async (tx) => {
    const messages = await selectUnmatchedMessages(tx, batchSize);
    let deliveriesInserted = 0;

    for (const message of messages) {
      const matches = matchingRegistrationsForTopic(registrations, message.topic);

      for (const registration of matches) {
        deliveriesInserted += await insertDelivery(tx, message, registration);
      }

      await tx.execute(sql`
        update core.outbox_messages
        set matched_at = now()
        where outbox_message_id = ${message.outboxMessageId}
      `);
    }

    return {
      deliveriesInserted,
      messagesMatched: messages.length,
    };
  });
