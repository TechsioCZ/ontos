import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createTicketActionRegistration } from '../src/actions/create-ticket.ts';
import { getTaskCollectionDataAccessRegistration } from '../src/data-access/get-task-collection.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`
        delete from core.outbox_messages
        where tenant_id = ${tenantId}
      `;
      await sqlClient`delete from core.domain_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.audit_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.action_invocations where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.data_access_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenant_module_states where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principals where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.legal_entities where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenants where tenant_id = ${tenantId}`;
    }),
  );

  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async ({
  kind = 'human',
  displayName = 'Task creator',
  status = 'active',
} = {}) => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Ticketing creation tenant'}, ${`ticketing-creation-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Ticketing creation legal entity'},
      ${'CZ'},
      ${`ticketing-creation-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${displayName}, ${kind}, ${status})
    returning principal_id
  `;

  await sqlClient`
    insert into core.tenant_module_states (tenant_id, module_key, state)
    values (${tenant.tenant_id}, ${'ticketing'}, ${'active'})
  `;

  return {
    legalEntityId: legalEntity.legal_entity_id,
    principalId: principal.principal_id,
    tenantId: tenant.tenant_id,
  };
};

const operationContextResolver = (operationContext) => () => ({
  _tag: 'Success',
  operationContext,
});

test('an authorized Actor creates and reads one durable collection with a blank Task', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = randomUUID();
  const authorizationChecks = [];

  const created = await runAction({
    options: {
      authorizationChecker: (check) => {
        authorizationChecks.push(check);
        return { _tag: 'Allowed' };
      },
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: createTicketActionRegistration,
    transport: {
      headers: new Headers({ 'Idempotency-Key': randomUUID() }),
    },
  });

  assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
  assert.deepEqual(authorizationChecks, [
    {
      permission: 'create',
      resourceObjectId: `${operationContext.tenantId}_${collectionId}`,
      resourceObjectType: 'task_collection',
      subjectObjectId: operationContext.principalId,
      subjectObjectType: 'principal',
    },
  ]);

  const read = await runDataAccess({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });

  assert.equal(read._tag, 'OperationSucceeded');
  assert.deepEqual(read.response, created.response);
  assert.equal(read.response.collection.collectionId, collectionId);
  assert.equal(read.response.schema.collectionId, collectionId);
  assert.deepEqual(read.response.schema.propertyDefinitions, [
    {
      datatype: 'title',
      mandatory: false,
      name: 'Title',
      propertyDefinitionId: read.response.schema.propertyDefinitions[0].propertyDefinitionId,
    },
  ]);
  assert.equal(read.response.task.collectionId, collectionId);
  assert.equal(read.response.task.title, '');
  assert.equal(read.response.task.revision, 1);
  assert.equal(read.response.task.createdByPrincipalId, operationContext.principalId);
  assert.equal(read.response.task.lastEditedByPrincipalId, operationContext.principalId);
  assert.equal(read.response.task.lastEditedAt, read.response.task.createdAt);
});

test('retrying the creation idempotency key returns the original durable aggregate', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = randomUUID();
  const idempotencyKey = randomUUID();
  const execute = () =>
    runAction({
      options: {
        authorizationChecker: () => ({ _tag: 'Allowed' }),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: createTicketActionRegistration,
      transport: {
        headers: new Headers({ 'Idempotency-Key': idempotencyKey }),
      },
    });

  const created = await execute();
  const replayed = await execute();

  assert.equal(created._tag, 'OperationSucceeded');
  assert.equal(replayed._tag, 'OperationSucceeded');
  assert.deepEqual(replayed.response, created.response);

  const [effects] = await sqlClient`
    select
      (select count(*)::int from ticketing.task_collections where tenant_id = ${operationContext.tenantId}) as collection_count,
      (select count(*)::int from ticketing.task_schemas where tenant_id = ${operationContext.tenantId}) as schema_count,
      (select count(*)::int from ticketing.task_property_definitions where tenant_id = ${operationContext.tenantId}) as definition_count,
      (select count(*)::int from ticketing.tasks where tenant_id = ${operationContext.tenantId}) as task_count,
      (select count(*)::int from ticketing.task_revisions where tenant_id = ${operationContext.tenantId}) as revision_count,
      (select count(*)::int from core.domain_events where tenant_id = ${operationContext.tenantId} and event_type = ${'ticketing.taskCollection.created'}) as domain_event_count,
      (select count(*)::int from core.outbox_messages where tenant_id = ${operationContext.tenantId} and topic = ${'ticketing.taskCollection.created'}) as outbox_count
  `;

  assert.deepEqual(effects, {
    collection_count: 1,
    definition_count: 1,
    domain_event_count: 1,
    outbox_count: 1,
    revision_count: 1,
    schema_count: 1,
    task_count: 1,
  });
});

test('a trusted system context is the Actor even when an untrusted override is present', async () => {
  const operationContext = await createOperationIdentity({
    displayName: 'Task Automation',
    kind: 'system',
  });
  const forgedPrincipalId = randomUUID();
  const created = await runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      actorId: forgedPrincipalId,
      collectionId: randomUUID(),
      originatingPrincipalId: forgedPrincipalId,
    },
    registration: createTicketActionRegistration,
    transport: {
      headers: new Headers({ 'Idempotency-Key': randomUUID() }),
    },
  });

  assert.equal(created._tag, 'OperationSucceeded');
  assert.equal(created.response.task.createdByPrincipalId, operationContext.principalId);
  assert.equal(created.response.task.lastEditedByPrincipalId, operationContext.principalId);
});

test('creation fails without a trusted Actor context', async () => {
  const result = await runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
    },
    payload: { collectionId: randomUUID() },
    registration: createTicketActionRegistration,
    transport: {
      headers: new Headers({ 'Idempotency-Key': randomUUID() }),
    },
  });

  assert.equal(result._tag, 'OperationAuthRequired');
});

test('creation rejects a trusted context whose Actor is no longer valid', async () => {
  const operationContext = await createOperationIdentity({ status: 'disabled' });
  const result = await runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId: randomUUID() },
    registration: createTicketActionRegistration,
    transport: {
      headers: new Headers({ 'Idempotency-Key': randomUUID() }),
    },
  });

  assert.equal(result._tag, 'OperationPolicyDenied');
  assert.equal(result.code, 'ticketing.createTicket.actor_invalid');

  const [effects] = await sqlClient`
    select count(*)::int as task_count
    from ticketing.tasks
    where tenant_id = ${operationContext.tenantId}
  `;
  assert.equal(effects.task_count, 0);
});

test('reusing an idempotency key for another collection is rejected without redirecting creation', async () => {
  const operationContext = await createOperationIdentity();
  const idempotencyKey = randomUUID();
  const firstCollectionId = randomUUID();
  const redirectedCollectionId = randomUUID();
  const execute = (collectionId) =>
    runAction({
      options: {
        authorizationChecker: () => ({ _tag: 'Allowed' }),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: createTicketActionRegistration,
      transport: {
        headers: new Headers({ 'Idempotency-Key': idempotencyKey }),
      },
    });

  const created = await execute(firstCollectionId);
  const redirected = await execute(redirectedCollectionId);

  assert.equal(created._tag, 'OperationSucceeded');
  assert.equal(redirected._tag, 'OperationIdempotencyConflict');

  const redirectedRead = await runDataAccess({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId: redirectedCollectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(redirectedRead._tag, 'OperationExecutionFailed');
});

test('a late outbox failure rolls back collection, schema, Task, revision, and accepted evidence', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = randomUUID();

  await sqlClient`
    create or replace function ticketing.reject_task_collection_outbox_for_test()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.topic = 'ticketing.taskCollection.created' then
        raise exception 'test outbox rejection';
      end if;
      return new;
    end;
    $$
  `;
  await sqlClient`
    create trigger reject_task_collection_outbox_for_test
    before insert on core.outbox_messages
    for each row execute function ticketing.reject_task_collection_outbox_for_test()
  `;

  try {
    const result = await runAction({
      options: {
        authorizationChecker: () => ({ _tag: 'Allowed' }),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: createTicketActionRegistration,
      transport: {
        headers: new Headers({ 'Idempotency-Key': randomUUID() }),
      },
    });

    assert.equal(result._tag, 'OperationExecutionFailed');

    const read = await runDataAccess({
      options: {
        authorizationChecker: () => ({ _tag: 'Allowed' }),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: getTaskCollectionDataAccessRegistration,
      resultCount: () => 1,
      transport: { headers: new Headers() },
    });
    assert.equal(read._tag, 'OperationExecutionFailed');

    const [acceptedEffects] = await sqlClient`
      select
        (select count(*)::int from core.domain_events where tenant_id = ${operationContext.tenantId} and event_type = ${'ticketing.taskCollection.created'}) as domain_event_count,
        (select count(*)::int from core.outbox_messages where tenant_id = ${operationContext.tenantId} and topic = ${'ticketing.taskCollection.created'}) as outbox_count,
        (select count(*)::int from core.audit_events where tenant_id = ${operationContext.tenantId} and event_type = ${'action.succeeded'}) as succeeded_audit_count
    `;
    assert.deepEqual(acceptedEffects, {
      domain_event_count: 0,
      outbox_count: 0,
      succeeded_audit_count: 0,
    });
  } finally {
    await sqlClient`
      drop trigger if exists reject_task_collection_outbox_for_test on core.outbox_messages
    `;
    await sqlClient`
      drop function if exists ticketing.reject_task_collection_outbox_for_test()
    `;
  }
});
