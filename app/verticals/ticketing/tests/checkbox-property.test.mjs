import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { on } from 'node:events';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateCheckboxPropertyValueActionRegistration as updateCheckboxPropertyValueDescriptorRegistration } from '../src/actions/update-checkbox-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { getTaskPropertyEditCapabilityDataAccessRegistration } from '../src/data-access/get-task-property-edit-capability.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
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
    values (${'Checkbox tenant'}, ${`checkbox-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Checkbox legal entity'},
      ${'CZ'},
      ${`checkbox-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;

  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Checkbox editor'}, ${'human'}, ${'active'})
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

const createCollectionAndTask = async (operationContext) => {
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
  return { collection, collectionId, task };
};

const createCheckboxDefinition = (operationContext, collectionId, name) =>
  runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name },
    registration: createCheckboxPropertyDefinitionActionRegistration,
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

const waitForChildMessage = async (child, expectedType) => {
  for await (const [message] of on(child, 'message')) {
    if (message?.type === 'error') {
      throw new Error(message.error);
    }
    if (message?.type === expectedType) {
      return message;
    }
  }
  throw new Error(`Concurrent Action child exited before sending ${expectedType}.`);
};

const readConcurrentActionResult = async (child) => {
  const message = await waitForChildMessage(child, 'result');
  return message.result;
};

const startConcurrentAction = ({ kind, operationContext, payload }) => {
  const child = fork(new URL('fixtures/concurrent-checkbox-action.mjs', import.meta.url), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ready = waitForChildMessage(child, 'ready');
  const result = readConcurrentActionResult(child);
  child.send({ kind, operationContext, payload, type: 'run' });
  return {
    ready,
    release: () => child.send({ type: 'release' }),
    result,
  };
};

test('an Editor creates a Checkbox definition and an existing Task reads false', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const authorizationChecks = [];
  const definition = await runAction({
    options: {
      authorizationChecker: (check) => {
        authorizationChecks.push(check);
        return { _tag: 'Allowed' };
      },
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, mandatory: false, name: 'Approved' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });

  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  assert.deepEqual(definition.response.definition, {
    datatype: 'checkbox',
    hidden: false,
    mandatory: false,
    name: 'Approved',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
  });
  assert.equal(authorizationChecks.length, 1);
  assert.equal(authorizationChecks[0].permission, 'manage_property_definitions');

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });

  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, [
    {
      datatype: 'checkbox',
      hidden: false,
      mandatory: false,
      name: 'Approved',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
    },
  ]);
  assert.deepEqual(workspace.response.tasks, [
    {
      checkboxValues: [
        {
          propertyDefinitionId: definition.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
      ],
      emailValues: [],
      taskId: task.response.task.taskId,
      taskRevision: 1,
      title: '',
    },
  ]);

  const newTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(newTask._tag, 'OperationSucceeded');
  const withNewTask = await readWorkspace(operationContext, collectionId);
  assert.equal(withNewTask._tag, 'OperationSucceeded');
  assert.deepEqual(
    withNewTask.response.tasks.map(({ checkboxValues }) => checkboxValues[0].value),
    [false, false],
  );
});

test('concurrent Task and Checkbox definition creation still resolves the value to false', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded');
  const { collectionId } = collection.response.collection;
  const taskAction = startConcurrentAction({
    kind: 'task',
    operationContext,
    payload: { collectionId },
  });
  const definitionAction = startConcurrentAction({
    kind: 'definition',
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Concurrent' },
  });
  await Promise.all([taskAction.ready, definitionAction.ready]);
  taskAction.release();
  definitionAction.release();
  const [task, definition] = await Promise.all([taskAction.result, definitionAction.result]);

  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks, [
    {
      checkboxValues: [
        {
          propertyDefinitionId: definition.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
      ],
      emailValues: [],
      taskId: task.response.task.taskId,
      taskRevision: 1,
      title: '',
    },
  ]);
});

test('a User toggles one Checkbox without changing another Task, property, or Title', async () => {
  const { updateCheckboxPropertyValueActionRegistration } =
    await import('../src/actions/update-checkbox-property-value.ts');
  const operationContext = await createOperationIdentity();
  const { collectionId, task: firstTask } = await createCollectionAndTask(operationContext);
  const secondTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(secondTask._tag, 'OperationSucceeded');
  const approved = await createCheckboxDefinition(operationContext, collectionId, 'Approved');
  const invoiced = await createCheckboxDefinition(operationContext, collectionId, 'Invoiced');
  assert.equal(approved._tag, 'OperationSucceeded');
  assert.equal(invoiced._tag, 'OperationSucceeded');

  const before = await readWorkspace(operationContext, collectionId);
  assert.equal(before._tag, 'OperationSucceeded');
  const firstBefore = before.response.tasks.find(
    ({ taskId }) => taskId === firstTask.response.task.taskId,
  );
  assert.equal(firstBefore.title, '');
  assert.equal(firstBefore.taskRevision, 1);

  const authorizationChecks = [];
  const toggled = await runAction({
    options: {
      authorizationChecker: (check) => {
        authorizationChecks.push(check);
        return { _tag: 'Allowed' };
      },
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: approved.response.definition.propertyDefinitionId,
      taskId: firstTask.response.task.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });

  assert.equal(toggled._tag, 'OperationSucceeded', JSON.stringify(toggled));
  assert.equal(authorizationChecks[0].permission, 'edit_task_property_values');
  assert.deepEqual(toggled.response, {
    taskRevision: 2,
    value: {
      propertyDefinitionId: approved.response.definition.propertyDefinitionId,
      revision: 2,
      value: true,
    },
  });

  const afterWorkspace = await readWorkspace(operationContext, collectionId);
  assert.equal(afterWorkspace._tag, 'OperationSucceeded');
  const firstAfter = afterWorkspace.response.tasks.find(
    ({ taskId }) => taskId === firstTask.response.task.taskId,
  );
  const secondAfter = afterWorkspace.response.tasks.find(
    ({ taskId }) => taskId === secondTask.response.task.taskId,
  );
  assert.equal(firstAfter.title, '');
  assert.equal(firstAfter.taskRevision, 2);
  assert.deepEqual(firstAfter.checkboxValues, [
    {
      propertyDefinitionId: approved.response.definition.propertyDefinitionId,
      revision: 2,
      value: true,
    },
    {
      propertyDefinitionId: invoiced.response.definition.propertyDefinitionId,
      revision: 1,
      value: false,
    },
  ]);
  assert.equal(secondAfter.title, '');
  assert.equal(secondAfter.taskRevision, 1);
  assert.deepEqual(
    secondAfter.checkboxValues.map(({ value }) => value),
    [false, false],
  );
});

test('a stale toggle is rejected while the committed state remains intact', async () => {
  const { updateCheckboxPropertyValueActionRegistration } =
    await import('../src/actions/update-checkbox-property-value.ts');
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await createCheckboxDefinition(operationContext, collectionId, 'Approved');
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision,
        propertyDefinitionId,
        taskId,
        value,
      },
      registration: updateCheckboxPropertyValueActionRegistration,
    });

  const accepted = await update(1, true);
  assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));
  const stale = await update(1, false);
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updateCheckboxPropertyValue.stale_or_missing');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.deepEqual(workspace.response.tasks[0].checkboxValues, [
    { propertyDefinitionId, revision: 2, value: true },
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
});

test('Checkbox Action descriptors expose privacy-safe audit and domain metadata', () => {
  const createInput = {
    collectionId: 'collection-1',
    mandatory: false,
    name: 'Approved',
  };
  const createResponse = {
    definition: {
      datatype: 'checkbox',
      hidden: false,
      mandatory: false,
      name: 'Approved',
      propertyDefinitionId: 'definition-1',
      revision: 1,
    },
  };
  const createAudit = createCheckboxPropertyDefinitionActionRegistration.descriptor.auditEvent;
  const createDomain = createCheckboxPropertyDefinitionActionRegistration.descriptor.domainEvent;
  assert.equal(createAudit.targetResourceId(createInput, createResponse), 'definition-1');
  assert.equal(createAudit.targetResourceType, 'task_property_definition');
  assert.deepEqual(createAudit.evidence(createInput, createResponse), {
    changedComponents: ['definition'],
    collectionId: 'collection-1',
    datatype: 'checkbox',
    operation: 'created',
    propertyDefinitionId: 'definition-1',
    revision: 1,
  });
  assert.deepEqual(createDomain.payload(createInput, createResponse), {
    changedComponents: ['definition'],
    collectionId: 'collection-1',
    datatype: 'checkbox',
    operation: 'created',
    propertyDefinitionId: 'definition-1',
    revision: 1,
  });

  const updateInput = {
    collectionId: 'collection-1',
    expectedRevision: 1,
    propertyDefinitionId: 'definition-1',
    taskId: 'task-1',
    value: true,
  };
  const updateResponse = {
    taskRevision: 2,
    value: {
      propertyDefinitionId: 'definition-1',
      revision: 2,
      value: true,
    },
  };
  const updateAudit = updateCheckboxPropertyValueDescriptorRegistration.descriptor.auditEvent;
  const updateDomain = updateCheckboxPropertyValueDescriptorRegistration.descriptor.domainEvent;
  const expectedUpdateEvidence = {
    changedComponents: ['checkboxValue'],
    collectionId: 'collection-1',
    datatype: 'checkbox',
    operation: 'changed',
    propertyDefinitionId: 'definition-1',
    revision: 2,
    taskId: 'task-1',
    taskRevision: 2,
  };
  assert.equal(updateAudit.targetResourceId(updateInput, updateResponse), 'task-1');
  assert.equal(updateAudit.targetResourceType, 'task');
  assert.deepEqual(updateAudit.evidence(updateInput, updateResponse), expectedUpdateEvidence);
  assert.deepEqual(updateDomain.payload(updateInput, updateResponse), expectedUpdateEvidence);
  assert.equal(Object.hasOwn(expectedUpdateEvidence, 'value'), false);
});

test('submitting the committed Checkbox value is a semantic no-op', async () => {
  const { updateCheckboxPropertyValueActionRegistration } =
    await import('../src/actions/update-checkbox-property-value.ts');
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await createCheckboxDefinition(operationContext, collectionId, 'Approved');
  assert.equal(definition._tag, 'OperationSucceeded');

  const noOp = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: false,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });

  assert.equal(noOp._tag, 'OperationSucceeded', JSON.stringify(noOp));
  assert.equal(
    noOp.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );
  assert.deepEqual(noOp.response, {
    taskRevision: 1,
    value: {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: false,
    },
  });
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  assert.equal(workspace.response.tasks[0].taskRevision, 1);
  assert.deepEqual(workspace.response.tasks[0].checkboxValues, [
    {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 1,
      value: false,
    },
  ]);
});

test('checked and unchecked filters return the current values including default false', async () => {
  const { updateCheckboxPropertyValueActionRegistration } =
    await import('../src/actions/update-checkbox-property-value.ts');
  const { filterTaskCheckboxValuesDataAccessRegistration } =
    await import('../src/data-access/filter-task-checkbox-values.ts');
  const operationContext = await createOperationIdentity();
  const { collectionId, task: checkedTask } = await createCollectionAndTask(operationContext);
  const uncheckedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(uncheckedTask._tag, 'OperationSucceeded');
  const definition = await createCheckboxDefinition(operationContext, collectionId, 'Approved');
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;

  const toggled = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId,
      taskId: checkedTask.response.task.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(toggled._tag, 'OperationSucceeded');

  const filter = (value) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId, propertyDefinitionId, value },
      registration: filterTaskCheckboxValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
  const checked = await filter(true);
  const unchecked = await filter(false);

  assert.equal(checked._tag, 'OperationSucceeded');
  assert.deepEqual(checked.response.taskIds, [checkedTask.response.task.taskId]);
  assert.equal(unchecked._tag, 'OperationSucceeded');
  assert.deepEqual(unchecked.response.taskIds, [uncheckedTask.response.task.taskId]);
});

test('collection roles separate schema management, value editing, and read access', async () => {
  const { updateCheckboxPropertyValueActionRegistration } =
    await import('../src/actions/update-checkbox-property-value.ts');
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const seed = await createCheckboxDefinition(operationContext, collectionId, 'Seed');
  assert.equal(seed._tag, 'OperationSucceeded');
  const resourceObjectId = `${operationContext.tenantId}_${collectionId}`;

  const schemaRoleResults = await Promise.all(
    ['Full access', 'Editor', 'User', 'Viewer'].map(async (role) => {
      const checks = [];
      const result = await runAction({
        options: {
          authorizationChecker: authorizationForRole(role, checks),
          operationContextResolver: operationContextResolver(operationContext),
        },
        payload: { collectionId, mandatory: false, name: `${role} definition` },
        registration: createCheckboxPropertyDefinitionActionRegistration,
        transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
      });
      return { checks, result, role };
    }),
  );
  for (const { checks, result, role } of schemaRoleResults) {
    assert.equal(
      result._tag,
      role === 'Full access' || role === 'Editor'
        ? 'OperationSucceeded'
        : 'OperationAuthorizationDenied',
    );
    assert.equal(checks[0].permission, 'manage_property_definitions');
    assert.equal(checks[0].resourceObjectId, resourceObjectId);
  }

  let expectedRevision = 1;
  for (const role of ['Full access', 'Editor', 'User', 'Viewer']) {
    const checks = [];
    // oxlint-disable-next-line no-await-in-loop -- Value revisions make this role matrix sequential.
    const result = await runAction({
      options: {
        authorizationChecker: authorizationForRole(role, checks),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        expectedRevision,
        propertyDefinitionId: seed.response.definition.propertyDefinitionId,
        taskId: task.response.task.taskId,
        value: expectedRevision % 2 === 1,
      },
      registration: updateCheckboxPropertyValueActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
    });
    assert.equal(
      result._tag,
      role === 'Viewer' ? 'OperationAuthorizationDenied' : 'OperationSucceeded',
    );
    assert.equal(checks[0].permission, 'edit_task_property_values');
    assert.equal(checks[0].resourceObjectId, resourceObjectId);
    if (result._tag === 'OperationSucceeded') {
      expectedRevision += 1;
    }
  }

  const viewerReadChecks = [];
  const viewerRead = await runDataAccess({
    options: {
      authorizationChecker: authorizationForRole('Viewer', viewerReadChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(viewerRead._tag, 'OperationSucceeded');
  assert.equal(viewerReadChecks[0].permission, 'view_task_properties');
  assert.equal(viewerReadChecks[0].resourceObjectId, resourceObjectId);

  for (const role of ['User', 'Viewer']) {
    const capabilityChecks = [];
    // oxlint-disable-next-line no-await-in-loop -- The role responses are independently asserted.
    const capability = await runDataAccess({
      options: {
        authorizationChecker: authorizationForRole(role, capabilityChecks),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: getTaskPropertyEditCapabilityDataAccessRegistration,
      resultCount: () => 1,
      transport: { headers: new Headers() },
    });
    assert.equal(
      capability._tag,
      role === 'Viewer' ? 'OperationAuthorizationDenied' : 'OperationSucceeded',
    );
    assert.equal(capabilityChecks[0].permission, 'edit_task_property_values');
    if (capability._tag === 'OperationSucceeded') {
      assert.deepEqual(capability.response, { canEdit: true });
    }
  }
});
