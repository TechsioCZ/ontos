import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createDatePropertyDefinitionActionRegistration } from '../src/actions/create-date-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateDatePropertyValueActionRegistration } from '../src/actions/update-date-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_date_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
    }),
  );
  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async (locale = 'en-GB') => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Date tenant'}, ${`date-${suffix}`}, ${locale}, ${'active'})
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
      ${'Date legal entity'},
      ${'CZ'},
      ${`date-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Date editor'}, ${'human'}, ${'active'})
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

test('a valid calendar Date travels as YYYY-MM-DD while Empty remains absence', async () => {
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
    payload: { collectionId, mandatory: false, name: 'Review date' },
    registration: createDatePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const emptyWorkspace = await readWorkspace(operationContext, collectionId);
  assert.equal(emptyWorkspace._tag, 'OperationSucceeded', JSON.stringify(emptyWorkspace));
  assert.deepEqual(emptyWorkspace.response.tasks[0].dateValues, []);

  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '2028-02-29',
    },
    registration: updateDatePropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));
  assert.equal(updated.response.value.value, '2028-02-29');

  const populatedWorkspace = await readWorkspace(operationContext, collectionId);
  assert.equal(populatedWorkspace._tag, 'OperationSucceeded');
  assert.deepEqual(populatedWorkspace.response.tasks[0].dateValues, [
    {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: '2028-02-29',
    },
  ]);
});

test('Date grouping uses the exact stored date and keeps Empty separate', async () => {
  const { groupTaskDateValuesDataAccessRegistration } =
    await import('../src/data-access/group-task-date-values.ts');
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    [0, 1, 2].map(() =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  for (const task of tasks) {
    assert.equal(task._tag, 'OperationSucceeded');
  }
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Publication date' },
    registration: createDatePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;

  const updates = await Promise.all(
    tasks.slice(0, 2).map((task) =>
      runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: 0,
          propertyDefinitionId,
          taskId: task.response.task.taskId,
          value: '2026-07-13',
        },
        registration: updateDatePropertyValueActionRegistration,
      }),
    ),
  );
  for (const updated of updates) {
    assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));
  }

  const grouped = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: groupTaskDateValuesDataAccessRegistration,
    resultCount: (response) => response.groups.length,
    transport: { headers: new Headers() },
  });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(
    grouped.response.groups.find(({ value }) => value === '2026-07-13')?.taskIds,
    tasks.slice(0, 2).map((task) => task.response.task.taskId),
  );
  assert.deepEqual(grouped.response.groups.find(({ value }) => value === null)?.taskIds, [
    tasks[2].response.task.taskId,
  ]);
});

test('Date uses generic independent duplication and confirmed deletion lifecycle', async () => {
  const { deleteTaskPropertyDefinitionActionRegistration } =
    await import('../src/actions/delete-task-property-definition.ts');
  const { duplicateTaskPropertyDefinitionActionRegistration } =
    await import('../src/actions/duplicate-task-property-definition.ts');
  const { getTaskPropertyDeletionImpactDataAccessRegistration } =
    await import('../src/data-access/get-task-property-deletion-impact.ts');
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded');
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Review date' },
    registration: createDatePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const source = definition.response.definition;
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: source.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '2027-12-03',
    },
    registration: updateDatePropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded');

  const copied = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(copied._tag, 'OperationSucceeded', JSON.stringify(copied));
  assert.equal(copied.response.definition.datatype, 'date');
  assert.equal(copied.response.definition.mandatory, true);
  assert.equal(copied.response.definition.name, 'Review date Copy');

  const blank = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(blank._tag, 'OperationSucceeded', JSON.stringify(blank));
  assert.equal(blank.response.definition.name, 'Review date Copy 2');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks[0].dateValues, [
    {
      propertyDefinitionId: source.propertyDefinitionId,
      revision: 1,
      value: '2027-12-03',
    },
    {
      propertyDefinitionId: copied.response.definition.propertyDefinitionId,
      revision: 1,
      value: '2027-12-03',
    },
  ]);

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId: source.propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded');
  assert.equal(impact.response.impactCount, 1);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 1,
      expectedRevision: source.revision,
      propertyDefinitionId: source.propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const afterDeletion = await readWorkspace(operationContext, collectionId);
  assert.equal(afterDeletion._tag, 'OperationSucceeded');
  assert.equal(
    afterDeletion.response.propertyDefinitions.some(
      ({ propertyDefinitionId }) => propertyDefinitionId === source.propertyDefinitionId,
    ),
    false,
  );
});

test('invalid and stale Date writes preserve the committed value while clear makes it Empty', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded');
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Review date' },
    registration: createDatePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, expectedRevision, propertyDefinitionId, taskId, value },
      registration: updateDatePropertyValueActionRegistration,
    });

  const accepted = await update(0, '2026-07-13');
  assert.equal(accepted._tag, 'OperationSucceeded');

  const invalid = await update(1, '2027-02-29');
  assert.equal(invalid._tag, 'OperationDomainRejected');
  assert.equal(invalid.code, 'ticketing.updateDatePropertyValue.invalid_date');
  const stale = await update(0, '2026-08-20');
  assert.equal(stale._tag, 'OperationDomainRejected');
  assert.equal(stale.code, 'ticketing.updateDatePropertyValue.stale_or_missing');

  const unchanged = await readWorkspace(operationContext, collectionId);
  assert.equal(unchanged._tag, 'OperationSucceeded');
  assert.deepEqual(unchanged.response.tasks[0].dateValues, [
    { propertyDefinitionId, revision: 1, value: '2026-07-13' },
  ]);
  assert.equal(unchanged.response.tasks[0].taskRevision, 2);

  const cleared = await update(1, null);
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.deepEqual(cleared.response, { taskRevision: 3, value: null });
  const empty = await readWorkspace(operationContext, collectionId);
  assert.equal(empty._tag, 'OperationSucceeded');
  assert.deepEqual(empty.response.tasks[0].dateValues, []);
});

test('Date actions enforce schema/value roles and expose no raw value in evidence', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded');

  const userCreate = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, mandatory: false, name: 'User date' },
    registration: createDatePropertyDefinitionActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(userCreate._tag, 'OperationAuthorizationDenied');

  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Review date' },
    registration: createDatePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const input = {
    collectionId,
    expectedRevision: 0,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
    value: '2026-07-13',
  };

  const viewerUpdate = await runAction({
    options: {
      authorizationChecker: authorizationForRole('Viewer'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: input,
    registration: updateDatePropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(viewerUpdate._tag, 'OperationAuthorizationDenied');
  const userUpdate = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: input,
    registration: updateDatePropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(userUpdate._tag, 'OperationSucceeded', JSON.stringify(userUpdate));

  const evidence = updateDatePropertyValueActionRegistration.descriptor.auditEvent.evidence(
    input,
    userUpdate.response,
  );
  assert.equal(Object.hasOwn(evidence, 'value'), false);
  assert.equal(JSON.stringify(evidence).includes('2026-07-13'), false);
});
