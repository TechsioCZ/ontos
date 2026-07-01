import {
  type OutboxWorkerHandlerContext,
  type OutboxWorkerRegistration,
} from '@mvp2/core-runtime/outbox';
import type { CoreTransaction } from '@mvp2/core-runtime/db/types';
import { rowsFromResult } from '@mvp2/core-runtime/sql-result';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { type OutboxWorkerError, outboxWorkerError } from './errors.ts';

export type WorkerExecutionEnvelope = {
  readonly context: OutboxWorkerHandlerContext;
  readonly payload: unknown;
};

type ContextRow = {
  readonly actionInvocationId: string | null;
  readonly actionKey: string | null;
  readonly actionIdempotencyKey: string | null;
  readonly authBindingId: string | null;
  readonly domainEventId: string;
  readonly consumerModuleKey: string;
  readonly legalEntityId: string | null;
  readonly outboxDeliveryId: string;
  readonly outboxMessageId: string;
  readonly payload: unknown;
  readonly principalId: string | null;
  readonly producerModuleKey: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly workerKey: string;
};

export const reconstructWorkerExecutionEnvelope = (
  tx: CoreTransaction,
  outboxDeliveryId: string,
  registration: OutboxWorkerRegistration<unknown>,
): Effect.Effect<WorkerExecutionEnvelope, OutboxWorkerError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        tx.execute(sql`
    select
      delivery.outbox_delivery_id as "outboxDeliveryId",
      delivery.worker_key as "workerKey",
      delivery.consumer_module_key as "consumerModuleKey",
      message.outbox_message_id as "outboxMessageId",
      message.topic,
      message.payload_json as "payload",
      event.domain_event_id as "domainEventId",
      event.tenant_id as "tenantId",
      event.legal_entity_id as "legalEntityId",
      event.producer_module_key as "producerModuleKey",
      action.action_invocation_id as "actionInvocationId",
      action.principal_id as "principalId",
      action.auth_binding_id as "authBindingId",
      action.action_key as "actionKey",
      action.idempotency_key as "actionIdempotencyKey"
    from core.outbox_deliveries delivery
      join core.outbox_messages message
        on message.outbox_message_id = delivery.outbox_message_id
      join core.domain_events event
        on event.domain_event_id = message.domain_event_id
      left join core.action_invocations action
        on action.action_invocation_id = event.action_invocation_id
    where delivery.outbox_delivery_id = ${outboxDeliveryId}
      and delivery.worker_key = ${registration.descriptor.workerKey}
  `),
      catch: (error) => outboxWorkerError('Failed to reconstruct outbox worker context.', error),
    });
    const row = rowsFromResult<ContextRow>(result).at(0);

    if (row === undefined) {
      return yield* outboxWorkerError(
        `Outbox delivery ${outboxDeliveryId} could not be reconstructed.`,
      );
    }

    return {
      context: {
        tenantId: row.tenantId,
        producerModuleKey: row.producerModuleKey,
        consumerModuleKey: row.consumerModuleKey,
        workerKey: row.workerKey,
        topic: row.topic,
        outboxMessageId: row.outboxMessageId,
        outboxDeliveryId: row.outboxDeliveryId,
        domainEventId: row.domainEventId,
        idempotencyKey: row.outboxDeliveryId,
        ...(row.legalEntityId === null ? {} : { legalEntityId: row.legalEntityId }),
        ...(row.principalId === null ? {} : { originalPrincipalId: row.principalId }),
        ...(row.authBindingId === null ? {} : { originalAuthBindingId: row.authBindingId }),
        ...(row.actionInvocationId === null
          ? {}
          : { originalActionInvocationId: row.actionInvocationId }),
        ...(row.actionKey === null ? {} : { originalActionKey: row.actionKey }),
        ...(row.actionIdempotencyKey === null
          ? {}
          : { originalActionIdempotencyKey: row.actionIdempotencyKey }),
      },
      payload: row.payload,
    };
  });
