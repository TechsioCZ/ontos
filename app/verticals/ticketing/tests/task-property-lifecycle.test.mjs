import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
import { getTaskCollectionDataAccessRegistration } from '../src/data-access/get-task-collection.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

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
    values (${'Task Property lifecycle tenant'}, ${`property-lifecycle-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Task Property lifecycle legal entity'},
      ${'CZ'},
      ${`property-lifecycle-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Task Property lifecycle editor'}, ${'human'}, ${'active'})
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

const createCollectionTaskAndDefinition = async (operationContext) => {
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
    payload: { collectionId, mandatory: false, name: 'Approved' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition, task };
};

test('schema configuration trims the name and preserves Checkbox values and Task facts', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const before = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(before._tag, 'OperationSucceeded', JSON.stringify(before));

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: true,
      mandatory: true,
      name: '  Ready  ',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });

  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    datatype: 'checkbox',
    hidden: true,
    mandatory: true,
    name: 'Ready',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 2,
  });

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, [configured.response.definition]);
  assert.deepEqual(workspace.response.tasks, [
    {
      checkboxValues: [
        {
          propertyDefinitionId: definition.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
      ],
      taskId: task.response.task.taskId,
      taskRevision: 1,
      title: '',
    },
  ]);

  const mandatoryFalseSubmission = await runRegisteredAction({
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
  assert.equal(
    mandatoryFalseSubmission._tag,
    'OperationSucceeded',
    JSON.stringify(mandatoryFalseSubmission),
  );
  const shown = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      hidden: false,
      mandatory: true,
      name: 'Ready',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(shown._tag, 'OperationSucceeded', JSON.stringify(shown));
  assert.equal(shown.response.definition.hidden, false);
  const shownWorkspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(shownWorkspace._tag, 'OperationSucceeded', JSON.stringify(shownWorkspace));
  assert.deepEqual(shownWorkspace.response.propertyDefinitions, [shown.response.definition]);
  assert.deepEqual(shownWorkspace.response.tasks, workspace.response.tasks);

  const afterRead = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskCollectionDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(afterRead._tag, 'OperationSucceeded', JSON.stringify(afterRead));
  assert.equal(afterRead.response.task.lastEditedAt, before.response.task.lastEditedAt);
  assert.equal(
    afterRead.response.task.lastEditedByPrincipalId,
    before.response.task.lastEditedByPrincipalId,
  );
  assert.equal(afterRead.response.task.revision, 1);
});

test('Checkbox duplication copies configuration and generates the first available Copy name', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: true,
      mandatory: true,
      name: 'Approved',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));

  const duplicate = (propertyDefinitionId, expectedRevision) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        copyValues: false,
        expectedRevision,
        propertyDefinitionId,
      },
      registration: duplicateTaskPropertyDefinitionActionRegistration,
    });
  const first = await duplicate(
    configured.response.definition.propertyDefinitionId,
    configured.response.definition.revision,
  );
  assert.equal(first._tag, 'OperationSucceeded', JSON.stringify(first));
  assert.deepEqual(first.response.definition, {
    datatype: 'checkbox',
    hidden: true,
    mandatory: true,
    name: 'Approved Copy',
    propertyDefinitionId: first.response.definition.propertyDefinitionId,
    revision: 1,
  });
  const second = await duplicate(
    configured.response.definition.propertyDefinitionId,
    configured.response.definition.revision,
  );
  assert.equal(second._tag, 'OperationSucceeded', JSON.stringify(second));
  assert.equal(second.response.definition.name, 'Approved Copy 2');

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.propertyDefinitions.map(({ name }) => name),
    ['Approved', 'Approved Copy', 'Approved Copy 2'],
  );
  assert.deepEqual(workspace.response.tasks, [
    {
      checkboxValues: [
        {
          propertyDefinitionId: configured.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
        {
          propertyDefinitionId: first.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
        {
          propertyDefinitionId: second.response.definition.propertyDefinitionId,
          revision: 1,
          value: false,
        },
      ],
      taskId: task.response.task.taskId,
      taskRevision: 1,
      title: '',
    },
  ]);
});

test('Checkbox value-copy duplication snapshots values independently', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const sourcePropertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const checked = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: sourcePropertyDefinitionId,
      taskId: task.response.task.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(checked._tag, 'OperationSucceeded', JSON.stringify(checked));
  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: 1,
      propertyDefinitionId: sourcePropertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));
  const duplicatePropertyDefinitionId = duplicated.response.definition.propertyDefinitionId;

  const changedSource = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      propertyDefinitionId: sourcePropertyDefinitionId,
      taskId: task.response.task.taskId,
      value: false,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(changedSource._tag, 'OperationSucceeded', JSON.stringify(changedSource));
  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].checkboxValues, [
    { propertyDefinitionId: sourcePropertyDefinitionId, revision: 3, value: false },
    { propertyDefinitionId: duplicatePropertyDefinitionId, revision: 1, value: true },
  ]);
});

test('schema names stay non-empty and case-insensitively unique', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition } = await createCollectionTaskAndDefinition(operationContext);
  const collidingCreate = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: '  approved  ' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(collidingCreate._tag, 'OperationDomainRejected', JSON.stringify(collidingCreate));
  const emptyRename = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: false,
      mandatory: false,
      name: '   ',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(emptyRename._tag, 'OperationDomainRejected', JSON.stringify(emptyRename));
  assert.equal(emptyRename.code, 'ticketing.configureTaskPropertyDefinition.name_required');
});

test('User and Viewer cannot change Task Property configuration', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition } = await createCollectionTaskAndDefinition(operationContext);

  for (const role of ['User', 'Viewer']) {
    // oxlint-disable-next-line no-await-in-loop -- Each denied role observes the same revision.
    const configured = await runAction({
      options: {
        authorizationChecker: authorizationForRole(role),
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        expectedRevision: 1,
        hidden: true,
        mandatory: true,
        name: 'Denied',
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      },
      registration: configureTaskPropertyDefinitionActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
    });
    assert.equal(configured._tag, 'OperationAuthorizationDenied', JSON.stringify(configured));
  }
});

test('shared lifecycle evidence contains metadata but no property names or Checkbox values', () => {
  const definition = {
    datatype: 'checkbox',
    hidden: true,
    mandatory: true,
    name: 'Private label',
    propertyDefinitionId: 'definition-2',
    revision: 2,
  };
  const configureInput = {
    collectionId: 'collection-1',
    expectedRevision: 1,
    hidden: true,
    mandatory: true,
    name: 'Private label',
    propertyDefinitionId: 'definition-2',
  };
  const configureResponse = { definition };
  const configureEvidence =
    configureTaskPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      configureInput,
      configureResponse,
    );
  const duplicateEvidence =
    duplicateTaskPropertyDefinitionActionRegistration.descriptor.domainEvent.payload(
      {
        collectionId: 'collection-1',
        copyValues: true,
        expectedRevision: 2,
        propertyDefinitionId: 'definition-1',
      },
      configureResponse,
    );
  const deleteEvidence =
    deleteTaskPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      {
        collectionId: 'collection-1',
        confirmed: true,
        expectedImpactCount: 7,
        expectedRevision: 2,
        propertyDefinitionId: 'definition-2',
      },
      { deletedPropertyDefinitionId: 'definition-2', impactCount: 7 },
    );

  assert.equal(JSON.stringify(configureEvidence).includes('Private label'), false);
  assert.equal(Object.hasOwn(configureEvidence, 'name'), false);
  assert.equal(Object.hasOwn(duplicateEvidence, 'value'), false);
  assert.equal(duplicateEvidence.copiedValues, true);
  assert.equal(deleteEvidence.impactCount, 7);
});

test('Checkbox deletion always confirms the current retained-Task impact and removes shared values', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition } = await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const preview = () =>
    runRegisteredDataAccess({
      operationContext,
      payload: { collectionId, propertyDefinitionId },
      registration: getTaskPropertyDeletionImpactDataAccessRegistration,
      resultCount: () => 1,
    });
  const initialImpact = await preview();
  assert.equal(initialImpact._tag, 'OperationSucceeded', JSON.stringify(initialImpact));
  assert.deepEqual(initialImpact.response, {
    impactCount: 1,
    propertyDefinitionId,
    revision: 1,
  });

  const laterTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(laterTask._tag, 'OperationSucceeded', JSON.stringify(laterTask));
  const staleConfirmation = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: initialImpact.response.impactCount,
      expectedRevision: initialImpact.response.revision,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(
    staleConfirmation._tag,
    'OperationDomainRejected',
    JSON.stringify(staleConfirmation),
  );
  assert.equal(staleConfirmation.code, 'ticketing.deleteTaskPropertyDefinition.stale_impact');

  const currentImpact = await preview();
  assert.equal(currentImpact._tag, 'OperationSucceeded', JSON.stringify(currentImpact));
  assert.equal(currentImpact.response.impactCount, 2);
  const removed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: currentImpact.response.impactCount,
      expectedRevision: currentImpact.response.revision,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(removed._tag, 'OperationSucceeded', JSON.stringify(removed));
  assert.deepEqual(removed.response, {
    deletedPropertyDefinitionId: propertyDefinitionId,
    impactCount: 2,
  });

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, []);
  assert.equal(workspace.response.tasks.length, 2);
  assert.deepEqual(
    workspace.response.tasks.map(({ checkboxValues, taskRevision }) => ({
      checkboxValues,
      taskRevision,
    })),
    [
      { checkboxValues: [], taskRevision: 1 },
      { checkboxValues: [], taskRevision: 1 },
    ],
  );
});

test('deleting a zero-impact Checkbox still requires explicit confirmation', async () => {
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
    payload: { collectionId, mandatory: false, name: 'Unused' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const impact = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 0);

  const notConfirmed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: false,
      expectedImpactCount: 0,
      expectedRevision: 1,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.notEqual(notConfirmed._tag, 'OperationSucceeded', JSON.stringify(notConfirmed));
  const confirmed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 0,
      expectedRevision: 1,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(confirmed._tag, 'OperationSucceeded', JSON.stringify(confirmed));
  assert.equal(confirmed.response.impactCount, 0);
});
