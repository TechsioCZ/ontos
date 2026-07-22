/* oxlint-disable prefer-destructuring, no-await-expression-member -- Public outcomes are asserted inline to keep each acceptance scenario readable. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createNumberPropertyDefinitionActionRegistration } from '../src/actions/create-number-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateNumberPropertyValueActionRegistration } from '../src/actions/update-number-property-value.ts';
import { configureNumberPropertyFormatActionRegistration } from '../src/actions/configure-number-property-format.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { queryTaskPropertyValuesDataAccessRegistration } from '../src/data-access/query-task-property-values.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_number_values where tenant_id = ${tenantId}`;
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
    values (${'Number tenant'}, ${`number-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Number legal entity'},
      ${'CZ'},
      ${`number-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Number editor'}, ${'human'}, ${'active'})
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

const authorizationForRole =
  (role, checks = []) =>
  (check) => {
    checks.push(check);
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

const runRegisteredDataAccess = ({ operationContext, payload, registration, resultCount }) =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration,
    resultCount,
    transport: { headers: new Headers() },
  });

test('an Editor creates Number and stores exact zero distinctly from Empty', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const [emptyTask, valuedTask] = await Promise.all(
    [0, 1].map(() =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  assert.equal(emptyTask._tag, 'OperationSucceeded', JSON.stringify(emptyTask));
  assert.equal(valuedTask._tag, 'OperationSucceeded', JSON.stringify(valuedTask));

  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  assert.deepEqual(definition.response.definition, {
    datatype: 'number',
    format: 'number',
    hidden: false,
    mandatory: false,
    name: 'Estimate',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
  });

  const update = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: valuedTask.response.task.taskId,
      value: '0',
    },
    registration: updateNumberPropertyValueActionRegistration,
  });
  assert.equal(update._tag, 'OperationSucceeded', JSON.stringify(update));
  assert.deepEqual(update.response, {
    taskRevision: 2,
    value: {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: '0',
    },
  });

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const empty = workspace.response.tasks.find(
    ({ taskId }) => taskId === emptyTask.response.task.taskId,
  );
  const valued = workspace.response.tasks.find(
    ({ taskId }) => taskId === valuedTask.response.task.taskId,
  );
  assert.deepEqual(empty.numberValues, []);
  assert.deepEqual(valued.numberValues, [
    {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: '0',
    },
  ]);
});

test('invalid and out-of-bound decimals are rejected atomically without replacing the committed value', async () => {
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
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const taskId = task.response.task.taskId;
  const accepted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId,
      value: '-123.4500',
    },
    registration: updateNumberPropertyValueActionRegistration,
  });
  assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));
  assert.equal(accepted.response.value.value, '-123.45');

  for (const invalidValue of [
    '+1',
    '1e3',
    'NaN',
    'Infinity',
    '12a5',
    '1.2.3',
    '123456789012345678901',
    '0.1234567890123456789',
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each rejection observes the unchanged revision.
    const rejected = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 1,
        propertyDefinitionId,
        taskId,
        value: invalidValue,
      },
      registration: updateNumberPropertyValueActionRegistration,
    });
    assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
    assert.equal(rejected.code, 'ticketing.updateNumberPropertyValue.invalid_decimal');
  }

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].numberValues, [
    { propertyDefinitionId, revision: 1, value: '-123.45' },
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
});

test('a Mandatory Number rejects clearing and leaves its committed value and revisions intact', async () => {
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
    payload: { collectionId, mandatory: true, name: 'Required estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const populated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '5',
    },
    registration: updateNumberPropertyValueActionRegistration,
  });
  assert.equal(populated._tag, 'OperationSucceeded', JSON.stringify(populated));

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: null,
    },
    registration: updateNumberPropertyValueActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.updateNumberPropertyValue.mandatory_empty');

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
  assert.deepEqual(workspace.response.tasks[0].numberValues, [
    { propertyDefinitionId, revision: 1, value: '5' },
  ]);
});

test('Number queries use canonical search, mathematical comparisons, numeric sort, and equality groups', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const records = [];

  for (const value of ['-2', '0', '1', '1.0', '1250', null]) {
    // oxlint-disable-next-line no-await-in-loop -- Tasks are created through the public command seam.
    const task = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
    records.push({ taskId: task.response.task.taskId, value });
    if (value !== null) {
      // oxlint-disable-next-line no-await-in-loop -- Each Task receives its independent value.
      const update = await runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 0,
          propertyDefinitionId,
          taskId: task.response.task.taskId,
          value,
        },
        registration: updateNumberPropertyValueActionRegistration,
      });
      assert.equal(update._tag, 'OperationSucceeded', JSON.stringify(update));
    }
  }

  const query = async (operation) => {
    const result = await runRegisteredDataAccess({
      operationContext,
      payload: {
        collectionId,
        propertyDefinitionId,
        query: { datatype: 'number', operation },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length + (response.groups?.length ?? 0),
    });
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
    return result.response;
  };
  const ids = (...values) =>
    records.filter((record) => values.includes(record.value)).map((record) => record.taskId);

  assert.deepEqual((await query({ query: '25', type: 'search' })).taskIds, ids('1250').toSorted());
  assert.deepEqual(
    (await query({ operator: 'greaterThan', type: 'filter', value: '0' })).taskIds,
    ids('1', '1.0', '1250').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'equal', type: 'filter', value: '1.00' })).taskIds,
    ids('1', '1.0').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'notEqual', type: 'filter', value: '1' })).taskIds,
    ids('-2', '0', '1250').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'lessThan', type: 'filter', value: '0' })).taskIds,
    ids('-2').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'greaterThanOrEqual', type: 'filter', value: '1' })).taskIds,
    ids('1', '1.0', '1250').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'lessThanOrEqual', type: 'filter', value: '0' })).taskIds,
    ids('-2', '0').toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'isEmpty', type: 'filter' })).taskIds,
    ids(null).toSorted(),
  );
  assert.deepEqual(
    (await query({ operator: 'isNotEmpty', type: 'filter' })).taskIds,
    ids('-2', '0', '1', '1.0', '1250').toSorted(),
  );
  const ascending = await query({ direction: 'ascending', type: 'sort' });
  assert.deepEqual(ascending.taskIds, [
    ...ids('-2'),
    ...ids('0'),
    ...ids('1', '1.0').toSorted(),
    ...ids('1250'),
    ...ids(null),
  ]);
  const descending = await query({ direction: 'descending', type: 'sort' });
  assert.deepEqual(descending.taskIds, [
    ...ids('1250'),
    ...ids('1', '1.0').toSorted(),
    ...ids('0'),
    ...ids('-2'),
    ...ids(null),
  ]);

  const grouped = await query({ type: 'group' });
  assert.deepEqual(
    grouped.groups.map(({ heading }) => heading),
    ['-2', '0', '1', '1250', null],
  );
  assert.deepEqual(grouped.groups[2].taskIds, ids('1', '1.0').toSorted());
});

test('display format changes do not rewrite values and duplication optionally snapshots exact values', async () => {
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
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Completion' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '25',
    },
    registration: updateNumberPropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const formatted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      format: 'percent',
      propertyDefinitionId,
    },
    registration: configureNumberPropertyFormatActionRegistration,
  });
  assert.equal(formatted._tag, 'OperationSucceeded', JSON.stringify(formatted));
  assert.deepEqual(formatted.response.definition, {
    ...definition.response.definition,
    format: 'percent',
    revision: 2,
  });

  const copied = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: 2,
      propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  const blank = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: 2,
      propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(copied._tag, 'OperationSucceeded', JSON.stringify(copied));
  assert.equal(blank._tag, 'OperationSucceeded', JSON.stringify(blank));
  assert.deepEqual(copied.response.definition, {
    datatype: 'number',
    format: 'percent',
    hidden: false,
    mandatory: true,
    name: 'Completion Copy',
    propertyDefinitionId: copied.response.definition.propertyDefinitionId,
    revision: 1,
  });
  assert.equal(blank.response.definition.name, 'Completion Copy 2');
  assert.equal(blank.response.definition.format, 'percent');

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].numberValues, [
    { propertyDefinitionId, revision: 1, value: '25' },
    {
      propertyDefinitionId: copied.response.definition.propertyDefinitionId,
      revision: 1,
      value: '25',
    },
  ]);
});

test('clearing Number preserves a revision that rejects a stale overwrite and accepts the fresh draft', async () => {
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
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const taskId = task.response.task.taskId;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, expectedRevision, propertyDefinitionId, taskId, value },
      registration: updateNumberPropertyValueActionRegistration,
    });

  assert.equal((await update(0, '5'))._tag, 'OperationSucceeded');
  const cleared = await update(1, null);
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.deepEqual(cleared.response.value, {
    propertyDefinitionId,
    revision: 2,
    value: null,
  });
  const stale = await update(1, '9');
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updateNumberPropertyValue.stale_or_missing');
  const fresh = await update(2, '9');
  assert.equal(fresh._tag, 'OperationSucceeded', JSON.stringify(fresh));
  assert.deepEqual(fresh.response.value, {
    propertyDefinitionId,
    revision: 3,
    value: '9',
  });
});

test('Number deletion counts non-empty values across retained lifecycle states and excludes hard deletion', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Estimate' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const propertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const taskCases = [
    { transition: undefined, value: '0' },
    { transition: 'archive', value: '5' },
    { transition: 'softDelete', value: '6' },
    { transition: 'hardDelete', value: '7' },
    { clear: true, transition: undefined, value: '8' },
    { transition: undefined, value: null },
  ];
  for (const taskCase of taskCases) {
    // oxlint-disable-next-line no-await-in-loop -- Each Task is independently observable.
    const task = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
    if (taskCase.value !== null) {
      // oxlint-disable-next-line no-await-in-loop -- Each value uses its own public command.
      const update = await runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 0,
          propertyDefinitionId,
          taskId: task.response.task.taskId,
          value: taskCase.value,
        },
        registration: updateNumberPropertyValueActionRegistration,
      });
      assert.equal(update._tag, 'OperationSucceeded', JSON.stringify(update));
    }
    if (taskCase.clear) {
      // oxlint-disable-next-line no-await-in-loop -- Lifecycle cases are asserted independently.
      const cleared = await runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 1,
          propertyDefinitionId,
          taskId: task.response.task.taskId,
          value: null,
        },
        registration: updateNumberPropertyValueActionRegistration,
      });
      assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
    }
    if (taskCase.transition !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- Lifecycle cases are asserted independently.
      const transitioned = await runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 2,
          taskId: task.response.task.taskId,
          transition: taskCase.transition,
        },
        registration: transitionTaskRetentionActionRegistration,
      });
      assert.equal(transitioned._tag, 'OperationSucceeded', JSON.stringify(transitioned));
    }
  }

  const impact = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.deepEqual(impact.response, { impactCount: 3, propertyDefinitionId, revision: 1 });

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 3,
      expectedRevision: 1,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, []);
  assert.equal(workspace.response.tasks.length, 5);
  assert.equal(
    workspace.response.tasks.every(({ numberValues }) => numberValues === undefined),
    true,
  );
});

test('Number schema, format, value, and query operations enforce the collection role matrix', async () => {
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
  const seed = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Seed Number' },
    registration: createNumberPropertyDefinitionActionRegistration,
  });
  assert.equal(seed._tag, 'OperationSucceeded', JSON.stringify(seed));
  const propertyDefinitionId = seed.response.definition.propertyDefinitionId;
  const roles = ['Full access', 'Editor', 'User', 'Viewer'];

  for (const role of roles) {
    const checks = [];
    // oxlint-disable-next-line no-await-in-loop -- Each role is an independent authorization case.
    const result = await runAction({
      options: {
        authorizationChecker: authorizationForRole(role, checks),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId, mandatory: false, name: `${role} Number` },
      registration: createNumberPropertyDefinitionActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
    });
    assert.equal(
      result._tag,
      role === 'Full access' || role === 'Editor'
        ? 'OperationSucceeded'
        : 'OperationAuthorizationDenied',
    );
    assert.equal(checks[0].permission, 'manage_property_definitions');
  }

  let definitionRevision = 1;
  for (const [index, role] of roles.entries()) {
    const checks = [];
    // oxlint-disable-next-line no-await-in-loop -- Definition revisions make this matrix sequential.
    const result = await runAction({
      options: {
        authorizationChecker: authorizationForRole(role, checks),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        expectedRevision: definitionRevision,
        format: index === 0 ? 'percent' : 'number_with_separators',
        propertyDefinitionId,
      },
      registration: configureNumberPropertyFormatActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
    });
    assert.equal(
      result._tag,
      role === 'Full access' || role === 'Editor'
        ? 'OperationSucceeded'
        : 'OperationAuthorizationDenied',
    );
    assert.equal(checks[0].permission, 'manage_property_definitions');
    if (result._tag === 'OperationSucceeded') {
      definitionRevision += 1;
    }
  }

  let valueRevision = 0;
  for (const [index, role] of roles.entries()) {
    const checks = [];
    // oxlint-disable-next-line no-await-in-loop -- Value revisions make this role matrix sequential.
    const result = await runAction({
      options: {
        authorizationChecker: authorizationForRole(role, checks),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        expectedRevision: valueRevision,
        propertyDefinitionId,
        taskId: task.response.task.taskId,
        value: String(index + 1),
      },
      registration: updateNumberPropertyValueActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
    });
    assert.equal(
      result._tag,
      role === 'Viewer' ? 'OperationAuthorizationDenied' : 'OperationSucceeded',
    );
    assert.equal(checks[0].permission, 'edit_task_property_values');
    if (result._tag === 'OperationSucceeded') {
      valueRevision += 1;
    }
  }

  const viewerChecks = [];
  const viewerQuery = await runDataAccess({
    options: {
      authorizationChecker: authorizationForRole('Viewer', viewerChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      propertyDefinitionId,
      query: { datatype: 'number', operation: { direction: 'ascending', type: 'sort' } },
    },
    registration: queryTaskPropertyValuesDataAccessRegistration,
    resultCount: (response) => response.taskIds.length,
    transport: { headers: new Headers() },
  });
  assert.equal(viewerQuery._tag, 'OperationSucceeded', JSON.stringify(viewerQuery));
  assert.equal(viewerChecks[0].permission, 'view_task_properties');
});

test('Number Action evidence is metadata-only and descriptors use the shared permissions', () => {
  const createInput = { collectionId: 'collection-1', mandatory: false, name: 'Revenue' };
  const definition = {
    datatype: 'number',
    format: 'percent',
    hidden: false,
    mandatory: false,
    name: 'Revenue',
    propertyDefinitionId: 'definition-1',
    revision: 2,
  };
  const updateInput = {
    collectionId: 'collection-1',
    expectedRevision: 1,
    propertyDefinitionId: 'definition-1',
    taskId: 'task-1',
    value: '123.45',
  };
  const updateResponse = {
    taskRevision: 2,
    value: { propertyDefinitionId: 'definition-1', revision: 2, value: '123.45' },
  };
  const createEvidence =
    createNumberPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(createInput, {
      definition: { ...definition, format: 'number', revision: 1 },
    });
  const updateEvidence = updateNumberPropertyValueActionRegistration.descriptor.domainEvent.payload(
    updateInput,
    updateResponse,
  );
  const formatEvidence =
    configureNumberPropertyFormatActionRegistration.descriptor.auditEvent.evidence(
      {
        collectionId: 'collection-1',
        expectedRevision: 1,
        format: 'percent',
        propertyDefinitionId: 'definition-1',
      },
      { definition },
    );

  assert.equal(
    createNumberPropertyDefinitionActionRegistration.descriptor.authorization.permission,
    'manage_property_definitions',
  );
  assert.equal(
    updateNumberPropertyValueActionRegistration.descriptor.authorization.permission,
    'edit_task_property_values',
  );
  assert.equal(
    configureNumberPropertyFormatActionRegistration.descriptor.authorization.permission,
    'manage_property_definitions',
  );
  assert.equal(
    JSON.stringify([createEvidence, updateEvidence, formatEvidence]).includes('Revenue'),
    false,
  );
  assert.equal(JSON.stringify(updateEvidence).includes('123.45'), false);
  assert.equal(Object.hasOwn(updateEvidence, 'value'), false);
});
