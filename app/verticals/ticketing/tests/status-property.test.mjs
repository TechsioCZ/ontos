import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createStatusPropertyDefinitionActionRegistration } from '../src/actions/create-status-property-definition.ts';
import { configureStatusDefaultActionRegistration } from '../src/actions/configure-status-default.ts';
import { createStatusOptionActionRegistration } from '../src/actions/create-status-option.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateStatusPropertyValueActionRegistration } from '../src/actions/update-status-property-value.ts';
import { updateStatusOptionActionRegistration } from '../src/actions/update-status-option.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_status_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.status_property_configurations where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.status_options where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
    }),
  );
  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async () => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Status tenant'}, ${`status-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    ) values (
      ${tenant.tenant_id}, ${'Status legal entity'}, ${'CZ'}, ${`status-${suffix}`}, ${'active'}
    ) returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Status editor'}, ${'human'}, ${'active'})
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

const allowedAuthorization = () => ({ _tag: 'Allowed' });

const runRegisteredAction = ({ operationContext, payload, registration }) =>
  runAction({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });

const readWorkspace = (operationContext, collectionId, locale = 'en-GB') =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, locale },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });

test('a new Status definition exposes its fixed groups and leaves existing Tasks Empty', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const existingTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(existingTask._tag, 'OperationSucceeded', JSON.stringify(existingTask));

  const created = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      initialColors: { complete: 'green', inProgress: 'blue', todo: 'gray' },
      mandatory: false,
      name: 'Workflow',
    },
    registration: createStatusPropertyDefinitionActionRegistration,
  });
  assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
  const { definition } = created.response;
  assert.equal(definition.defaultOptionId, definition.groups[0].options[0].optionId);
  assert.deepEqual(
    definition.groups.map(({ group, label, options }) => ({
      group,
      label,
      options: options.map(({ name, position }) => ({ name, position })),
    })),
    [
      { group: 'todo', label: 'To-do', options: [{ name: 'Not started', position: 0 }] },
      {
        group: 'in_progress',
        label: 'In progress',
        options: [{ name: 'In progress', position: 0 }],
      },
      { group: 'complete', label: 'Complete', options: [{ name: 'Done', position: 0 }] },
    ],
  );

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.propertyDefinitions.find(
      ({ propertyDefinitionId }) => propertyDefinitionId === definition.propertyDefinitionId,
    ),
    definition,
  );
  assert.deepEqual(workspace.response.tasks[0].statusValues, []);
});

test('new Tasks receive the current Default while existing and explicitly Empty values stay unchanged', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const existingTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(existingTask._tag, 'OperationSucceeded', JSON.stringify(existingTask));
  const createdDefinition = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      initialColors: { complete: 'green', inProgress: 'blue', todo: 'gray' },
      mandatory: false,
      name: 'Workflow',
    },
    registration: createStatusPropertyDefinitionActionRegistration,
  });
  assert.equal(createdDefinition._tag, 'OperationSucceeded', JSON.stringify(createdDefinition));
  const { definition } = createdDefinition.response;
  const initialDefaultOptionId = definition.defaultOptionId;
  const inProgressOptionId = definition.groups[1].options[0].optionId;

  const selectedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const clearedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(selectedTask._tag, 'OperationSucceeded', JSON.stringify(selectedTask));
  assert.equal(clearedTask._tag, 'OperationSucceeded', JSON.stringify(clearedTask));

  const cleared = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: clearedTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.deepEqual(cleared.response.value, {
    propertyDefinitionId: definition.propertyDefinitionId,
    revision: 2,
  });

  const changedDefault = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedDefinitionRevision: 1,
      optionId: inProgressOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: configureStatusDefaultActionRegistration,
  });
  assert.equal(changedDefault._tag, 'OperationSucceeded', JSON.stringify(changedDefault));
  assert.equal(changedDefault.response.definition.defaultOptionId, inProgressOptionId);

  const futureTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(futureTask._tag, 'OperationSucceeded', JSON.stringify(futureTask));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const statusValueFor = (taskId) =>
    workspace.response.tasks.find((task) => task.taskId === taskId).statusValues;
  assert.deepEqual(statusValueFor(existingTask.response.task.taskId), []);
  assert.deepEqual(statusValueFor(selectedTask.response.task.taskId), [
    {
      optionId: initialDefaultOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: 1,
    },
  ]);
  assert.deepEqual(statusValueFor(clearedTask.response.task.taskId), [
    { propertyDefinitionId: definition.propertyDefinitionId, revision: 2 },
  ]);
  assert.deepEqual(statusValueFor(futureTask.response.task.taskId), [
    {
      optionId: inProgressOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: 1,
    },
  ]);
});

test('Status Option presentation changes preserve identity and use group-local ordering', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const createdDefinition = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      initialColors: { complete: 'green', inProgress: 'blue', todo: 'gray' },
      mandatory: false,
      name: 'Workflow',
    },
    registration: createStatusPropertyDefinitionActionRegistration,
  });
  assert.equal(createdDefinition._tag, 'OperationSucceeded', JSON.stringify(createdDefinition));
  const { definition } = createdDefinition.response;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));

  const createdOption = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'amber',
      expectedDefinitionRevision: 1,
      group: 'in_progress',
      name: 'Blocked',
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: createStatusOptionActionRegistration,
  });
  assert.equal(createdOption._tag, 'OperationSucceeded', JSON.stringify(createdOption));
  assert.equal(createdOption.response.option.position, 1);
  const { optionId } = createdOption.response.option;

  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const updatedOption = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'purple',
      expectedDefinitionRevision: createdOption.response.definitionRevision,
      expectedOptionRevision: 1,
      group: 'todo',
      name: 'Ready',
      optionId,
      position: 0,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: updateStatusOptionActionRegistration,
  });
  assert.equal(updatedOption._tag, 'OperationSucceeded', JSON.stringify(updatedOption));
  assert.deepEqual(updatedOption.response.option, {
    color: 'purple',
    group: 'todo',
    name: 'Ready',
    optionId,
    position: 0,
    revision: 2,
  });

  const workspace = await readWorkspace(operationContext, collectionId, 'cs-CZ');
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const projectedDefinition = workspace.response.propertyDefinitions.find(
    (candidate) => candidate.propertyDefinitionId === definition.propertyDefinitionId,
  );
  assert.deepEqual(
    projectedDefinition.groups.map(({ group, label, options }) => ({
      group,
      label,
      options: options.map(({ color, name, optionId: id, position }) => ({
        color,
        id,
        name,
        position,
      })),
    })),
    [
      {
        group: 'todo',
        label: 'K vyřízení',
        options: [
          { color: 'purple', id: optionId, name: 'Ready', position: 0 },
          {
            color: 'gray',
            id: definition.defaultOptionId,
            name: 'Not started',
            position: 1,
          },
        ],
      },
      {
        group: 'in_progress',
        label: 'Probíhá',
        options: [
          {
            color: 'blue',
            id: definition.groups[1].options[0].optionId,
            name: 'In progress',
            position: 0,
          },
        ],
      },
      {
        group: 'complete',
        label: 'Dokončeno',
        options: [
          {
            color: 'green',
            id: definition.groups[2].options[0].optionId,
            name: 'Done',
            position: 0,
          },
        ],
      },
    ],
  );
  assert.deepEqual(workspace.response.tasks[0].statusValues, [
    {
      optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: 2,
    },
  ]);
});
