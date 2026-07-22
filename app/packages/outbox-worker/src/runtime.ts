// @effect-diagnostics asyncFunction:off globalDate:off unsafeEffectTypeAssertion:off
import { sqlClient } from '../../core-runtime/src/db/client.ts';
import type { CoreTransaction } from '../../core-runtime/src/db/types.ts';
import type { OutboxWorkerRegistration } from '../../core-runtime/src/outbox-worker.ts';

export interface OutboxWorkerRuntimeConfig {
  readonly claimBatchSize: number;
  readonly materializeBatchSize: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly runtimeId: string;
}

export interface OutboxWorkerTickResult {
  readonly deliveriesClaimed: number;
  readonly deliveriesInserted: number;
  readonly messagesMatched: number;
}

interface UnmatchedMessageRow {
  readonly outbox_message_id: string;
  readonly topic: string;
}

interface ClaimedDelivery {
  readonly attemptsCount: number;
  readonly outboxAttemptId: string;
  readonly outboxDeliveryId: string;
  readonly workerKey: string;
}

interface EnvelopeRow {
  readonly action_idempotency_key: string | null;
  readonly action_invocation_id: string | null;
  readonly action_key: string | null;
  readonly auth_binding_id: string | null;
  readonly consumer_module_key: string;
  readonly domain_event_id: string;
  readonly legal_entity_id: string | null;
  readonly outbox_delivery_id: string;
  readonly outbox_message_id: string;
  readonly originating_principal_id: string | null;
  readonly payload_json: unknown;
  readonly principal_id: string | null;
  readonly producer_module_key: string;
  readonly tenant_id: string;
  readonly topic: string;
  readonly worker_key: string;
}

const registrationsForTopic = (
  registrations: readonly OutboxWorkerRegistration<unknown>[],
  topic: string,
) => registrations.filter((registration) => registration.descriptor.topics.includes(topic));

const materializeDeliveries = ({
  batchSize,
  registrations,
}: {
  readonly batchSize: number;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
}) =>
  sqlClient.begin(async (tx) => {
    const messages = await tx<UnmatchedMessageRow[]>`
      select outbox_message_id, topic
      from core.outbox_messages
      where matched_at is null
      order by created_at, outbox_message_id
      limit ${batchSize}
      for update skip locked
    `;
    let deliveriesInserted = 0;
    let messagesMatched = 0;

    for (const message of messages) {
      const matches = registrationsForTopic(registrations, message.topic);

      if (matches.length > 0) {
        messagesMatched += 1;
      }

      for (const registration of matches) {
        // oxlint-disable-next-line no-await-in-loop -- Delivery rows must be inserted inside the locked transaction.
        const inserted = await tx<{ readonly outbox_delivery_id: string }[]>`
          insert into core.outbox_deliveries (
            outbox_message_id,
            worker_key,
            consumer_module_key
          )
          values (
            ${message.outbox_message_id},
            ${registration.descriptor.workerKey},
            ${registration.descriptor.consumerModuleKey}
          )
          on conflict (outbox_message_id, worker_key) do nothing
          returning outbox_delivery_id
        `;
        deliveriesInserted += inserted.length;
      }

      // oxlint-disable-next-line no-await-in-loop -- The message is marked only after its delivery rows are materialized.
      await tx`
        update core.outbox_messages
        set matched_at = now()
        where outbox_message_id = ${message.outbox_message_id}
      `;
    }

    return {
      deliveriesInserted,
      messagesMatched,
    };
  });

const claimDueDeliveries = ({
  batchSize,
  runtimeId,
}: {
  readonly batchSize: number;
  readonly runtimeId: string;
}) =>
  sqlClient.begin(async (tx) => {
    const candidates = await tx<
      {
        readonly outbox_delivery_id: string;
        readonly worker_key: string;
      }[]
    >`
      select outbox_delivery_id, worker_key
      from core.outbox_deliveries
      where status = 'pending'
        and available_at <= now()
      order by available_at, created_at, outbox_delivery_id
      limit ${batchSize}
      for update skip locked
    `;
    const claimed: ClaimedDelivery[] = [];

    for (const candidate of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- Claiming must stay inside the row-locking transaction.
      const [updated] = await tx<{ readonly attempts_count: number }[]>`
        update core.outbox_deliveries
        set
          status = 'processing',
          claimed_by = ${runtimeId},
          claimed_at = now(),
          attempts_count = attempts_count + 1,
          updated_at = now()
        where outbox_delivery_id = ${candidate.outbox_delivery_id}
        returning attempts_count
      `;

      if (updated === undefined) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- Attempts are created only for successfully claimed deliveries.
      const [attempt] = await tx<{ readonly outbox_attempt_id: string }[]>`
        insert into core.outbox_attempts (outbox_delivery_id)
        values (${candidate.outbox_delivery_id})
        returning outbox_attempt_id
      `;

      if (attempt === undefined) {
        continue;
      }

      claimed.push({
        attemptsCount: updated.attempts_count,
        outboxAttemptId: attempt.outbox_attempt_id,
        outboxDeliveryId: candidate.outbox_delivery_id,
        workerKey: candidate.worker_key,
      });
    }

    return claimed;
  });

const registrationForDelivery = (
  registrations: readonly OutboxWorkerRegistration<unknown>[],
  delivery: ClaimedDelivery,
) => registrations.find((registration) => registration.descriptor.workerKey === delivery.workerKey);

const finishDeliverySuccess = async (
  tx: Parameters<Parameters<typeof sqlClient.begin>[0]>[0],
  delivery: ClaimedDelivery,
) => {
  await tx`
    update core.outbox_deliveries
    set
      status = 'done',
      claimed_by = null,
      claimed_at = null,
      updated_at = now()
    where outbox_delivery_id = ${delivery.outboxDeliveryId}
      and status = 'processing'
  `;
  await tx`
    update core.outbox_attempts
    set
      finished_at = now(),
      error_message = null
    where outbox_attempt_id = ${delivery.outboxAttemptId}
  `;
};

const finishDeliveryFailure = async ({
  delivery,
  error,
  registration,
  runtimeConfig,
}: {
  readonly delivery: ClaimedDelivery;
  readonly error: unknown;
  readonly registration: OutboxWorkerRegistration<unknown> | undefined;
  readonly runtimeConfig: OutboxWorkerRuntimeConfig;
}) => {
  const maxAttempts = registration?.descriptor.defaults?.maxAttempts ?? runtimeConfig.maxAttempts;
  const isDead = delivery.attemptsCount >= maxAttempts;
  const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 8000);

  await sqlClient.begin(async (tx) => {
    await tx`
      update core.outbox_attempts
      set
        finished_at = now(),
        error_message = ${errorMessage}
      where outbox_attempt_id = ${delivery.outboxAttemptId}
    `;
    await tx`
      update core.outbox_deliveries
      set
        status = ${isDead ? 'dead' : 'pending'},
        available_at = case
          when ${isDead} then available_at
          else now() + (${runtimeConfig.retryBackoffMs}::integer * interval '1 millisecond')
        end,
        claimed_by = null,
        claimed_at = null,
        updated_at = now()
      where outbox_delivery_id = ${delivery.outboxDeliveryId}
        and status = 'processing'
    `;
  });
};

const reconstructEnvelope = async (
  tx: Parameters<Parameters<typeof sqlClient.begin>[0]>[0],
  delivery: ClaimedDelivery,
) => {
  const [row] = await tx<EnvelopeRow[]>`
    select
      delivery.outbox_delivery_id,
      delivery.worker_key,
      delivery.consumer_module_key,
      message.outbox_message_id,
      message.topic,
      message.payload_json,
      event.domain_event_id,
      event.tenant_id,
      event.legal_entity_id,
      event.producer_module_key,
      action.action_invocation_id,
      action.originating_principal_id,
      action.principal_id,
      action.auth_binding_id,
      action.action_key,
      action.idempotency_key as action_idempotency_key
    from core.outbox_deliveries delivery
      join core.outbox_messages message
        on message.outbox_message_id = delivery.outbox_message_id
      join core.domain_events event
        on event.domain_event_id = message.domain_event_id
      left join core.action_invocations action
        on action.action_invocation_id = event.action_invocation_id
    where delivery.outbox_delivery_id = ${delivery.outboxDeliveryId}
  `;

  if (row === undefined) {
    throw new Error(`Outbox delivery ${delivery.outboxDeliveryId} could not be reconstructed.`);
  }

  return row;
};

const assertConsumerModuleCanMutate = async (
  tx: Parameters<Parameters<typeof sqlClient.begin>[0]>[0],
  input: {
    readonly consumerModuleKey: string;
    readonly tenantId: string;
    readonly workerKey: string;
  },
) => {
  const [row] = await tx<{ readonly state: string }[]>`
    select state
    from core.tenant_module_states
    where tenant_id = ${input.tenantId}
      and module_key = ${input.consumerModuleKey}
    limit 1
  `;
  const state = row?.state ?? 'inactive';

  if (state !== 'active' && state !== 'deprecated') {
    throw new Error(
      `Outbox worker ${input.workerKey} is denied for module ${input.consumerModuleKey} in state ${state}.`,
    );
  }
};

const executeClaimedDelivery = async ({
  delivery,
  registrations,
  runtimeConfig,
}: {
  readonly delivery: ClaimedDelivery;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
  readonly runtimeConfig: OutboxWorkerRuntimeConfig;
}) => {
  const registration = registrationForDelivery(registrations, delivery);

  try {
    if (registration === undefined) {
      throw new Error(`Outbox worker ${delivery.workerKey} is not installed.`);
    }

    await sqlClient.begin(async (tx) => {
      const envelope = await reconstructEnvelope(tx, delivery);
      await assertConsumerModuleCanMutate(tx, {
        consumerModuleKey: envelope.consumer_module_key,
        tenantId: envelope.tenant_id,
        workerKey: envelope.worker_key,
      });

      const payload =
        registration.descriptor.payloadSchema?.parse(envelope.payload_json) ??
        envelope.payload_json;

      await Promise.resolve(
        registration.handler(
          {
            context: {
              consumerModuleKey: envelope.consumer_module_key,
              domainEventId: envelope.domain_event_id,
              idempotencyKey: envelope.outbox_delivery_id,
              outboxDeliveryId: envelope.outbox_delivery_id,
              outboxMessageId: envelope.outbox_message_id,
              producerModuleKey: envelope.producer_module_key,
              tenantId: envelope.tenant_id,
              topic: envelope.topic,
              workerKey: envelope.worker_key,
              ...(envelope.legal_entity_id === null
                ? {}
                : { legalEntityId: envelope.legal_entity_id }),
              ...(envelope.principal_id === null
                ? {}
                : { originalPrincipalId: envelope.principal_id }),
              ...(envelope.auth_binding_id === null
                ? {}
                : { originalAuthBindingId: envelope.auth_binding_id }),
              ...(envelope.action_invocation_id === null
                ? {}
                : { originalActionInvocationId: envelope.action_invocation_id }),
              ...(envelope.action_key === null ? {} : { originalActionKey: envelope.action_key }),
              ...(envelope.action_idempotency_key === null
                ? {}
                : { originalActionIdempotencyKey: envelope.action_idempotency_key }),
              ...(envelope.originating_principal_id === null
                ? {}
                : { originatingPrincipalId: envelope.originating_principal_id }),
            },
            payload,
          },
          { tx: tx as unknown as CoreTransaction },
        ),
      );

      await finishDeliverySuccess(tx, delivery);
    });
  } catch (error) {
    await finishDeliveryFailure({
      delivery,
      error,
      registration,
      runtimeConfig,
    });
  }
};

export const runOutboxWorkerTick = async ({
  config,
  registrations,
}: {
  readonly config: OutboxWorkerRuntimeConfig;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
}): Promise<OutboxWorkerTickResult> => {
  const materialized = await materializeDeliveries({
    batchSize: config.materializeBatchSize,
    registrations,
  });
  const claimed = await claimDueDeliveries({
    batchSize: config.claimBatchSize,
    runtimeId: config.runtimeId,
  });

  await Promise.all(
    claimed.map((delivery) =>
      executeClaimedDelivery({
        delivery,
        registrations,
        runtimeConfig: config,
      }),
    ),
  );

  return {
    deliveriesClaimed: claimed.length,
    deliveriesInserted: materialized.deliveriesInserted,
    messagesMatched: materialized.messagesMatched,
  };
};
