// @effect-diagnostics globalDate:off
import type { CoreTransaction } from '@mvp2/core-runtime/db/types';
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import { rowsFromResult } from '@mvp2/core-runtime/sql-result';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { runCoreTransaction } from './db-effect.ts';
import { type OutboxWorkerError, outboxWorkerError } from './errors.ts';

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

const selectUnmatchedMessages = (
  tx: CoreTransaction,
  batchSize: number,
): Effect.Effect<readonly UnmatchedMessageRow[], OutboxWorkerError> =>
  Effect.tryPromise({
    try: () =>
      tx.execute(sql`
    select
      outbox_message_id as "outboxMessageId",
      topic
    from core.outbox_messages
    where matched_at is null
    order by created_at, outbox_message_id
    limit ${batchSize}
    for update skip locked
  `),
    catch: (error) => outboxWorkerError('Failed to select unmatched outbox messages.', error),
  }).pipe(Effect.map(rowsFromResult<UnmatchedMessageRow>));

const insertDelivery = (
  tx: CoreTransaction,
  message: UnmatchedMessageRow,
  registration: OutboxWorkerRegistration<unknown>,
): Effect.Effect<number, OutboxWorkerError> =>
  Effect.tryPromise({
    try: () =>
      tx.execute(sql`
    insert into core.outbox_deliveries (
      outbox_message_id,
      worker_key,
      consumer_module_key
    )
    values (
      ${message.outboxMessageId},
      ${registration.descriptor.workerKey},
      ${registration.descriptor.consumerModuleKey}
    )
    on conflict (outbox_message_id, worker_key) do nothing
    returning outbox_delivery_id as "outboxDeliveryId"
  `),
    catch: (error) => outboxWorkerError('Failed to insert outbox delivery.', error),
  }).pipe(
    Effect.map((result) => rowsFromResult<{ readonly outboxDeliveryId: string }>(result).length),
  );

export const materializeDeliveries = ({
  batchSize,
  registrations,
}: MaterializeDeliveriesOptions): Effect.Effect<MaterializeDeliveriesResult, OutboxWorkerError> =>
  runCoreTransaction((tx) =>
    Effect.gen(function* () {
      const messages = yield* selectUnmatchedMessages(tx, batchSize);
      let deliveriesInserted = 0;
      let messagesMatched = 0;

      for (const message of messages) {
        const matches = registrations.filter((registration) =>
          registration.descriptor.topics.includes(message.topic),
        );

        if (matches.length === 0) {
          continue;
        }

        messagesMatched += 1;

        for (const registration of matches) {
          deliveriesInserted += yield* insertDelivery(tx, message, registration);
        }

        yield* Effect.tryPromise({
          try: () =>
            tx.execute(sql`
        update core.outbox_messages
        set matched_at = now()
        where outbox_message_id = ${message.outboxMessageId}
      `),
          catch: (error) => outboxWorkerError('Failed to mark outbox message as matched.', error),
        });
      }

      return {
        deliveriesInserted,
        messagesMatched,
      };
    }),
  );
