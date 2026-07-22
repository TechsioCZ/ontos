import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createDateRangePropertyDefinitionActionRegistration } from '../src/actions/create-date-range-property-definition.ts';
import { configureDateRangeTimeSupportActionRegistration } from '../src/actions/configure-date-range-time-support.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateDateRangePropertyValueActionRegistration } from '../src/actions/update-date-range-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_date_range_values where tenant_id = ${tenantId}`;
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
    values (${'Date Range tenant'}, ${`date-range-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Date Range legal entity'},
      ${'CZ'},
      ${`date-range-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Date Range editor'}, ${'human'}, ${'active'})
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
const readWorkspace = (operationContext, collectionId) =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });

test('a complete timezone-free Date Range persists through the public Ticketing seam', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
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
    payload: { collectionId, mandatory: false, name: 'Implementation window' },
    registration: createDateRangePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  assert.deepEqual(definition.response.definition, {
    datatype: 'date_range',
    hidden: false,
    mandatory: false,
    name: 'Implementation window',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
    timeEnabled: false,
  });
  const configuredDefinition = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: false,
      mandatory: false,
      name: 'Implementation period',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(
    configuredDefinition._tag,
    'OperationSucceeded',
    JSON.stringify(configuredDefinition),
  );
  assert.deepEqual(configuredDefinition.response.definition, {
    datatype: 'date_range',
    hidden: false,
    mandatory: false,
    name: 'Implementation period',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 2,
    timeEnabled: false,
  });

  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: {
        endDate: '2026-07-15',
        endTime: null,
        startDate: '2026-07-12',
        startTime: null,
      },
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(
    workspace.response.propertyDefinitions.find(
      ({ propertyDefinitionId }) =>
        propertyDefinitionId === definition.response.definition.propertyDefinitionId,
    )?.name,
    'Implementation period',
  );
  assert.deepEqual(workspace.response.tasks[0].dateRangeValues, [
    {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: {
        endDate: '2026-07-15',
        endTime: null,
        startDate: '2026-07-12',
        startTime: null,
      },
    },
  ]);
});

test('time support is per definition and disabling removes only confirmed complete time pairs', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    [0, 1].map(() =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Release window' },
    registration: createDateRangePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;

  const enabled = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: false,
      expectedAffectedValueCount: 0,
      expectedRevision: 1,
      propertyDefinitionId,
      timeEnabled: true,
    },
    registration: configureDateRangeTimeSupportActionRegistration,
  });
  assert.equal(enabled._tag, 'OperationSucceeded', JSON.stringify(enabled));
  assert.equal(enabled.response.definition.timeEnabled, true);

  const dateOnly = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId: tasks[0].response.task.taskId,
      value: {
        endDate: '2026-08-03',
        endTime: null,
        startDate: '2026-08-01',
        startTime: null,
      },
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  const withTime = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId: tasks[1].response.task.taskId,
      value: {
        endDate: '2026-08-05',
        endTime: '17:45',
        startDate: '2026-08-04',
        startTime: '09:15',
      },
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  assert.equal(dateOnly._tag, 'OperationSucceeded', JSON.stringify(dateOnly));
  assert.equal(withTime._tag, 'OperationSucceeded', JSON.stringify(withTime));

  const unconfirmed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: false,
      expectedAffectedValueCount: 1,
      expectedRevision: 2,
      propertyDefinitionId,
      timeEnabled: false,
    },
    registration: configureDateRangeTimeSupportActionRegistration,
  });
  assert.equal(unconfirmed._tag, 'OperationDomainRejected');

  const disabled = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedAffectedValueCount: 1,
      expectedRevision: 2,
      propertyDefinitionId,
      timeEnabled: false,
    },
    registration: configureDateRangeTimeSupportActionRegistration,
  });
  assert.equal(disabled._tag, 'OperationSucceeded', JSON.stringify(disabled));
  assert.equal(disabled.response.affectedValueCount, 1);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(
    workspace.response.tasks.map(({ dateRangeValues }) => dateRangeValues[0].value),
    [
      { endDate: '2026-08-03', endTime: null, startDate: '2026-08-01', startTime: null },
      { endDate: '2026-08-05', endTime: null, startDate: '2026-08-04', startTime: null },
    ],
  );
});

test('Date Range duplication always copies configuration and values into an independent numbered definition', async () => {
  const { duplicateTaskPropertyDefinitionActionRegistration } =
    await import('../src/actions/duplicate-task-property-definition.ts');
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Delivery' },
    registration: createDateRangePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const source = definition.response.definition;
  const enabled = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: false,
      expectedAffectedValueCount: 0,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
      timeEnabled: true,
    },
    registration: configureDateRangeTimeSupportActionRegistration,
  });
  assert.equal(enabled._tag, 'OperationSucceeded');
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: source.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: {
        endDate: '2026-09-11',
        endTime: '16:30',
        startDate: '2026-09-10',
        startTime: '08:00',
      },
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded');

  const duplicate = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: enabled.response.definition.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicate._tag, 'OperationSucceeded', JSON.stringify(duplicate));
  assert.equal(duplicate.response.definition.datatype, 'date_range');
  assert.equal(duplicate.response.definition.name, 'Delivery Copy');
  assert.equal(duplicate.response.definition.mandatory, true);
  assert.equal(duplicate.response.definition.timeEnabled, true);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks[0].dateRangeValues, [
    {
      propertyDefinitionId: source.propertyDefinitionId,
      revision: 1,
      value: {
        endDate: '2026-09-11',
        endTime: '16:30',
        startDate: '2026-09-10',
        startTime: '08:00',
      },
    },
    {
      propertyDefinitionId: duplicate.response.definition.propertyDefinitionId,
      revision: 1,
      value: {
        endDate: '2026-09-11',
        endTime: '16:30',
        startDate: '2026-09-10',
        startTime: '08:00',
      },
    },
  ]);

  const changedDuplicate = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: duplicate.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: {
        endDate: '2026-10-02',
        endTime: null,
        startDate: '2026-10-01',
        startTime: null,
      },
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  assert.equal(changedDuplicate._tag, 'OperationSucceeded');
  const independent = await readWorkspace(operationContext, collectionId);
  assert.equal(independent._tag, 'OperationSucceeded');
  assert.equal(independent.response.tasks[0].dateRangeValues[0].value.startDate, '2026-09-10');
  assert.equal(independent.response.tasks[0].dateRangeValues[1].value.startDate, '2026-10-01');
});

test('Date Range grouping uses the exact complete range and keeps Empty separate', async () => {
  const { groupTaskDateRangeValuesDataAccessRegistration } =
    await import('../src/data-access/group-task-date-range-values.ts');
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    [0, 1, 2, 3].map(() =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Grouping window' },
    registration: createDateRangePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const enabled = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: false,
      expectedAffectedValueCount: 0,
      expectedRevision: 1,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      timeEnabled: true,
    },
    registration: configureDateRangeTimeSupportActionRegistration,
  });
  assert.equal(enabled._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const values = [
    { endDate: '2026-11-02', endTime: null, startDate: '2026-11-01', startTime: null },
    { endDate: '2026-11-02', endTime: null, startDate: '2026-11-01', startTime: null },
    { endDate: '2026-11-02', endTime: '17:00', startDate: '2026-11-01', startTime: '09:00' },
  ];
  const valueUpdates = await Promise.all(
    values.map((value, index) =>
      runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 0,
          propertyDefinitionId,
          taskId: tasks[index].response.task.taskId,
          value,
        },
        registration: updateDateRangePropertyValueActionRegistration,
      }),
    ),
  );
  for (const result of valueUpdates) {
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  }
  const grouped = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: groupTaskDateRangeValuesDataAccessRegistration,
    resultCount: (response) => response.groups.length,
    transport: { headers: new Headers() },
  });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(grouped.response.groups, [
    { taskIds: [tasks[0].response.task.taskId, tasks[1].response.task.taskId], value: values[0] },
    { taskIds: [tasks[2].response.task.taskId], value: values[2] },
    { taskIds: [tasks[3].response.task.taskId], value: null },
  ]);
});

test('invalid Date Range drafts never replace the committed value', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Guarded range' },
    registration: createDateRangePropertyDefinitionActionRegistration,
  });
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const committed = {
    endDate: '2026-12-03',
    endTime: null,
    startDate: '2026-12-01',
    startTime: null,
  };
  const accepted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId,
      value: committed,
    },
    registration: updateDateRangePropertyValueActionRegistration,
  });
  assert.equal(accepted._tag, 'OperationSucceeded');

  const rejectedDrafts = [
    {
      code: 'ticketing.updateDateRangePropertyValue.missing_start',
      value: { ...committed, startDate: '' },
    },
    {
      code: 'ticketing.updateDateRangePropertyValue.missing_end',
      value: { ...committed, endDate: '' },
    },
    {
      code: 'ticketing.updateDateRangePropertyValue.equal_dates',
      value: { ...committed, endDate: committed.startDate },
    },
    {
      code: 'ticketing.updateDateRangePropertyValue.start_after_end',
      value: { ...committed, endDate: '2026-11-30' },
    },
    {
      code: 'ticketing.updateDateRangePropertyValue.incomplete_time_pair',
      value: { ...committed, startTime: '09:00' },
    },
    {
      code: 'ticketing.updateDateRangePropertyValue.times_disabled',
      value: { ...committed, endTime: '17:00', startTime: '09:00' },
    },
  ];
  for (const rejectedDraft of rejectedDrafts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each rejection must observe the same committed revision before the next attempt.
    const result = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 1,
        propertyDefinitionId,
        taskId,
        value: rejectedDraft.value,
      },
      registration: updateDateRangePropertyValueActionRegistration,
    });
    assert.equal(result._tag, 'OperationDomainRejected', JSON.stringify(result));
    assert.equal(result.code, rejectedDraft.code);
  }
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks[0].dateRangeValues[0].value, committed);
  assert.equal(workspace.response.tasks[0].dateRangeValues[0].revision, 1);
});
