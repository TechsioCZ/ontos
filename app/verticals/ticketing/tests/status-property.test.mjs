import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { Schema } from '@modern-js/plugin-bff/effect-client';
import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createStatusPropertyDefinitionActionRegistration } from '../src/actions/create-status-property-definition.ts';
import { configureStatusDefaultActionRegistration } from '../src/actions/configure-status-default.ts';
import { createStatusOptionActionRegistration } from '../src/actions/create-status-option.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteStatusOptionActionRegistration } from '../src/actions/delete-status-option.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateStatusPropertyValueActionRegistration } from '../src/actions/update-status-property-value.ts';
import { updateStatusOptionActionRegistration } from '../src/actions/update-status-option.ts';
import { getStatusOptionDeletionImpactDataAccessRegistration } from '../src/data-access/get-status-option-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { queryTaskPropertyValuesDataAccessRegistration } from '../src/data-access/query-task-property-values.ts';
import { taskPropertyQuerySchema } from '../shared/task-property-query.ts';

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

  const unchangedOption = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'purple',
      expectedDefinitionRevision: updatedOption.response.definitionRevision,
      expectedOptionRevision: updatedOption.response.option.revision,
      group: 'todo',
      name: 'Ready',
      optionId,
      position: 0,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: updateStatusOptionActionRegistration,
  });
  assert.equal(unchangedOption._tag, 'OperationSucceeded', JSON.stringify(unchangedOption));
  assert.equal(
    unchangedOption.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );
  assert.deepEqual(unchangedOption.response, updatedOption.response);

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

test('confirmed non-default Status Option deletion replaces affected Tasks with current Default', async () => {
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
  const [
    ,
    {
      options: [selectedOption],
    },
  ] = definition.groups;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: getStatusOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  assert.equal(preview.response.impactCount, 1);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: preview.response.definitionRevision,
      expectedImpactCount: preview.response.impactCount,
      expectedImpactToken: preview.response.impactToken,
      expectedOptionRevision: preview.response.optionRevision,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: deleteStatusOptionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  assert.equal(deleted.response.impactCount, 1);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(
    workspace.response.propertyDefinitions
      .find(({ propertyDefinitionId }) => propertyDefinitionId === definition.propertyDefinitionId)
      .groups.flatMap(({ options }) => options)
      .some(({ optionId }) => optionId === selectedOption.optionId),
    false,
  );
  assert.deepEqual(workspace.response.tasks[0].statusValues, [
    {
      optionId: definition.defaultOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: 3,
    },
  ]);
});

test('the current Default Status Option remains protected from deletion', async () => {
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
  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      optionId: definition.defaultOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: getStatusOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: preview.response.definitionRevision,
      expectedImpactCount: preview.response.impactCount,
      expectedImpactToken: preview.response.impactToken,
      expectedOptionRevision: preview.response.optionRevision,
      optionId: definition.defaultOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: deleteStatusOptionActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.deleteStatusOption.default_protected');
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(
    workspace.response.propertyDefinitions
      .find(({ propertyDefinitionId }) => propertyDefinitionId === definition.propertyDefinitionId)
      .groups.flatMap(({ options }) => options).length,
    3,
  );
});

test('Status Option deletion rejects a stale retained-Task impact even when the count is unchanged', async () => {
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
  const [
    ,
    {
      options: [selectedOption],
    },
  ] = definition.groups;
  const firstTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const secondTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(firstTask._tag, 'OperationSucceeded', JSON.stringify(firstTask));
  assert.equal(secondTask._tag, 'OperationSucceeded', JSON.stringify(secondTask));
  const firstSelected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: firstTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(firstSelected._tag, 'OperationSucceeded', JSON.stringify(firstSelected));
  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: getStatusOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  assert.equal(preview.response.impactCount, 1);
  const firstReplaced = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: firstSelected.response.value.revision,
      optionId: definition.defaultOptionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: firstTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(firstReplaced._tag, 'OperationSucceeded', JSON.stringify(firstReplaced));
  const secondSelected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: secondTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(secondSelected._tag, 'OperationSucceeded', JSON.stringify(secondSelected));
  const staleAttempt = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: preview.response.definitionRevision,
      expectedImpactCount: preview.response.impactCount,
      expectedImpactToken: preview.response.impactToken,
      expectedOptionRevision: preview.response.optionRevision,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: deleteStatusOptionActionRegistration,
  });
  assert.equal(staleAttempt._tag, 'OperationDomainRejected', JSON.stringify(staleAttempt));
  assert.equal(staleAttempt.code, 'ticketing.deleteStatusOption.stale_impact');

  const freshPreview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: getStatusOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(freshPreview._tag, 'OperationSucceeded', JSON.stringify(freshPreview));
  assert.equal(freshPreview.response.impactCount, preview.response.impactCount);
  assert.notEqual(freshPreview.response.impactToken, preview.response.impactToken);
  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: freshPreview.response.definitionRevision,
      expectedImpactCount: freshPreview.response.impactCount,
      expectedImpactToken: freshPreview.response.impactToken,
      expectedOptionRevision: freshPreview.response.optionRevision,
      optionId: selectedOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
    },
    registration: deleteStatusOptionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks
      .flatMap(({ statusValues }) => statusValues)
      .filter(
        ({ propertyDefinitionId }) => propertyDefinitionId === definition.propertyDefinitionId,
      )
      .map(({ optionId }) => optionId),
    [definition.defaultOptionId, definition.defaultOptionId],
  );
});

test('Status duplication creates independent option identities and remaps values while preserving Empty', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const emptyTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(emptyTask._tag, 'OperationSucceeded', JSON.stringify(emptyTask));
  const createdDefinition = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      initialColors: { complete: 'green', inProgress: 'blue', todo: 'gray' },
      mandatory: true,
      name: 'Workflow',
    },
    registration: createStatusPropertyDefinitionActionRegistration,
  });
  assert.equal(createdDefinition._tag, 'OperationSucceeded', JSON.stringify(createdDefinition));
  const source = createdDefinition.response.definition;
  const valuedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(valuedTask._tag, 'OperationSucceeded', JSON.stringify(valuedTask));
  const [
    ,
    {
      options: [selectedSourceOption],
    },
  ] = source.groups;
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId: selectedSourceOption.optionId,
      propertyDefinitionId: source.propertyDefinitionId,
      taskId: valuedTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));
  const duplicate = duplicated.response.definition;
  assert.equal(duplicate.datatype, 'status');
  assert.equal(duplicate.name, 'Workflow Copy');
  assert.equal(duplicate.mandatory, true);
  const sourceOptions = source.groups.flatMap(({ options }) => options);
  const duplicateOptions = duplicate.groups.flatMap(({ options }) => options);
  assert.deepEqual(
    duplicateOptions.map(({ color, group, name, position }) => ({ color, group, name, position })),
    sourceOptions.map(({ color, group, name, position }) => ({ color, group, name, position })),
  );
  assert.equal(
    duplicateOptions.some(({ optionId }) =>
      sourceOptions.some((sourceOption) => sourceOption.optionId === optionId),
    ),
    false,
  );
  assert.equal(
    duplicateOptions.find(({ name }) => name === 'Not started').optionId,
    duplicate.defaultOptionId,
  );

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks.find(({ taskId }) => taskId === emptyTask.response.task.taskId)
      .statusValues,
    [],
  );
  const copiedValue = workspace.response.tasks
    .find(({ taskId }) => taskId === valuedTask.response.task.taskId)
    .statusValues.find(
      ({ propertyDefinitionId }) => propertyDefinitionId === duplicate.propertyDefinitionId,
    );
  assert.equal(
    copiedValue.optionId,
    duplicateOptions.find(({ name }) => name === selectedSourceOption.name).optionId,
  );
});

test('Status duplication without values stays independent and gives future Tasks each Default', async () => {
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
  const source = createdDefinition.response.definition;
  const existingTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(existingTask._tag, 'OperationSucceeded', JSON.stringify(existingTask));
  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));
  const duplicate = duplicated.response.definition;
  const [
    ,
    {
      options: [sourceInProgress],
    },
  ] = source.groups;
  const changedSourceDefault = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedDefinitionRevision: source.revision,
      optionId: sourceInProgress.optionId,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: configureStatusDefaultActionRegistration,
  });
  assert.equal(
    changedSourceDefault._tag,
    'OperationSucceeded',
    JSON.stringify(changedSourceDefault),
  );
  const futureTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(futureTask._tag, 'OperationSucceeded', JSON.stringify(futureTask));
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const existingValues = workspace.response.tasks.find(
    ({ taskId }) => taskId === existingTask.response.task.taskId,
  ).statusValues;
  assert.equal(
    existingValues.some(
      ({ propertyDefinitionId }) => propertyDefinitionId === duplicate.propertyDefinitionId,
    ),
    false,
  );
  const futureValues = workspace.response.tasks.find(
    ({ taskId }) => taskId === futureTask.response.task.taskId,
  ).statusValues;
  assert.equal(
    futureValues.find(
      ({ propertyDefinitionId }) => propertyDefinitionId === source.propertyDefinitionId,
    ).optionId,
    sourceInProgress.optionId,
  );
  assert.equal(
    futureValues.find(
      ({ propertyDefinitionId }) => propertyDefinitionId === duplicate.propertyDefinitionId,
    ).optionId,
    duplicate.defaultOptionId,
  );
  assert.notEqual(duplicate.defaultOptionId, source.defaultOptionId);
});

test('Status search matches option names and grouping uses stable option identity with Empty separate', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const emptyTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(emptyTask._tag, 'OperationSucceeded', JSON.stringify(emptyTask));
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
  const defaultTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const inProgressTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(defaultTask._tag, 'OperationSucceeded', JSON.stringify(defaultTask));
  assert.equal(inProgressTask._tag, 'OperationSucceeded', JSON.stringify(inProgressTask));
  const [
    ,
    {
      options: [inProgressOption],
    },
  ] = definition.groups;
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionId: inProgressOption.optionId,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: inProgressTask.response.task.taskId,
    },
    registration: updateStatusPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const query = (operation) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId: definition.propertyDefinitionId,
        query: { datatype: 'status', operation },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: ({ taskIds }) => taskIds.length,
      transport: { headers: new Headers() },
    });
  const searched = await query({ query: 'PROGRESS', type: 'search' });
  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(searched.response.taskIds, [inProgressTask.response.task.taskId]);

  const grouped = await query({ type: 'group' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(
    grouped.response.taskIds,
    [
      defaultTask.response.task.taskId,
      emptyTask.response.task.taskId,
      inProgressTask.response.task.taskId,
    ].toSorted(),
  );
  assert.deepEqual(
    grouped.response.groups.find(({ identity }) => identity === null),
    { heading: null, identity: null, taskIds: [emptyTask.response.task.taskId] },
  );
  assert.deepEqual(
    grouped.response.groups.find(({ identity }) => identity === definition.defaultOptionId),
    {
      heading: 'Not started',
      identity: definition.defaultOptionId,
      taskIds: [defaultTask.response.task.taskId],
    },
  );
  assert.deepEqual(
    grouped.response.groups.find(({ identity }) => identity === inProgressOption.optionId),
    {
      heading: 'In progress',
      identity: inProgressOption.optionId,
      taskIds: [inProgressTask.response.task.taskId],
    },
  );

  for (const unsupportedOperation of [
    { operator: 'isEmpty', type: 'filter' },
    { direction: 'ascending', type: 'sort' },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(taskPropertyQuerySchema)({
        datatype: 'status',
        operation: unsupportedOperation,
      }),
    );
  }
});
