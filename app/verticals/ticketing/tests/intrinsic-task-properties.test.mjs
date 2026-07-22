import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { createVerticalGatewayToken } from '../../../packages/core-runtime/src/vertical-gateway-token.ts';
import { db, sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { resolveEffectiveTimeZone } from '../../../packages/core-runtime/src/principal-time-zone-preferences.ts';
import { observeCoreActionEvidence } from '@app/core-runtime/testing/evidence-observer';
import { createIntrinsicPropertyDefinitionActionRegistration } from '../src/actions/create-intrinsic-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { configurePrincipalTimeZonePreferenceActionRegistration } from '../src/actions/configure-principal-time-zone-preference.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
import { updateTaskContentActionRegistration } from '../src/actions/update-task-content.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { queryIntrinsicTaskPropertiesDataAccessRegistration } from '../src/data-access/query-intrinsic-task-properties.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.domain_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.audit_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.action_invocations where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.data_access_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenant_module_states where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principal_time_zone_preferences where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_checkbox_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principals where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.legal_entities where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenants where tenant_id = ${tenantId}`;
    }),
  );
  await sqlClient.end({ timeout: 1 });
});

const createOperationIdentity = async () => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Intrinsic Task Property tenant'}, ${`intrinsic-properties-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Intrinsic Task Property legal entity'},
      ${'CZ'},
      ${`intrinsic-properties-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Ada Lovelace'}, ${'human'}, ${'active'})
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

const runRegisteredAction = ({ clock, idempotencyKey, operationContext, payload, registration }) =>
  runAction({
    options: {
      authorizationChecker: allowedAuthorization,
      ...(clock === undefined ? {} : { clock }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration,
    transport: { headers: new Headers({ 'Idempotency-Key': idempotencyKey ?? randomUUID() }) },
  });

const runSignedRegisteredAction = ({ clock, operationContext, payload, registration }) =>
  runAction({
    options: {
      authorizationChecker: allowedAuthorization,
      ...(clock === undefined ? {} : { clock }),
    },
    payload,
    registration,
    transport: {
      headers: new Headers({
        'Idempotency-Key': randomUUID(),
        'x-ontos-operation-context': createVerticalGatewayToken({
          audience: registration.descriptor.gatewayAudience,
          operationContext,
        }),
      }),
    },
  });

const configurePrincipalTimeZone = (operationContext, timeZone) =>
  runRegisteredAction({
    operationContext,
    payload: { timeZone },
    registration: configurePrincipalTimeZonePreferenceActionRegistration,
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

test('Created time definitions project the original intrinsic Task creation instant', async () => {
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
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, [definition.response.definition]);
  assert.deepEqual(workspace.response.tasks, [
    {
      canvas: {},
      checkboxValues: [],
      createdAt: task.response.task.createdAt,
      dateRangeValues: [],
      dateValues: [],
      emailValues: [],
      filesMediaItems: [],
      phoneValues: [],
      statusValues: [],
      taskId: task.response.task.taskId,
      taskRevision: 1,
      title: '',
    },
  ]);

  const hidden = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: true,
      mandatory: false,
      name: 'Created time',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(hidden._tag, 'OperationSucceeded', JSON.stringify(hidden));
  const hiddenWorkspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(hiddenWorkspace._tag, 'OperationSucceeded', JSON.stringify(hiddenWorkspace));
  assert.equal(hiddenWorkspace.response.tasks[0].createdAt, undefined);
});

test('Last edited time initializes to the Task creation instant through its live projection', async () => {
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
    payload: { collectionId, datatype: 'last_edited_time', mandatory: false, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, [definition.response.definition]);
  assert.equal(workspace.response.tasks[0].createdAt, undefined);
  assert.equal(workspace.response.tasks[0].lastEditedAt, task.response.task.createdAt);
});

test('Last edited by initializes to the creator and projects the latest successful editor', async () => {
  const creatorContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: false,
      name: 'Last edited by',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const initialWorkspace = await runRegisteredDataAccess({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(initialWorkspace._tag, 'OperationSucceeded', JSON.stringify(initialWorkspace));
  assert.deepEqual(initialWorkspace.response.tasks[0].lastEditedBy, {
    displayName: 'Ada Lovelace',
    inactive: false,
    principalId: creatorContext.principalId,
  });

  const [editor] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${creatorContext.tenantId}, ${'Grace Hopper'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  const editorContext = { ...creatorContext, principalId: editor.principal_id };
  const edited = await runRegisteredAction({
    operationContext: editorContext,
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 1,
      taskId: task.response.task.taskId,
      title: 'Edited by Grace',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));

  const editedWorkspace = await runRegisteredDataAccess({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(editedWorkspace._tag, 'OperationSucceeded', JSON.stringify(editedWorkspace));
  assert.deepEqual(editedWorkspace.response.tasks[0].lastEditedBy, {
    displayName: 'Grace Hopper',
    inactive: false,
    principalId: editorContext.principalId,
  });

  const noOp = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 2,
      taskId: task.response.task.taskId,
      title: 'Edited by Grace',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(noOp._tag, 'OperationSucceeded', JSON.stringify(noOp));
  assert.equal(noOp.response.taskRevision, 2);
  const stale = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 1,
      taskId: task.response.task.taskId,
      title: 'Stale edit',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  const finalSave = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 2,
      taskId: task.response.task.taskId,
      title: 'Creator commits last',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(finalSave._tag, 'OperationSucceeded', JSON.stringify(finalSave));

  const finalWorkspace = await runRegisteredDataAccess({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(finalWorkspace._tag, 'OperationSucceeded', JSON.stringify(finalWorkspace));
  assert.equal(
    finalWorkspace.response.tasks[0].lastEditedBy.principalId,
    creatorContext.principalId,
  );
  assert.equal(finalWorkspace.response.tasks[0].taskRevision, 3);
});

test('a user-driven automation attributes its successful Task mutation to the originating Principal', async () => {
  const originContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext: originContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext: originContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext: originContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: false,
      name: 'Last edited by',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const [automation] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${originContext.tenantId}, ${'Task automation'}, ${'system'}, ${'active'})
    returning principal_id
  `;
  await sqlClient`
    update core.principals
    set display_name = ${'Retained originating editor'}, status = ${'disabled'}
    where principal_id = ${originContext.principalId}
  `;
  const automationContext = {
    ...originContext,
    originatingPrincipalId: originContext.principalId,
    principalId: automation.principal_id,
  };

  const automated = await runSignedRegisteredAction({
    operationContext: automationContext,
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 1,
      taskId: task.response.task.taskId,
      title: 'Updated by automation',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(automated._tag, 'OperationSucceeded', JSON.stringify(automated));

  const workspace = await runRegisteredDataAccess({
    operationContext: { ...automationContext, originatingPrincipalId: undefined },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].lastEditedBy, {
    displayName: 'Retained originating editor',
    inactive: true,
    principalId: originContext.principalId,
  });
});

test('property-value automation uses the originating Principal as the Effective Editor', async () => {
  const originContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext: originContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const checkbox = await runRegisteredAction({
    operationContext: originContext,
    payload: { collectionId, mandatory: false, name: 'Approved' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(checkbox._tag, 'OperationSucceeded', JSON.stringify(checkbox));
  const lastEditedBy = await runRegisteredAction({
    operationContext: originContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: false,
      name: 'Last edited by',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(lastEditedBy._tag, 'OperationSucceeded', JSON.stringify(lastEditedBy));
  const task = await runRegisteredAction({
    operationContext: originContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const [automation] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${originContext.tenantId}, ${'Property automation'}, ${'system'}, ${'active'})
    returning principal_id
  `;

  const updated = await runRegisteredAction({
    operationContext: {
      ...originContext,
      originatingPrincipalId: originContext.principalId,
      principalId: automation.principal_id,
    },
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: checkbox.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const workspace = await runRegisteredDataAccess({
    operationContext: originContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].lastEditedBy.principalId, originContext.principalId);
});

test('a successful actual property-value mutation advances Last edited time atomically', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const createdAt = new Date('2026-07-21T08:00:00.123Z');
  const task = await runRegisteredAction({
    clock: { now: () => createdAt },
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const checkbox = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Approved' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(checkbox._tag, 'OperationSucceeded', JSON.stringify(checkbox));
  const lastEdited = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'last_edited_time', mandatory: false, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(lastEdited._tag, 'OperationSucceeded', JSON.stringify(lastEdited));

  const editedAt = new Date('2026-07-21T09:30:45.678Z');
  const edited = await runRegisteredAction({
    clock: { now: () => editedAt },
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
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].lastEditedAt, editedAt.toISOString());
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
});

test('one actual Title and canvas save advances Last edited time once while a no-op does not', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    clock: { now: () => new Date('2026-07-21T08:00:00.000Z') },
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'last_edited_time', mandatory: false, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const payload = {
    canvas: { content: [{ text: 'Review the contract', type: 'paragraph' }], type: 'doc' },
    collectionId,
    expectedRevision: 1,
    taskId: task.response.task.taskId,
    title: 'Review contract',
  };

  const editedAt = new Date('2026-07-21T10:15:30.250Z');
  const editIdempotencyKey = randomUUID();
  const edited = await runRegisteredAction({
    clock: { now: () => editedAt },
    idempotencyKey: editIdempotencyKey,
    operationContext,
    payload,
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));
  assert.deepEqual(edited.response, {
    canvas: payload.canvas,
    changedComponents: ['title', 'canvas'],
    taskId: payload.taskId,
    taskRevision: 2,
    title: payload.title,
  });
  const editedActionInvocationId = edited.context.actionInvocation?.actionInvocationId;
  assert.ok(editedActionInvocationId);
  const editedEvidence = await observeCoreActionEvidence({
    actionInvocationId: editedActionInvocationId,
    db,
    tenantId: operationContext.tenantId,
  });
  assert.deepEqual(
    editedEvidence.auditEvents.find(({ eventType }) => eventType === 'action.succeeded')?.evidence,
    {
      changedComponents: ['title', 'canvas'],
      collectionId,
      operation: 'content_changed',
      taskId: payload.taskId,
      taskRevision: 2,
    },
  );

  const replayed = await runRegisteredAction({
    clock: { now: () => new Date('2026-07-21T11:00:00.000Z') },
    idempotencyKey: editIdempotencyKey,
    operationContext,
    payload,
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(replayed._tag, 'OperationIdempotencyReplayUnavailable', JSON.stringify(replayed));

  const noOp = await runRegisteredAction({
    clock: { now: () => new Date('2026-07-21T12:00:00.000Z') },
    operationContext,
    payload: { ...payload, expectedRevision: 2 },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(noOp._tag, 'OperationSucceeded', JSON.stringify(noOp));
  assert.deepEqual(noOp.response.changedComponents, []);
  assert.equal(noOp.response.taskRevision, 2);
  assert.equal(
    noOp.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );

  const stale = await runRegisteredAction({
    clock: { now: () => new Date('2026-07-21T13:00:00.000Z') },
    operationContext,
    payload: { ...payload, expectedRevision: 1, title: 'Stale draft' },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updateTaskContent.stale_or_missing');

  const titleOnlyEditedAt = new Date('2026-07-21T14:00:00.500Z');
  const titleOnly = await runRegisteredAction({
    clock: { now: () => titleOnlyEditedAt },
    operationContext,
    payload: { ...payload, expectedRevision: 2, title: 'Review the final contract' },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(titleOnly._tag, 'OperationSucceeded', JSON.stringify(titleOnly));
  assert.deepEqual(titleOnly.response.changedComponents, ['title']);
  const titleOnlyActionInvocationId = titleOnly.context.actionInvocation?.actionInvocationId;
  assert.ok(titleOnlyActionInvocationId);
  const titleOnlyEvidence = await observeCoreActionEvidence({
    actionInvocationId: titleOnlyActionInvocationId,
    db,
    tenantId: operationContext.tenantId,
  });
  assert.deepEqual(
    titleOnlyEvidence.auditEvents.find(({ eventType }) => eventType === 'action.succeeded')
      ?.evidence,
    {
      changedComponents: ['title'],
      collectionId,
      operation: 'content_changed',
      taskId: payload.taskId,
      taskRevision: 3,
    },
  );

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].lastEditedAt, titleOnlyEditedAt.toISOString());
  assert.equal(workspace.response.tasks[0].taskRevision, 3);
  assert.equal(workspace.response.tasks[0].title, titleOnly.response.title);
  assert.deepEqual(workspace.response.tasks[0].canvas, payload.canvas);
});

test('archive and restore advance Last edited time while soft deletion does not', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    clock: { now: () => new Date('2026-07-21T08:00:00.000Z') },
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'last_edited_time', mandatory: false, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const lastEditedBy = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: false,
      name: 'Last edited by',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(lastEditedBy._tag, 'OperationSucceeded', JSON.stringify(lastEditedBy));
  const [systemPrincipal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${operationContext.tenantId}, ${'Retention automation'}, ${'system'}, ${'active'})
    returning principal_id
  `;
  const transition = (clock, expectedRevision, retentionTransition, transitionContext) =>
    runRegisteredAction({
      clock: { now: () => new Date(clock) },
      operationContext: transitionContext,
      payload: {
        collectionId,
        expectedRevision,
        taskId: task.response.task.taskId,
        transition: retentionTransition,
      },
      registration: transitionTaskRetentionActionRegistration,
    });

  const automationContext = { ...operationContext, principalId: systemPrincipal.principal_id };
  const archived = await transition('2026-07-21T09:00:00.125Z', 1, 'archive', {
    ...automationContext,
    originatingPrincipalId: operationContext.principalId,
  });
  assert.equal(archived._tag, 'OperationSucceeded', JSON.stringify(archived));
  const archivedWorkspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(archivedWorkspace._tag, 'OperationSucceeded', JSON.stringify(archivedWorkspace));
  assert.equal(
    archivedWorkspace.response.tasks[0].lastEditedBy.principalId,
    operationContext.principalId,
  );
  const restored = await transition('2026-07-21T10:00:00.250Z', 2, 'restore', automationContext);
  assert.equal(restored._tag, 'OperationSucceeded', JSON.stringify(restored));
  const softDeleted = await transition(
    '2026-07-21T11:00:00.375Z',
    3,
    'softDelete',
    operationContext,
  );
  assert.equal(softDeleted._tag, 'OperationSucceeded', JSON.stringify(softDeleted));

  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].lastEditedAt, '2026-07-21T10:00:00.250Z');
  assert.deepEqual(workspace.response.tasks[0].lastEditedBy, {
    displayName: 'Retention automation',
    inactive: false,
    principalId: systemPrincipal.principal_id,
  });
  assert.equal(workspace.response.tasks[0].taskRevision, 4);
});

test('duplicating an intrinsic definition needs no value-copy choice and projects the same facts', async () => {
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
  const source = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'created_by', mandatory: true, name: 'Created by' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(source._tag, 'OperationSucceeded', JSON.stringify(source));

  const duplicatePayload = {
    collectionId,
    copyValues: true,
    expectedRevision: 1,
    propertyDefinitionId: source.response.definition.propertyDefinitionId,
  };
  const duplicate = await runRegisteredAction({
    operationContext,
    payload: duplicatePayload,
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });

  assert.equal(duplicate._tag, 'OperationSucceeded', JSON.stringify(duplicate));
  assert.deepEqual(duplicate.response.definition, {
    ...source.response.definition,
    name: 'Created by Copy',
    propertyDefinitionId: duplicate.response.definition.propertyDefinitionId,
  });
  assert.deepEqual(
    duplicateTaskPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      duplicatePayload,
      duplicate.response,
    ).changedComponents,
    ['definition'],
  );
  assert.equal(
    duplicateTaskPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      duplicatePayload,
      duplicate.response,
    ).copiedValues,
    false,
  );
  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].createdBy, {
    displayName: 'Ada Lovelace',
    inactive: false,
    principalId: operationContext.principalId,
  });
  assert.equal(workspace.response.tasks[0].taskId, task.response.task.taskId);
});

test('duplicating Last edited time projects the live fact without copying values', async () => {
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
  const source = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'last_edited_time', mandatory: true, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(source._tag, 'OperationSucceeded', JSON.stringify(source));
  const duplicatePayload = {
    collectionId,
    copyValues: true,
    expectedRevision: 1,
    propertyDefinitionId: source.response.definition.propertyDefinitionId,
  };

  const duplicate = await runRegisteredAction({
    operationContext,
    payload: duplicatePayload,
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });

  assert.equal(duplicate._tag, 'OperationSucceeded', JSON.stringify(duplicate));
  assert.equal(duplicate.response.definition.name, 'Last edited Copy');
  const duplicateActionInvocationId = duplicate.context.actionInvocation?.actionInvocationId;
  assert.ok(duplicateActionInvocationId);
  const observedEvidence = await observeCoreActionEvidence({
    actionInvocationId: duplicateActionInvocationId,
    db,
    tenantId: operationContext.tenantId,
  });
  const evidence = observedEvidence.auditEvents.find(
    ({ eventType }) => eventType === 'action.succeeded',
  )?.evidence;
  assert.ok(evidence);
  assert.deepEqual(evidence.changedComponents, ['definition']);
  assert.equal(evidence.copiedValues, false);
  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].lastEditedAt, task.response.task.lastEditedAt);
});

test('Last edited by definitions duplicate, remove, and re-add around one retained live fact', async () => {
  const creatorContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const task = await runRegisteredAction({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
  const source = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: true,
      name: 'Last edited by',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(source._tag, 'OperationSucceeded', JSON.stringify(source));
  const [editor] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${creatorContext.tenantId}, ${'Original editor name'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  const edited = await runRegisteredAction({
    operationContext: { ...creatorContext, principalId: editor.principal_id },
    payload: {
      canvas: {},
      collectionId,
      expectedRevision: 1,
      taskId: task.response.task.taskId,
      title: 'Edited task',
    },
    registration: updateTaskContentActionRegistration,
  });
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));

  const duplicate = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: 1,
      propertyDefinitionId: source.response.definition.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicate._tag, 'OperationSucceeded', JSON.stringify(duplicate));
  assert.equal(duplicate.response.definition.name, 'Last edited by Copy');
  const duplicateEvidence =
    duplicateTaskPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      {
        collectionId,
        copyValues: true,
        expectedRevision: 1,
        propertyDefinitionId: source.response.definition.propertyDefinitionId,
      },
      duplicate.response,
    );
  assert.equal(duplicateEvidence.copiedValues, false);
  assert.deepEqual(duplicateEvidence.changedComponents, ['definition']);

  const impact = await runRegisteredDataAccess({
    operationContext: creatorContext,
    payload: {
      collectionId,
      propertyDefinitionId: source.response.definition.propertyDefinitionId,
    },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 1);
  const removed = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 1,
      expectedRevision: 1,
      propertyDefinitionId: source.response.definition.propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(removed._tag, 'OperationSucceeded', JSON.stringify(removed));
  const readded = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {
      collectionId,
      datatype: 'last_edited_by',
      mandatory: false,
      name: 'Current editor',
    },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(readded._tag, 'OperationSucceeded', JSON.stringify(readded));
  await sqlClient`
    update core.principals
    set display_name = ${'Current retained name'}, status = ${'disabled'}
    where principal_id = ${editor.principal_id}
  `;

  const workspace = await runRegisteredDataAccess({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].lastEditedBy, {
    displayName: 'Current retained name',
    inactive: true,
    principalId: editor.principal_id,
  });
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
});

test('removing and re-adding Created time preserves the intrinsic fact', async () => {
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
  const originalCreatedAt = task.response.task.createdAt;
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const impact = await runRegisteredDataAccess({
    operationContext,
    payload: {
      collectionId,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 1);
  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 1,
      expectedRevision: 1,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const readded = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(readded._tag, 'OperationSucceeded', JSON.stringify(readded));
  const workspace = await runRegisteredDataAccess({
    operationContext,
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].createdAt, originalCreatedAt);
});

test('every collection role is rejected when forging an intrinsic value write', async () => {
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
    payload: { collectionId, datatype: 'created_by', mandatory: false, name: 'Created by' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const roles = ['Full access', 'Editor', 'User', 'Viewer'];
  const outcomes = await Promise.all(
    roles.map((role) =>
      runAction({
        options: {
          authorizationChecker: authorizationForRole(role),
          operationContextResolver: operationContextResolver(operationContext),
        },
        payload: {
          collectionId,
          expectedRevision: 1,
          propertyDefinitionId: definition.response.definition.propertyDefinitionId,
          taskId: task.response.task.taskId,
          value: false,
        },
        registration: updateCheckboxPropertyValueActionRegistration,
        transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
      }),
    ),
  );
  for (const [index, outcome] of outcomes.entries()) {
    const role = roles[index];
    assert.notEqual(outcome._tag, 'OperationSucceeded', `${role} forged an intrinsic value`);
  }
});

test('Core Principal Preferences resolves configured, browser, and UTC time zones', async () => {
  const operationContext = await createOperationIdentity();

  const browserFallback = await resolveEffectiveTimeZone({
    browserTimeZone: 'America/New_York',
    context: operationContext,
    db,
  });
  assert.deepEqual(browserFallback, {
    source: 'browser_fallback',
    timeZone: 'America/New_York',
  });

  const preference = await configurePrincipalTimeZone(operationContext, 'Europe/Prague');
  assert.equal(preference._tag, 'OperationSucceeded', JSON.stringify(preference));
  const configured = await resolveEffectiveTimeZone({
    browserTimeZone: 'America/New_York',
    context: operationContext,
    db,
  });
  assert.deepEqual(configured, { source: 'configured', timeZone: 'Europe/Prague' });

  const invalidPreference = await configurePrincipalTimeZone(operationContext, 'Not/A_Zone');
  assert.equal(
    invalidPreference._tag,
    'OperationDomainRejected',
    JSON.stringify(invalidPreference),
  );
  const preserved = await resolveEffectiveTimeZone({ context: operationContext, db });
  assert.deepEqual(preserved, { source: 'configured', timeZone: 'Europe/Prague' });

  const fallbackContext = await createOperationIdentity();
  const utcFallback = await resolveEffectiveTimeZone({ context: fallbackContext, db });
  assert.deepEqual(utcFallback, { source: 'system_fallback', timeZone: 'UTC' });

  const [systemPrincipal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${fallbackContext.tenantId}, ${'Scheduled importer'}, ${'system'}, ${'active'})
    returning principal_id
  `;
  const systemFallback = await resolveEffectiveTimeZone({
    browserTimeZone: 'America/New_York',
    context: { ...fallbackContext, principalId: systemPrincipal.principal_id },
    db,
  });
  assert.deepEqual(systemFallback, { source: 'system_fallback', timeZone: 'UTC' });
  const systemPreference = await configurePrincipalTimeZone(
    { ...fallbackContext, principalId: systemPrincipal.principal_id },
    'Europe/Prague',
  );
  assert.equal(systemPreference._tag, 'OperationDomainRejected', JSON.stringify(systemPreference));

  await sqlClient`
    update core.principals
    set status = 'disabled'
    where principal_id = ${operationContext.principalId}
  `;
  const inactiveFallback = await resolveEffectiveTimeZone({
    browserTimeZone: 'America/New_York',
    context: operationContext,
    db,
  });
  assert.deepEqual(inactiveFallback, { source: 'system_fallback', timeZone: 'UTC' });
});

test('Created by queries current Principal presentation through stable identities', async () => {
  const creatorContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext: creatorContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const firstTask = await runRegisteredAction({
    operationContext: creatorContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(firstTask._tag, 'OperationSucceeded', JSON.stringify(firstTask));
  const [secondPrincipal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${creatorContext.tenantId}, ${'Zoë Washburne'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  const secondContext = { ...creatorContext, principalId: secondPrincipal.principal_id };
  const secondTask = await runRegisteredAction({
    operationContext: secondContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(secondTask._tag, 'OperationSucceeded', JSON.stringify(secondTask));
  const definition = await runRegisteredAction({
    operationContext: creatorContext,
    payload: { collectionId, datatype: 'created_by', mandatory: false, name: 'Created by' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  await sqlClient`
    update core.principals
    set display_name = ${'Grace Hopper'}, status = ${'disabled'}
    where principal_id = ${creatorContext.principalId}
  `;
  const query = (operation) =>
    runRegisteredDataAccess({
      operationContext: creatorContext,
      payload: {
        collectionId,
        operation,
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
        viewerLocale: 'en-GB',
      },
      registration: queryIntrinsicTaskPropertiesDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
    });

  const searched = await query({ _tag: 'CreatedBySearch', value: 'hopper' });
  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(searched.response.tasks, [
    {
      createdBy: {
        displayName: 'Grace Hopper',
        inactive: true,
        principalId: creatorContext.principalId,
      },
      taskId: firstTask.response.task.taskId,
    },
  ]);
  const filtered = await query({
    _tag: 'CreatedByFilter',
    principalId: secondContext.principalId,
  });
  assert.equal(filtered._tag, 'OperationSucceeded', JSON.stringify(filtered));
  assert.deepEqual(
    filtered.response.tasks.map(({ taskId }) => taskId),
    [secondTask.response.task.taskId],
  );
  const sorted = await query({ _tag: 'CreatedBySort', direction: 'ascending' });
  assert.equal(sorted._tag, 'OperationSucceeded', JSON.stringify(sorted));
  assert.deepEqual(
    sorted.response.tasks.map(({ createdBy }) => createdBy.displayName),
    ['Grace Hopper', 'Zoë Washburne'],
  );
  const grouped = await query({ _tag: 'CreatedByGroup' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(grouped.response.groups, [
    {
      key: creatorContext.principalId,
      label: 'Grace Hopper',
      taskIds: [firstTask.response.task.taskId],
    },
    {
      key: secondContext.principalId,
      label: 'Zoë Washburne',
      taskIds: [secondTask.response.task.taskId],
    },
  ]);
});

test('an exposed intrinsic definition queries as empty before the collection has Tasks', async () => {
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
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));

  const result = await runRegisteredDataAccess({
    operationContext,
    payload: {
      browserTimeZone: 'Europe/Prague',
      collectionId,
      operation: { _tag: 'CreatedTimeGroup' },
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      viewerLocale: 'cs-CZ',
    },
    registration: queryIntrinsicTaskPropertiesDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
  });
  assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  assert.deepEqual(result.response.tasks, []);
  assert.deepEqual(result.response.groups, []);
});

test('Created time queries absolute milliseconds through the configured viewer zone', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const taskCreationInstants = [
    '2026-03-29T00:59:59.750Z',
    '2026-03-29T01:00:00.250Z',
    '2026-03-29T22:00:00.000Z',
  ];
  const clock = {
    now: () => new Date(taskCreationInstants.shift()),
  };
  const createTask = async () => {
    const task = await runRegisteredAction({
      clock,
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(task._tag, 'OperationSucceeded', JSON.stringify(task));
    return task.response.task;
  };
  const firstTask = await createTask();
  const secondTask = await createTask();
  const thirdTask = await createTask();
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const preference = await configurePrincipalTimeZone(operationContext, 'Europe/Prague');
  assert.equal(preference._tag, 'OperationSucceeded', JSON.stringify(preference));
  const query = (operation, viewerLocale = 'en-GB') =>
    runRegisteredDataAccess({
      operationContext,
      payload: {
        browserTimeZone: 'America/New_York',
        collectionId,
        operation,
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
        viewerLocale,
      },
      registration: queryIntrinsicTaskPropertiesDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
    });

  const exactSecond = await query({
    _tag: 'CreatedTimeFilter',
    operator: 'exact',
    value: '2026-03-29T00:59:59Z',
  });
  assert.equal(exactSecond._tag, 'OperationSucceeded', JSON.stringify(exactSecond));
  assert.deepEqual(exactSecond.response.effectiveTimeZone, {
    source: 'configured',
    timeZone: 'Europe/Prague',
  });
  assert.deepEqual(
    exactSecond.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId],
  );

  const displayedSearchCases = [
    ['cs-CZ', '29. 3. 2026', [firstTask.taskId, secondTask.taskId]],
    ['en-GB', '29 Mar 2026, 03:00', [secondTask.taskId]],
    ['en-US', 'Mar 29, 2026, 3:00:00 AM', [secondTask.taskId]],
  ];
  const displayedSearchResults = await Promise.all(
    displayedSearchCases.map(([viewerLocale, value]) =>
      query({ _tag: 'CreatedTimeSearch', value }, viewerLocale),
    ),
  );
  for (const [index, searched] of displayedSearchResults.entries()) {
    const [viewerLocale, value, expectedTaskIds] = displayedSearchCases[index];
    assert.equal(
      searched._tag,
      'OperationSucceeded',
      `${viewerLocale}: ${value}: ${JSON.stringify(searched)}`,
    );
    assert.deepEqual(
      searched.response.tasks.map(({ taskId }) => taskId),
      expectedTaskIds,
      `${viewerLocale}: ${value}`,
    );
  }

  const newYorkPreference = await configurePrincipalTimeZone(operationContext, 'America/New_York');
  assert.equal(newYorkPreference._tag, 'OperationSucceeded', JSON.stringify(newYorkPreference));
  const exactSecondInAnotherZone = await query({
    _tag: 'CreatedTimeFilter',
    operator: 'exact',
    value: '2026-03-29T00:59:59Z',
  });
  assert.equal(
    exactSecondInAnotherZone._tag,
    'OperationSucceeded',
    JSON.stringify(exactSecondInAnotherZone),
  );
  assert.deepEqual(
    exactSecondInAnotherZone.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId],
  );
  const praguePreference = await configurePrincipalTimeZone(operationContext, 'Europe/Prague');
  assert.equal(praguePreference._tag, 'OperationSucceeded', JSON.stringify(praguePreference));

  const filterCases = [
    ['before', [firstTask.taskId]],
    ['after', [secondTask.taskId, thirdTask.taskId]],
    ['on_or_before', [firstTask.taskId]],
    ['on_or_after', [secondTask.taskId, thirdTask.taskId]],
  ];
  const filterResults = await Promise.all(
    filterCases.map(([operator]) =>
      query({
        _tag: 'CreatedTimeFilter',
        operator,
        value: '2026-03-29T01:00:00.125Z',
      }),
    ),
  );
  for (const [index, filtered] of filterResults.entries()) {
    const [operator, expectedTaskIds] = filterCases[index];
    assert.equal(filtered._tag, 'OperationSucceeded', JSON.stringify(filtered));
    assert.deepEqual(
      filtered.response.tasks.map(({ taskId }) => taskId),
      expectedTaskIds,
      operator,
    );
  }

  const localRange = await query({
    _tag: 'CreatedTimeFilter',
    endValue: '29/03/2026',
    operator: 'local_range',
    value: '29/03/2026',
  });
  assert.equal(localRange._tag, 'OperationSucceeded', JSON.stringify(localRange));
  assert.deepEqual(
    localRange.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId, secondTask.taskId],
  );

  const localDaySearch = await query({
    _tag: 'CreatedTimeSearch',
    value: '29/03/2026',
  });
  assert.equal(localDaySearch._tag, 'OperationSucceeded', JSON.stringify(localDaySearch));
  assert.deepEqual(
    localDaySearch.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId, secondTask.taskId],
  );

  const sorted = await query({ _tag: 'CreatedTimeSort', direction: 'descending' });
  assert.equal(sorted._tag, 'OperationSucceeded', JSON.stringify(sorted));
  assert.deepEqual(
    sorted.response.tasks.map(({ taskId }) => taskId),
    [thirdTask.taskId, secondTask.taskId, firstTask.taskId],
  );

  const grouped = await query({ _tag: 'CreatedTimeGroup' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(grouped.response.groups, [
    {
      key: '2026-03-29',
      label: '2026-03-29',
      taskIds: [firstTask.taskId, secondTask.taskId],
    },
    {
      key: '2026-03-30',
      label: '2026-03-30',
      taskIds: [thirdTask.taskId],
    },
  ]);
});

test('Last edited time reuses absolute temporal search, filter, sort, and local-day grouping', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const { collectionId } = collection.response.collection;
  const checkbox = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Approved' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(checkbox._tag, 'OperationSucceeded', JSON.stringify(checkbox));
  const createTaskAt = async (instant) => {
    const created = await runRegisteredAction({
      clock: { now: () => new Date(instant) },
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created.response.task;
  };
  const firstTask = await createTaskAt('2026-03-28T22:30:00.000Z');
  const secondTask = await createTaskAt('2026-03-29T00:30:00.000Z');
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'last_edited_time', mandatory: false, name: 'Last edited' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const edited = await runRegisteredAction({
    clock: { now: () => new Date('2026-03-29T22:30:00.750Z') },
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: checkbox.response.definition.propertyDefinitionId,
      taskId: firstTask.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));
  const preference = await configurePrincipalTimeZone(operationContext, 'Europe/Prague');
  assert.equal(preference._tag, 'OperationSucceeded', JSON.stringify(preference));
  const query = (operation) =>
    runRegisteredDataAccess({
      operationContext,
      payload: {
        collectionId,
        operation,
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
        viewerLocale: 'en-GB',
      },
      registration: queryIntrinsicTaskPropertiesDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
    });

  const searched = await query({ _tag: 'LastEditedTimeSearch', value: '30/03/2026' });
  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(
    searched.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId],
  );
  assert.equal(searched.response.tasks[0].lastEditedAt, '2026-03-29T22:30:00.750Z');

  const exact = await query({
    _tag: 'LastEditedTimeFilter',
    operator: 'exact',
    value: '2026-03-29T22:30:00Z',
  });
  assert.equal(exact._tag, 'OperationSucceeded', JSON.stringify(exact));
  assert.deepEqual(
    exact.response.tasks.map(({ taskId }) => taskId),
    [firstTask.taskId],
  );

  const sorted = await query({ _tag: 'LastEditedTimeSort', direction: 'ascending' });
  assert.equal(sorted._tag, 'OperationSucceeded', JSON.stringify(sorted));
  assert.deepEqual(
    sorted.response.tasks.map(({ taskId }) => taskId),
    [secondTask.taskId, firstTask.taskId],
  );

  const grouped = await query({ _tag: 'LastEditedTimeGroup' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  assert.deepEqual(grouped.response.groups, [
    { key: '2026-03-29', label: '2026-03-29', taskIds: [secondTask.taskId] },
    { key: '2026-03-30', label: '2026-03-30', taskIds: [firstTask.taskId] },
  ]);
});
