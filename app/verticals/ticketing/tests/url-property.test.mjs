import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { createUrlPropertyDefinitionActionRegistration } from '../src/actions/create-url-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateUrlPropertyValueActionRegistration } from '../src/actions/update-url-property-value.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { queryTaskUrlValuesDataAccessRegistration } from '../src/data-access/query-task-url-values.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.domain_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.audit_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_url_values where tenant_id = ${tenantId}`;
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
    values (${'URL property tenant'}, ${`url-property-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'URL property legal entity'},
      ${'CZ'},
      ${`url-property-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'URL property editor'}, ${'human'}, ${'active'})
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

const runRegisteredAction = ({ operationContext, payload, registration }) =>
  runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });

const createUrlWorkspace = async (operationContext) => {
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
    payload: { collectionId, mandatory: false, name: 'Reference URL' },
    registration: createUrlPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition: definition.response.definition, task: task.response.task };
};

const readWorkspace = (operationContext, collectionId) =>
  runDataAccess({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });

test('a URL Action preserves the exact trimmed HTTP(S) string through the public workspace read', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createUrlWorkspace(operationContext);

  const changed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: task.taskId,
      value: '  https://Example.com/Path?Q=One#Part  ',
    },
    registration: updateUrlPropertyValueActionRegistration,
  });

  assert.equal(changed._tag, 'OperationSucceeded', JSON.stringify(changed));
  assert.deepEqual(changed.response.value, {
    propertyDefinitionId: definition.propertyDefinitionId,
    revision: 1,
    value: 'https://Example.com/Path?Q=One#Part',
  });

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].urlValues, [changed.response.value]);
});

test('the public URL Action durably accepts the complete 8000-byte boundary', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createUrlWorkspace(operationContext);
  const prefix = 'https://example.com/';
  const value = `${prefix}${randomBytes(5985).toString('base64url')}`;
  assert.equal(Buffer.byteLength(value), 8000);
  const changed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: task.taskId,
      value,
    },
    registration: updateUrlPropertyValueActionRegistration,
  });
  assert.equal(changed._tag, 'OperationSucceeded', JSON.stringify(changed));
  assert.equal(changed.response.value.value, value);
});

test('invalid and unchanged URL edits preserve the committed value and revisions', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createUrlWorkspace(operationContext);
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision,
        propertyDefinitionId: definition.propertyDefinitionId,
        taskId: task.taskId,
        value,
      },
      registration: updateUrlPropertyValueActionRegistration,
    });

  const accepted = await update(0, 'https://example.com/%7EExact');
  assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));
  const noOp = await update(1, '  https://example.com/%7EExact  ');
  assert.equal(noOp._tag, 'OperationSucceeded', JSON.stringify(noOp));
  assert.equal(
    noOp.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );
  const invalid = await update(1, 'https://user:secret@example.com/private');
  assert.equal(invalid._tag, 'OperationDomainRejected', JSON.stringify(invalid));
  assert.equal(invalid.code, 'ticketing.updateUrlPropertyValue.invalid_url');
  const stale = await update(0, 'https://example.com/stale');
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updateUrlPropertyValue.stale_or_missing');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
  assert.deepEqual(workspace.response.tasks[0].urlValues, [accepted.response.value]);
});

test('outer-whitespace-only input clears a URL once and repeated clear is a no-op', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createUrlWorkspace(operationContext);
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision,
        propertyDefinitionId: definition.propertyDefinitionId,
        taskId: task.taskId,
        value,
      },
      registration: updateUrlPropertyValueActionRegistration,
    });
  const set = await update(0, 'https://example.com/value');
  assert.equal(set._tag, 'OperationSucceeded', JSON.stringify(set));
  const cleared = await update(1, ' \t\n ');
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.deepEqual(cleared.response, {
    taskRevision: 3,
    value: {
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: 2,
      value: null,
    },
  });
  const noOp = await update(2, '');
  assert.equal(noOp._tag, 'OperationSucceeded', JSON.stringify(noOp));
  assert.deepEqual(noOp.response, cleared.response);
  assert.equal(
    noOp.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );
});

test('URL Action descriptors target collection roles and never expose the raw URL in evidence', () => {
  const createDescriptor = createUrlPropertyDefinitionActionRegistration.descriptor;
  const updateDescriptor = updateUrlPropertyValueActionRegistration.descriptor;
  assert.equal(createDescriptor.authorization.permission, 'manage_property_definitions');
  assert.equal(updateDescriptor.authorization.permission, 'edit_task_property_values');
  assert.equal(
    createDescriptor.authorization.resourceObjectId({ collectionId: 'collection-1' }),
    'collection-1',
  );
  assert.equal(
    updateDescriptor.authorization.resourceObjectId({
      collectionId: 'collection-1',
      expectedRevision: 0,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: 'https://secret.example/path',
    }),
    'collection-1',
  );

  const input = {
    collectionId: 'collection-1',
    expectedRevision: 0,
    propertyDefinitionId: 'property-1',
    taskId: 'task-1',
    value: 'https://secret.example/path',
  };
  const response = {
    taskRevision: 2,
    value: {
      propertyDefinitionId: 'property-1',
      revision: 1,
      value: 'https://secret.example/path',
    },
  };
  const auditEvidence = updateDescriptor.auditEvent.evidence(input, response);
  const domainPayload = updateDescriptor.domainEvent.payload(input, response);
  assert.equal(JSON.stringify(auditEvidence).includes(input.value), false);
  assert.equal(JSON.stringify(domainPayload).includes(input.value), false);
  assert.deepEqual(auditEvidence, domainPayload);
});

test('URL query operations share locale-aware exact-string semantics and keep Empty last', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task: firstTask } = await createUrlWorkspace(operationContext);
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created.response.task;
  };
  const secondTask = await createTask();
  const thirdTask = await createTask();
  const emptyTask = await createTask();
  const setUrl = async (taskId, value) => {
    const changed = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        propertyDefinitionId: definition.propertyDefinitionId,
        taskId,
        value,
      },
      registration: updateUrlPropertyValueActionRegistration,
    });
    assert.equal(changed._tag, 'OperationSucceeded', JSON.stringify(changed));
  };
  await setUrl(firstTask.taskId, 'https://Example.com/Caf\u00E9');
  await setUrl(secondTask.taskId, 'https://example.com/Cafe\u0301');
  await setUrl(thirdTask.taskId, 'https://z.example/path');

  const query = (operation) =>
    runDataAccess({
      options: {
        authorizationChecker: () => ({ _tag: 'Allowed' }),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        operation,
        propertyDefinitionId: definition.propertyDefinitionId,
      },
      registration: queryTaskUrlValuesDataAccessRegistration,
      resultCount: (response) =>
        response.taskIds.length +
        response.groups.reduce((count, group) => count + group.taskIds.length, 0),
      transport: { headers: new Headers() },
    });

  const search = await query({ kind: 'search', query: 'CAF\u00C9' });
  assert.equal(search._tag, 'OperationSucceeded', JSON.stringify(search));
  assert.deepEqual(
    new Set(search.response.taskIds),
    new Set([firstTask.taskId, secondTask.taskId]),
  );

  const negative = await query({
    kind: 'filter',
    operator: 'does_not_contain',
    query: 'caf\u00E9',
  });
  assert.equal(negative._tag, 'OperationSucceeded', JSON.stringify(negative));
  assert.deepEqual(
    new Set(negative.response.taskIds),
    new Set([thirdTask.taskId, emptyTask.taskId]),
  );
  const contains = await query({ kind: 'filter', operator: 'contains', query: 'CAF\u00C9' });
  assert.equal(contains._tag, 'OperationSucceeded', JSON.stringify(contains));
  assert.deepEqual(
    new Set(contains.response.taskIds),
    new Set([firstTask.taskId, secondTask.taskId]),
  );
  const empty = await query({ kind: 'filter', operator: 'is_empty' });
  assert.equal(empty._tag, 'OperationSucceeded', JSON.stringify(empty));
  assert.deepEqual(empty.response.taskIds, [emptyTask.taskId]);
  const present = await query({ kind: 'filter', operator: 'is_not_empty' });
  assert.equal(present._tag, 'OperationSucceeded', JSON.stringify(present));
  assert.deepEqual(
    new Set(present.response.taskIds),
    new Set([firstTask.taskId, secondTask.taskId, thirdTask.taskId]),
  );

  const equivalentIds = [firstTask.taskId, secondTask.taskId].toSorted();
  const sorted = await query({ direction: 'ascending', kind: 'sort' });
  assert.equal(sorted._tag, 'OperationSucceeded', JSON.stringify(sorted));
  assert.deepEqual(sorted.response.taskIds, [...equivalentIds, thirdTask.taskId, emptyTask.taskId]);
  const descending = await query({ direction: 'descending', kind: 'sort' });
  assert.equal(descending._tag, 'OperationSucceeded', JSON.stringify(descending));
  assert.deepEqual(descending.response.taskIds, [
    thirdTask.taskId,
    ...equivalentIds,
    emptyTask.taskId,
  ]);

  const grouped = await query({ kind: 'group' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  const expectedHeading =
    equivalentIds[0] === firstTask.taskId
      ? 'https://Example.com/Caf\u00E9'
      : 'https://example.com/Cafe\u0301';
  assert.deepEqual(grouped.response.groups, [
    { heading: expectedHeading, taskIds: equivalentIds },
    { heading: 'https://z.example/path', taskIds: [thirdTask.taskId] },
    { heading: null, taskIds: [emptyTask.taskId] },
  ]);
});

test('URL definition duplication and deletion impact use independent values without editing Tasks', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createUrlWorkspace(operationContext);
  const secondTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(secondTask._tag, 'OperationSucceeded', JSON.stringify(secondTask));
  const changed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.propertyDefinitionId,
      taskId: task.taskId,
      value: 'https://example.com/source',
    },
    registration: updateUrlPropertyValueActionRegistration,
  });
  assert.equal(changed._tag, 'OperationSucceeded', JSON.stringify(changed));

  const impact = await runDataAccess({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId: definition.propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 1);

  const duplicate = (copyValues) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        copyValues,
        expectedRevision: 1,
        propertyDefinitionId: definition.propertyDefinitionId,
      },
      registration: duplicateTaskPropertyDefinitionActionRegistration,
    });
  const copied = await duplicate(true);
  const blank = await duplicate(false);
  assert.equal(copied._tag, 'OperationSucceeded', JSON.stringify(copied));
  assert.equal(blank._tag, 'OperationSucceeded', JSON.stringify(blank));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const first = workspace.response.tasks.find(({ taskId }) => taskId === task.taskId);
  const second = workspace.response.tasks.find(
    ({ taskId }) => taskId === secondTask.response.task.taskId,
  );
  assert.equal(first.taskRevision, 2);
  assert.equal(second.taskRevision, 1);
  const firstValues = new Map(
    first.urlValues.map(({ propertyDefinitionId, value }) => [propertyDefinitionId, value]),
  );
  assert.equal(firstValues.get(definition.propertyDefinitionId), 'https://example.com/source');
  assert.equal(
    firstValues.get(copied.response.definition.propertyDefinitionId),
    'https://example.com/source',
  );
  assert.equal(firstValues.get(blank.response.definition.propertyDefinitionId), null);
  assert.deepEqual(
    second.urlValues.map(({ value }) => value),
    [null, null, null],
  );
});
