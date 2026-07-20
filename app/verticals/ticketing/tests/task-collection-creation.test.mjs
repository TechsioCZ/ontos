import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { getTaskCollectionDataAccessRegistration } from '../src/data-access/get-task-collection.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
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

const runCollectionCreation = (operationContext, idempotencyKey = randomUUID(), options = {}) =>
  runAction({
    options: {
      ...options,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {},
    registration: createTaskCollectionActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': idempotencyKey }) },
  });

const runTaskCreation = (
  operationContext,
  collectionId,
  idempotencyKey = randomUUID(),
  payloadExtras = {},
) =>
  runAction({
    options: { operationContextResolver: operationContextResolver(operationContext) },
    payload: { collectionId, ...payloadExtras },
    registration: createTaskActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': idempotencyKey }) },
  });

test('separate standard Actions create a server-identified collection and then its blank Task', async () => {
  const operationContext = await createOperationIdentity();
  const collectionIdempotencyKey = randomUUID();
  const taskIdempotencyKey = randomUUID();
  const authorizationChecks = [];
  const authorizationChecker = (check) => {
    authorizationChecks.push(check);
    return { _tag: 'Allowed' };
  };

  const createdCollection = await runCollectionCreation(
    operationContext,
    collectionIdempotencyKey,
    {
      authorizationChecker,
    },
  );

  assert.equal(createdCollection._tag, 'OperationSucceeded', JSON.stringify(createdCollection));
  assert.notEqual(createdCollection.response.collection.collectionId, collectionIdempotencyKey);
  assert.equal(
    createdCollection.response.schema.collectionId,
    createdCollection.response.collection.collectionId,
  );
  assert.match(
    createdCollection.response.collection.createdAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  assert.deepEqual(createdCollection.response.schema.propertyDefinitions, [
    {
      datatype: 'title',
      mandatory: false,
      name: 'Title',
      propertyDefinitionId:
        createdCollection.response.schema.propertyDefinitions[0].propertyDefinitionId,
    },
  ]);

  const createdTask = await runAction({
    options: {
      authorizationChecker,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId: createdCollection.response.collection.collectionId },
    registration: createTaskActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': taskIdempotencyKey }) },
  });

  assert.equal(createdTask._tag, 'OperationSucceeded', JSON.stringify(createdTask));
  assert.notEqual(createdTask.response.task.taskId, taskIdempotencyKey);
  assert.equal(createdTask.response.task.title, '');
  assert.equal(createdTask.response.task.revision, 1);
  assert.equal(createdTask.response.task.createdByPrincipalId, operationContext.principalId);
  assert.equal(createdTask.response.task.lastEditedByPrincipalId, operationContext.principalId);
  assert.equal(createdTask.response.task.lastEditedAt, createdTask.response.task.createdAt);
  assert.match(
    createdTask.response.task.createdAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );

  const read = await runDataAccess({
    options: {
      authorizationChecker,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId: createdCollection.response.collection.collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });

  assert.equal(read._tag, 'OperationSucceeded', JSON.stringify(read));
  assert.deepEqual(read.response, { ...createdCollection.response, ...createdTask.response });
  assert.deepEqual(authorizationChecks, []);
});

test('each Action independently replays its original response', async () => {
  const operationContext = await createOperationIdentity();
  const collectionKey = randomUUID();
  const createdCollection = await runCollectionCreation(operationContext, collectionKey);
  const replayedCollection = await runCollectionCreation(operationContext, collectionKey);

  assert.equal(createdCollection._tag, 'OperationSucceeded');
  assert.equal(replayedCollection._tag, 'OperationSucceeded');
  assert.deepEqual(replayedCollection.response, createdCollection.response);

  const taskKey = randomUUID();
  const { collectionId } = createdCollection.response.collection;
  const createdTask = await runTaskCreation(operationContext, collectionId, taskKey);
  const replayedTask = await runTaskCreation(operationContext, collectionId, taskKey);

  assert.equal(createdTask._tag, 'OperationSucceeded');
  assert.equal(replayedTask._tag, 'OperationSucceeded');
  assert.deepEqual(replayedTask.response, createdTask.response);
});

test('CreateTask rejects the same idempotency key with different input', async () => {
  const operationContext = await createOperationIdentity();
  const firstCollection = await runCollectionCreation(operationContext);
  const secondCollection = await runCollectionCreation(operationContext);
  assert.equal(firstCollection._tag, 'OperationSucceeded');
  assert.equal(secondCollection._tag, 'OperationSucceeded');

  const idempotencyKey = randomUUID();
  const first = await runTaskCreation(
    operationContext,
    firstCollection.response.collection.collectionId,
    idempotencyKey,
  );
  const redirected = await runTaskCreation(
    operationContext,
    secondCollection.response.collection.collectionId,
    idempotencyKey,
  );

  assert.equal(first._tag, 'OperationSucceeded');
  assert.equal(redirected._tag, 'OperationIdempotencyConflict');
  const redirectedRead = await runDataAccess({
    options: { operationContextResolver: operationContextResolver(operationContext) },
    payload: { collectionId: secondCollection.response.collection.collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(redirectedRead._tag, 'OperationExecutionFailed');
});

test('the trusted system context is the Actor and payload overrides are ignored', async () => {
  const operationContext = await createOperationIdentity({
    displayName: 'Task Automation',
    kind: 'system',
  });
  const collection = await runCollectionCreation(operationContext);
  assert.equal(collection._tag, 'OperationSucceeded');

  const forgedPrincipalId = randomUUID();
  const created = await runTaskCreation(
    operationContext,
    collection.response.collection.collectionId,
    randomUUID(),
    { actorId: forgedPrincipalId, originatingPrincipalId: forgedPrincipalId },
  );

  assert.equal(created._tag, 'OperationSucceeded');
  assert.equal(created.response.task.createdByPrincipalId, operationContext.principalId);
  assert.equal(created.response.task.lastEditedByPrincipalId, operationContext.principalId);
});

test('Actions fail without a trusted Actor context', async () => {
  const result = await runAction({
    payload: {},
    registration: createTaskCollectionActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });

  assert.equal(result._tag, 'OperationAuthRequired');
});

test('a failed standard Action can retry the same idempotency identity', async () => {
  const operationContext = await createOperationIdentity();
  const idempotencyKey = randomUUID();
  let attempts = 0;
  const registration = {
    descriptor: {
      actionKey: 'ticketing.test.retryFailedAction',
      auditProfile: 'standard',
      gatewayAudience: 'ticketing',
      idempotency: 'required',
      moduleStateAccess: 'mutate',
      transportRequestSchema: undefined,
      transportResponseSchema: undefined,
    },
    handler: () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('controlled first-attempt failure');
      }
      return { attempts };
    },
  };
  const execute = () =>
    runAction({
      options: { operationContextResolver: operationContextResolver(operationContext) },
      payload: {},
      registration,
      transport: { headers: new Headers({ 'Idempotency-Key': idempotencyKey }) },
    });

  const failed = await execute();
  const retried = await execute();

  assert.equal(failed._tag, 'OperationExecutionFailed');
  assert.equal(retried._tag, 'OperationSucceeded');
  assert.deepEqual(retried.response, { attempts: 2 });
});

test('CoreSDK rejects missing, cross-tenant, disabled, and archived Actors before execution', async () => {
  const active = await createOperationIdentity();
  const anotherTenant = await createOperationIdentity();
  const disabled = await createOperationIdentity({ status: 'disabled' });
  const archived = await createOperationIdentity({ status: 'archived' });
  const invalidContexts = [
    { ...active, principalId: randomUUID() },
    { ...active, principalId: anotherTenant.principalId },
    disabled,
    archived,
  ];

  await Promise.all(
    invalidContexts.map(async (operationContext) => {
      const result = await runCollectionCreation(operationContext);
      assert.equal(result._tag, 'OperationContextInvalid');
    }),
  );
});

test('CreateTask tenant-scopes an existing collection through the trusted context', async () => {
  const owner = await createOperationIdentity();
  const outsider = await createOperationIdentity();
  const collection = await runCollectionCreation(owner);
  assert.equal(collection._tag, 'OperationSucceeded');

  const result = await runTaskCreation(outsider, collection.response.collection.collectionId);

  assert.equal(result._tag, 'OperationDomainRejected');
  assert.equal(result.code, 'ticketing.createTask.collection_not_found');

  const ownerCreatedTask = await runTaskCreation(
    owner,
    collection.response.collection.collectionId,
  );
  assert.equal(ownerCreatedTask._tag, 'OperationSucceeded');
  const read = await runDataAccess({
    options: { operationContextResolver: operationContextResolver(owner) },
    payload: { collectionId: collection.response.collection.collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(read._tag, 'OperationSucceeded');
});
