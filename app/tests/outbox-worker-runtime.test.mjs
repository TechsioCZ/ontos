import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { sqlClient } from '../packages/core-runtime/src/db/client.ts';
import { runOutboxWorkerTick } from '../packages/outbox-worker/src/runtime.ts';

const createdTenantIds = [];
const createdLegalEntityIds = [];
const createdPrincipalIds = [];

after(async () => {
  await sqlClient`delete from core.outbox_attempts where outbox_delivery_id in (
    select outbox_delivery_id
    from core.outbox_deliveries
    where outbox_message_id in (
      select outbox_message_id
      from core.outbox_messages
      where tenant_id = any(${createdTenantIds})
    )
  )`;
  await sqlClient`delete from core.outbox_deliveries where outbox_message_id in (
    select outbox_message_id
    from core.outbox_messages
    where tenant_id = any(${createdTenantIds})
  )`;
  await sqlClient`delete from core.outbox_messages where tenant_id = any(${createdTenantIds})`;
  await sqlClient`delete from core.domain_events where tenant_id = any(${createdTenantIds})`;
  await sqlClient`delete from core.tenant_module_states where tenant_id = any(${createdTenantIds})`;

  await Promise.all(
    createdPrincipalIds.map(
      (principalId) => sqlClient`delete from core.principals where principal_id = ${principalId}`,
    ),
  );

  await Promise.all(
    createdLegalEntityIds.map(
      (legalEntityId) =>
        sqlClient`delete from core.legal_entities where legal_entity_id = ${legalEntityId}`,
    ),
  );

  await Promise.all(
    createdTenantIds.map(
      (tenantId) => sqlClient`delete from core.tenants where tenant_id = ${tenantId}`,
    ),
  );

  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Outbox Worker Tenant'}, ${`outbox-worker-${suffix}`}, ${'en'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);

  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id,
      legal_name,
      registration_country,
      registration_number,
      status
    )
    values (
      ${tenant.tenant_id},
      ${'Outbox Worker Legal Entity'},
      ${'CZ'},
      ${`outbox-worker-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  createdLegalEntityIds.push(legalEntity.legal_entity_id);

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Outbox Worker Principal'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  createdPrincipalIds.push(principal.principal_id);

  return {
    legalEntityId: legalEntity.legal_entity_id,
    principalId: principal.principal_id,
    tenantId: tenant.tenant_id,
  };
};

const setTenantModuleState = async ({ moduleKey, state, tenantId }) => {
  await sqlClient`
    insert into core.tenant_module_states (tenant_id, module_key, state)
    values (${tenantId}, ${moduleKey}, ${state})
    on conflict (tenant_id, module_key)
    do update set state = excluded.state, updated_at = now()
  `;
};

const createOutboxMessage = async ({ operationContext, payload, topic }) => {
  const [domainEvent] = await sqlClient`
    insert into core.domain_events (
      tenant_id,
      legal_entity_id,
      producer_module_key,
      event_type,
      subject_module_key,
      subject_resource_type,
      subject_resource_id,
      payload_json,
      tenant_sequence_no
    )
    values (
      ${operationContext.tenantId},
      ${operationContext.legalEntityId},
      ${'ticketing'},
      ${topic},
      ${'ticketing'},
      ${'ticket'},
      ${'ticket-1'},
      ${JSON.stringify(payload)}::jsonb,
      ${1}
    )
    returning domain_event_id
  `;

  const [message] = await sqlClient`
    insert into core.outbox_messages (
      tenant_id,
      domain_event_id,
      producer_module_key,
      topic,
      payload_json
    )
    values (
      ${operationContext.tenantId},
      ${domainEvent.domain_event_id},
      ${'ticketing'},
      ${topic},
      ${JSON.stringify(payload)}::jsonb
    )
    returning outbox_message_id
  `;

  return message.outbox_message_id;
};

test('Outbox worker runtime materializes and completes a matching delivery', async () => {
  const operationContext = await createOperationIdentity();
  await setTenantModuleState({
    moduleKey: 'ticketing',
    state: 'active',
    tenantId: operationContext.tenantId,
  });

  const handled = [];
  const topic = 'ticketing.ticket.created';
  const outboxMessageId = await createOutboxMessage({
    operationContext,
    payload: { ticketId: 'ticket-1' },
    topic,
  });

  const result = await runOutboxWorkerTick({
    config: {
      claimBatchSize: 10,
      materializeBatchSize: 10,
      maxAttempts: 3,
      retryBackoffMs: 1000,
      runtimeId: 'test-runtime',
    },
    registrations: [
      {
        descriptor: {
          consumerModuleKey: 'ticketing',
          owningModuleKey: 'ticketing',
          topics: [topic],
          workerKey: 'ticketing.ticketCreated',
        },
        handler: ({ context, payload }) => {
          handled.push({
            consumerModuleKey: context.consumerModuleKey,
            outboxMessageId: context.outboxMessageId,
            payload,
            tenantId: context.tenantId,
            topic: context.topic,
            workerKey: context.workerKey,
          });
        },
      },
    ],
  });

  assert.deepEqual(result, {
    deliveriesClaimed: 1,
    deliveriesInserted: 1,
    messagesMatched: 1,
  });
  assert.deepEqual(handled, [
    {
      consumerModuleKey: 'ticketing',
      outboxMessageId,
      payload: { ticketId: 'ticket-1' },
      tenantId: operationContext.tenantId,
      topic,
      workerKey: 'ticketing.ticketCreated',
    },
  ]);

  const [delivery] = await sqlClient`
    select status
    from core.outbox_deliveries
    where outbox_message_id = ${outboxMessageId}
      and worker_key = ${'ticketing.ticketCreated'}
  `;
  const [message] = await sqlClient`
    select matched_at
    from core.outbox_messages
    where outbox_message_id = ${outboxMessageId}
  `;

  assert.equal(delivery.status, 'done');
  assert.notEqual(message.matched_at, null);
});
