import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createEmailPropertyDefinitionActionRegistration } from '../src/actions/create-email-property-definition.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateEmailPropertyValueActionRegistration } from '../src/actions/update-email-property-value.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { queryTaskEmailValuesDataAccessRegistration } from '../src/data-access/query-task-email-values.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_email_values where tenant_id = ${tenantId}`;
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

const createOperationIdentity = async (defaultLocale = 'en-GB') => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Email property tenant'}, ${`email-property-${suffix}`}, ${defaultLocale}, ${'active'})
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
      ${'Email property legal entity'},
      ${'CZ'},
      ${`email-property-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Email property editor'}, ${'human'}, ${'active'})
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

const queryEmailValues = (operationContext, payload) =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration: queryTaskEmailValuesDataAccessRegistration,
    resultCount: (response) => response.taskIds.length,
    transport: { headers: new Headers() },
  });

test('a valid Email is trimmed, case-preserved, and readable through the public workspace', async () => {
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
    payload: { collectionId, mandatory: false, name: 'Contact email' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const saved = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '  Customer+Tag@XN--EXAMPLE-OVA.COM  ',
    },
    registration: updateEmailPropertyValueActionRegistration,
  });

  assert.equal(saved._tag, 'OperationSucceeded', JSON.stringify(saved));
  assert.deepEqual(saved.response.value, {
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
    value: 'Customer+Tag@XN--EXAMPLE-OVA.COM',
  });
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].emailValues, [saved.response.value]);
});

test('Email search matches a case-insensitive literal substring through the public query contract', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    Array.from({ length: 4 }, () =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  assert.equal(
    tasks.every(({ _tag }) => _tag === 'OperationSucceeded'),
    true,
  );
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Contact email' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  for (const [index, value] of [
    'Customer@Example.com',
    'customer@example.com',
    'supplier@another.test',
  ].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Seed revisions are independent and deterministic.
    const saved = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        propertyDefinitionId,
        taskId: tasks[index].response.task.taskId,
        value,
      },
      registration: updateEmailPropertyValueActionRegistration,
    });
    assert.equal(saved._tag, 'OperationSucceeded');
  }

  const result = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'search',
    propertyDefinitionId,
    query: 'CUSTOMER@EXAMPLE',
  });

  assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  assert.deepEqual(
    result.response.taskIds,
    [tasks[0].response.task.taskId, tasks[1].response.task.taskId].toSorted(),
  );

  const negative = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'does_not_contain',
    propertyDefinitionId,
    query: 'example.com',
  });
  assert.equal(negative._tag, 'OperationSucceeded', JSON.stringify(negative));
  assert.deepEqual(
    negative.response.taskIds,
    [tasks[2].response.task.taskId, tasks[3].response.task.taskId].toSorted(),
  );

  const exact = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'is',
    propertyDefinitionId,
    query: 'CUSTOMER@EXAMPLE.COM',
  });
  assert.equal(exact._tag, 'OperationSucceeded');
  assert.deepEqual(
    exact.response.taskIds,
    [tasks[0].response.task.taskId, tasks[1].response.task.taskId].toSorted(),
  );

  const notExact = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'is_not',
    propertyDefinitionId,
    query: 'supplier@another.test',
  });
  assert.equal(notExact._tag, 'OperationSucceeded');
  assert.deepEqual(
    notExact.response.taskIds,
    [
      tasks[0].response.task.taskId,
      tasks[1].response.task.taskId,
      tasks[3].response.task.taskId,
    ].toSorted(),
  );

  const empty = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'is_empty',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(empty._tag, 'OperationSucceeded');
  assert.deepEqual(empty.response.taskIds, [tasks[3].response.task.taskId]);

  const ascending = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'sort_ascending',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(ascending._tag, 'OperationSucceeded');
  const customerTaskIds = [tasks[0].response.task.taskId, tasks[1].response.task.taskId].toSorted();
  assert.deepEqual(ascending.response.taskIds, [
    ...customerTaskIds,
    tasks[2].response.task.taskId,
    tasks[3].response.task.taskId,
  ]);

  const descending = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'sort_descending',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(descending._tag, 'OperationSucceeded');
  assert.deepEqual(descending.response.taskIds, [
    tasks[2].response.task.taskId,
    ...customerTaskIds,
    tasks[3].response.task.taskId,
  ]);

  const grouped = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'group',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(grouped._tag, 'OperationSucceeded');
  const [lowestCustomerTaskId] = customerTaskIds;
  assert.deepEqual(grouped.response.groups, [
    {
      key: 'customer@example.com',
      label:
        lowestCustomerTaskId === tasks[0].response.task.taskId
          ? 'Customer@Example.com'
          : 'customer@example.com',
      taskIds: customerTaskIds,
    },
    {
      key: 'supplier@another.test',
      label: 'supplier@another.test',
      taskIds: [tasks[2].response.task.taskId],
    },
    { key: null, label: null, taskIds: [tasks[3].response.task.taskId] },
  ]);
});

test('Email sorting and grouping use the Task Collection locale', async () => {
  const operationContext = await createOperationIdentity('cs-CZ');
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    Array.from({ length: 3 }, () =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Czech order' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  for (const [index, value] of ['h@example.com', 'ch@example.com', 'i@example.com'].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Public writes establish deterministic rows.
    const saved = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        propertyDefinitionId,
        taskId: tasks[index].response.task.taskId,
        value,
      },
      registration: updateEmailPropertyValueActionRegistration,
    });
    assert.equal(saved._tag, 'OperationSucceeded');
  }

  const sorted = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'sort_ascending',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(sorted._tag, 'OperationSucceeded');
  assert.deepEqual(
    sorted.response.taskIds,
    tasks.map(({ response }) => response.task.taskId),
  );
  const grouped = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'group',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(grouped._tag, 'OperationSucceeded');
  assert.deepEqual(
    grouped.response.groups.map(({ key }) => key),
    ['h@example.com', 'ch@example.com', 'i@example.com'],
  );
});

test('Email edits reject invalid, Mandatory-empty, and stale drafts without replacing committed state', async () => {
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
    payload: { collectionId, mandatory: false, name: 'Contact email' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, expectedRevision, propertyDefinitionId, taskId, value },
      registration: updateEmailPropertyValueActionRegistration,
    });

  const initial = await update(0, 'valid@example.com');
  assert.equal(initial._tag, 'OperationSucceeded');
  const invalid = await update(1, 'first@example.com,second@example.com');
  assert.equal(invalid._tag, 'OperationDomainRejected');
  assert.equal(invalid.code, 'ticketing.updateEmailPropertyValue.invalid_email');

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: false,
      mandatory: true,
      name: 'Contact email',
      propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded');
  const mandatoryClear = await update(1, '   ');
  assert.equal(mandatoryClear._tag, 'OperationDomainRejected');
  assert.equal(mandatoryClear.code, 'ticketing.updateEmailPropertyValue.mandatory');

  const changed = await update(1, 'new@example.com');
  assert.equal(changed._tag, 'OperationSucceeded');
  const stale = await update(1, 'stale@example.com');
  assert.equal(stale._tag, 'OperationDomainRejected');
  assert.equal(stale.code, 'ticketing.updateEmailPropertyValue.stale_or_missing');
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks[0].emailValues, [
    { propertyDefinitionId, revision: 2, value: 'new@example.com' },
  ]);

  const evidence = updateEmailPropertyValueActionRegistration.descriptor.auditEvent.evidence(
    {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId,
      taskId,
      value: 'secret@example.com',
    },
    changed.response,
  );
  assert.equal(Object.hasOwn(evidence, 'value'), false);
  assert.equal(JSON.stringify(evidence).includes('secret@example.com'), false);

  const optionalAgain = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      hidden: false,
      mandatory: false,
      name: 'Contact email',
      propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(optionalAgain._tag, 'OperationSucceeded');
  const cleared = await update(2, '   ');
  assert.equal(cleared._tag, 'OperationSucceeded');
  assert.deepEqual(cleared.response.value, {
    propertyDefinitionId,
    revision: 3,
    value: null,
  });
  const afterClear = await readWorkspace(operationContext, collectionId);
  assert.equal(afterClear._tag, 'OperationSucceeded');
  assert.deepEqual(afterClear.response.tasks[0].emailValues, [cleared.response.value]);
  const emptyAfterClear = await queryEmailValues(operationContext, {
    collectionId,
    operation: 'is_empty',
    propertyDefinitionId,
    query: '',
  });
  assert.equal(emptyAfterClear._tag, 'OperationSucceeded');
  assert.deepEqual(emptyAfterClear.response.taskIds, [taskId]);
  const impactAfterClear = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impactAfterClear._tag, 'OperationSucceeded');
  assert.equal(impactAfterClear.response.impactCount, 0);

  const repopulated = await update(3, 'again@example.com');
  assert.equal(repopulated._tag, 'OperationSucceeded');
  assert.equal(repopulated.response.value.revision, 4);
  const abaStale = await update(1, 'old-client@example.com');
  assert.equal(abaStale._tag, 'OperationDomainRejected');
  assert.equal(abaStale.code, 'ticketing.updateEmailPropertyValue.stale_or_missing');
});

test('an unrelated Task value save is rejected while a Mandatory Email remains Empty', async () => {
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
  const mandatoryEmail = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Required contact' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  const checkbox = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Reviewed' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded');
  assert.equal(mandatoryEmail._tag, 'OperationSucceeded');
  assert.equal(checkbox._tag, 'OperationSucceeded');

  const unrelatedSave = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: checkbox.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(unrelatedSave._tag, 'OperationDomainRejected');
  assert.equal(unrelatedSave.code, 'ticketing.taskEdit.mandatory_email_empty');
});

test('Email duplication and confirmed deletion preserve generic retained-Task lifecycle semantics', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const tasks = await Promise.all(
    Array.from({ length: 2 }, () =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId },
        registration: createTaskActionRegistration,
      }),
    ),
  );
  assert.equal(
    tasks.every(({ _tag }) => _tag === 'OperationSucceeded'),
    true,
  );
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Contact email' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  for (const [index, value] of ['archive@example.com', 'deleted@example.com'].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Seed each Task through the public Action seam.
    const saved = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        propertyDefinitionId,
        taskId: tasks[index].response.task.taskId,
        value,
      },
      registration: updateEmailPropertyValueActionRegistration,
    });
    assert.equal(saved._tag, 'OperationSucceeded');
  }
  const archived = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      taskId: tasks[0].response.task.taskId,
      transition: 'archive',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(archived._tag, 'OperationSucceeded');
  const softDeleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      taskId: tasks[1].response.task.taskId,
      transition: 'softDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(softDeleted._tag, 'OperationSucceeded');

  const copied = await runRegisteredAction({
    operationContext,
    payload: { collectionId, copyValues: true, expectedRevision: 1, propertyDefinitionId },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(copied._tag, 'OperationSucceeded', JSON.stringify(copied));
  assert.equal(copied.response.definition.name, 'Contact email Copy');
  const blank = await runRegisteredAction({
    operationContext,
    payload: { collectionId, copyValues: false, expectedRevision: 1, propertyDefinitionId },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(blank._tag, 'OperationSucceeded');
  assert.equal(blank.response.definition.name, 'Contact email Copy 2');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  for (const task of workspace.response.tasks) {
    assert.equal(task.emailValues.length, 2);
    assert.equal(
      task.emailValues.some(
        ({ propertyDefinitionId: candidate }) =>
          candidate === copied.response.definition.propertyDefinitionId,
      ),
      true,
    );
    assert.equal(
      task.emailValues.some(
        ({ propertyDefinitionId: candidate }) =>
          candidate === blank.response.definition.propertyDefinitionId,
      ),
      false,
    );
  }

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded');
  assert.equal(impact.response.impactCount, 2);
  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 2,
      expectedRevision: 1,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const afterDelete = await readWorkspace(operationContext, collectionId);
  assert.equal(afterDelete._tag, 'OperationSucceeded');
  assert.equal(
    afterDelete.response.propertyDefinitions.some(
      ({ propertyDefinitionId: candidate }) => candidate === propertyDefinitionId,
    ),
    false,
  );
  assert.equal(
    afterDelete.response.tasks.every((task) =>
      task.emailValues.every(
        ({ propertyDefinitionId: candidate }) => candidate !== propertyDefinitionId,
      ),
    ),
    true,
  );
});
