import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createMultiSelectPropertyDefinitionActionRegistration } from '../src/actions/create-multi-select-property-definition.ts';
import { createMultiSelectOptionActionRegistration } from '../src/actions/create-multi-select-option.ts';
import { createMultiSelectOptionAndSelectActionRegistration } from '../src/actions/create-multi-select-option-and-select.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { reorderMultiSelectOptionsActionRegistration } from '../src/actions/reorder-multi-select-options.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { updateMultiSelectPropertyValueActionRegistration } from '../src/actions/update-multi-select-property-value.ts';
import { updateMultiSelectOptionActionRegistration } from '../src/actions/update-multi-select-option.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_multi_select_selections where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_multi_select_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.multi_select_options where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_checkbox_values where tenant_id = ${tenantId}`;
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
    values (${'Multi-select tenant'}, ${`multi-select-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    ) values (
      ${tenant.tenant_id}, ${'Multi-select legal entity'}, ${'CZ'}, ${`multi-select-${suffix}`}, ${'active'}
    ) returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Multi-select editor'}, ${'human'}, ${'active'})
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

const assertIsoTimestamp = (value) => {
  assert.equal(typeof value, 'string');
  assert.equal(Number.isNaN(Date.parse(value)), false);
};

const authorizationForRole = (role) => (check) => {
  const permissions = {
    Editor: ['edit_task_property_values', 'manage_property_definitions', 'view_task_properties'],
    'Full access': [
      'edit_task_property_values',
      'manage_property_definitions',
      'view_task_properties',
    ],
    User: ['edit_task_property_values', 'view_task_properties'],
    Viewer: ['view_task_properties'],
  };
  return permissions[role].includes(check.permission)
    ? { _tag: 'Allowed' }
    : { _tag: 'Denied', message: `${role} lacks ${check.permission}.` };
};

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

const readWorkspace = (operationContext, collectionId) =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, locale: 'en-GB' },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });

test('Multi-select definitions give existing and new Tasks revision-bearing Empty values', async () => {
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

  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Labels' },
    registration: createMultiSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const newTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(newTask._tag, 'OperationSucceeded', JSON.stringify(newTask));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const valuesByTask = new Map(
    workspace.response.tasks.map(({ multiSelectValues, taskId }) => [taskId, multiSelectValues]),
  );
  for (const taskId of [existingTask.response.task.taskId, newTask.response.task.taskId]) {
    const [value] = valuesByTask.get(taskId);
    assert.deepEqual(
      {
        optionIds: value.optionIds,
        propertyDefinitionId: value.propertyDefinitionId,
        revision: value.revision,
      },
      { optionIds: [], propertyDefinitionId, revision: 1 },
    );
    assertIsoTimestamp(value.updatedAt);
  }
});

test('Multi-select mutations persist a unique set and return selections in catalog order', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Labels' },
    registration: createMultiSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const backend = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'blue',
      expectedDefinitionRevision: 1,
      name: 'Backend',
      propertyDefinitionId,
    },
    registration: createMultiSelectOptionActionRegistration,
  });
  assert.equal(backend._tag, 'OperationSucceeded', JSON.stringify(backend));
  assertIsoTimestamp(backend.response.option.updatedAt);
  const bug = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: backend.response.definitionRevision,
      name: 'Bug',
      propertyDefinitionId,
    },
    registration: createMultiSelectOptionActionRegistration,
  });
  assert.equal(bug._tag, 'OperationSucceeded', JSON.stringify(bug));

  const changed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionIds: [
        bug.response.option.optionId,
        backend.response.option.optionId,
        bug.response.option.optionId,
      ],
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateMultiSelectPropertyValueActionRegistration,
  });
  assert.equal(changed._tag, 'OperationSucceeded', JSON.stringify(changed));
  assert.deepEqual(
    { ...changed.response.value, updatedAt: undefined },
    {
      optionIds: [backend.response.option.optionId, bug.response.option.optionId],
      propertyDefinitionId,
      revision: 2,
      updatedAt: undefined,
    },
  );
  assertIsoTimestamp(changed.response.value.updatedAt);

  const cleared = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: changed.response.value.revision,
      optionIds: [],
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateMultiSelectPropertyValueActionRegistration,
  });
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.deepEqual(
    { ...cleared.response.value, updatedAt: undefined },
    {
      optionIds: [],
      propertyDefinitionId,
      revision: 3,
      updatedAt: undefined,
    },
  );
  assertIsoTimestamp(cleared.response.value.updatedAt);

  const stale = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: changed.response.value.revision,
      optionIds: [backend.response.option.optionId],
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateMultiSelectPropertyValueActionRegistration,
  });
  assert.equal(stale._tag, 'OperationDomainRejected');
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].multiSelectValues, [{ ...cleared.response.value }]);
});

test('catalog rename, recolor, and reorder change display without changing membership', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Labels' },
    registration: createMultiSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const backend = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'blue',
      expectedDefinitionRevision: 1,
      name: ' Backend ',
      propertyDefinitionId,
    },
    registration: createMultiSelectOptionActionRegistration,
  });
  assert.equal(backend._tag, 'OperationSucceeded', JSON.stringify(backend));
  assert.equal(backend.response.option.name, 'Backend');
  const bug = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: backend.response.definitionRevision,
      name: 'Bug',
      propertyDefinitionId,
    },
    registration: createMultiSelectOptionActionRegistration,
  });
  assert.equal(bug._tag, 'OperationSucceeded', JSON.stringify(bug));
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      optionIds: [backend.response.option.optionId, bug.response.option.optionId],
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateMultiSelectPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const duplicateName = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'green',
      expectedRevision: backend.response.option.revision,
      name: ' bug ',
      optionId: backend.response.option.optionId,
      propertyDefinitionId,
    },
    registration: updateMultiSelectOptionActionRegistration,
  });
  assert.equal(duplicateName._tag, 'OperationDomainRejected');
  const commaName = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'green',
      expectedRevision: backend.response.option.revision,
      name: 'API, Backend',
      optionId: backend.response.option.optionId,
      propertyDefinitionId,
    },
    registration: updateMultiSelectOptionActionRegistration,
  });
  assert.equal(commaName._tag, 'OperationDomainRejected');

  const renamed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'cyan',
      expectedRevision: backend.response.option.revision,
      name: 'API',
      optionId: backend.response.option.optionId,
      propertyDefinitionId,
    },
    registration: updateMultiSelectOptionActionRegistration,
  });
  assert.equal(renamed._tag, 'OperationSucceeded', JSON.stringify(renamed));
  const reordered = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedDefinitionRevision: renamed.response.definitionRevision,
      optionIds: [bug.response.option.optionId, backend.response.option.optionId],
      propertyDefinitionId,
    },
    registration: reorderMultiSelectOptionsActionRegistration,
  });
  assert.equal(reordered._tag, 'OperationSucceeded', JSON.stringify(reordered));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const publicDefinition = workspace.response.propertyDefinitions.find(
    (candidate) => candidate.propertyDefinitionId === propertyDefinitionId,
  );
  assert.deepEqual(
    publicDefinition.options.map(({ color, name, optionId }) => ({ color, name, optionId })),
    [
      { color: 'red', name: 'Bug', optionId: bug.response.option.optionId },
      { color: 'cyan', name: 'API', optionId: backend.response.option.optionId },
    ],
  );
  assert.deepEqual(workspace.response.tasks[0].multiSelectValues, [
    {
      optionIds: [bug.response.option.optionId, backend.response.option.optionId],
      propertyDefinitionId,
      revision: selected.response.value.revision,
      updatedAt: selected.response.value.updatedAt,
    },
  ]);
});

test('inline creation atomically appends one shared option only to the current Task selection', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const currentTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const otherTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(currentTask._tag, 'OperationSucceeded', JSON.stringify(currentTask));
  assert.equal(otherTask._tag, 'OperationSucceeded', JSON.stringify(otherTask));
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Labels' },
    registration: createMultiSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;

  const userAttempt = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      color: 'purple',
      expectedDefinitionRevision: 1,
      expectedValueRevision: 1,
      name: 'Research',
      propertyDefinitionId,
      taskId: currentTask.response.task.taskId,
    },
    registration: createMultiSelectOptionAndSelectActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(userAttempt._tag, 'OperationAuthorizationDenied');

  const createdAndSelected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'purple',
      expectedDefinitionRevision: 1,
      expectedValueRevision: 1,
      name: 'Research',
      propertyDefinitionId,
      taskId: currentTask.response.task.taskId,
    },
    registration: createMultiSelectOptionAndSelectActionRegistration,
  });
  assert.equal(createdAndSelected._tag, 'OperationSucceeded', JSON.stringify(createdAndSelected));
  assert.equal(createdAndSelected.response.option.color, 'purple');
  assert.deepEqual(createdAndSelected.response.value.optionIds, [
    createdAndSelected.response.option.optionId,
  ]);

  const failedAtomicAttempt = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'orange',
      expectedDefinitionRevision: createdAndSelected.response.definitionRevision,
      expectedValueRevision: 1,
      name: 'Orphan',
      propertyDefinitionId,
      taskId: randomUUID(),
    },
    registration: createMultiSelectOptionAndSelectActionRegistration,
  });
  assert.equal(failedAtomicAttempt._tag, 'OperationDomainRejected');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const publicDefinition = workspace.response.propertyDefinitions.find(
    (candidate) => candidate.propertyDefinitionId === propertyDefinitionId,
  );
  assert.deepEqual(
    publicDefinition.options.map(({ name }) => name),
    ['Research'],
  );
  const valuesByTask = new Map(
    workspace.response.tasks.map(({ multiSelectValues, taskId }) => [taskId, multiSelectValues]),
  );
  assert.deepEqual(valuesByTask.get(currentTask.response.task.taskId), [
    {
      optionIds: [createdAndSelected.response.option.optionId],
      propertyDefinitionId,
      revision: 2,
      updatedAt: createdAndSelected.response.value.updatedAt,
    },
  ]);
  const [otherValue] = valuesByTask.get(otherTask.response.task.taskId);
  assert.deepEqual(
    {
      optionIds: otherValue.optionIds,
      propertyDefinitionId: otherValue.propertyDefinitionId,
      revision: otherValue.revision,
    },
    { optionIds: [], propertyDefinitionId, revision: 1 },
  );
  assertIsoTimestamp(otherValue.updatedAt);
});

test('generic Multi-select configuration returns the complete catalog definition', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Labels' },
    registration: createMultiSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'purple',
      expectedDefinitionRevision: 1,
      name: 'Research',
      propertyDefinitionId,
    },
    registration: createMultiSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: option.response.definitionRevision,
      hidden: true,
      mandatory: true,
      name: 'Tags',
      propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    datatype: 'multi_select',
    hidden: true,
    mandatory: true,
    name: 'Tags',
    options: [option.response.option],
    propertyDefinitionId,
    revision: option.response.definitionRevision + 1,
  });
});

test('Multi-select Action evidence is revision-bearing metadata without labels or colors', () => {
  const input = {
    collectionId: randomUUID(),
    color: 'secret-color',
    expectedDefinitionRevision: 4,
    expectedValueRevision: 7,
    name: 'Sensitive label',
    propertyDefinitionId: randomUUID(),
    taskId: randomUUID(),
  };
  const response = {
    definitionRevision: 5,
    option: {
      catalogPosition: 2,
      color: input.color,
      name: input.name,
      optionId: randomUUID(),
      revision: 1,
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    taskRevision: 9,
    value: {
      optionIds: [randomUUID()],
      propertyDefinitionId: input.propertyDefinitionId,
      revision: 8,
      updatedAt: '2026-07-22T00:00:01.000Z',
    },
  };
  const { descriptor } = createMultiSelectOptionAndSelectActionRegistration;
  const auditEvidence = descriptor.auditEvent.evidence(input, response);
  const domainPayload = descriptor.domainEvent.payload(input, response);

  assert.deepEqual(auditEvidence, domainPayload);
  assert.equal(JSON.stringify(auditEvidence).includes(input.name), false);
  assert.equal(JSON.stringify(auditEvidence).includes(input.color), false);
  assert.equal(auditEvidence.revision, response.value.revision);
  assert.equal(auditEvidence.taskRevision, response.taskRevision);
});
