import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { db, sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { resolveEffectiveTimeZone } from '../../../packages/core-runtime/src/principal-time-zone-preferences.ts';
import { createIntrinsicPropertyDefinitionActionRegistration } from '../src/actions/create-intrinsic-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
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

const seedPrincipalTimeZonePreference = async (operationContext, timeZone) => {
  await sqlClient`
    insert into core.principal_time_zone_preferences (principal_id, tenant_id, time_zone)
    values (${operationContext.principalId}, ${operationContext.tenantId}, ${timeZone})
    on conflict (tenant_id, principal_id) do update
      set time_zone = excluded.time_zone
  `;
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
      checkboxValues: [],
      createdAt: task.response.task.createdAt,
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

  await seedPrincipalTimeZonePreference(operationContext, 'Europe/Prague');
  const configured = await resolveEffectiveTimeZone({
    browserTimeZone: 'America/New_York',
    context: operationContext,
    db,
  });
  assert.deepEqual(configured, { source: 'configured', timeZone: 'Europe/Prague' });

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
  const createTask = async () => {
    const task = await runRegisteredAction({
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
  await sqlClient`
    update ticketing.tasks
    set created_at = case task_id
      when ${firstTask.taskId} then ${'2026-03-29T00:59:59.750Z'}::timestamptz
      when ${secondTask.taskId} then ${'2026-03-29T01:00:00.250Z'}::timestamptz
      when ${thirdTask.taskId} then ${'2026-03-29T22:00:00.000Z'}::timestamptz
    end
    where task_id in (${firstTask.taskId}, ${secondTask.taskId}, ${thirdTask.taskId})
  `;
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, datatype: 'created_time', mandatory: false, name: 'Created time' },
    registration: createIntrinsicPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  await seedPrincipalTimeZonePreference(operationContext, 'Europe/Prague');
  const query = (operation) =>
    runRegisteredDataAccess({
      operationContext,
      payload: {
        browserTimeZone: 'America/New_York',
        collectionId,
        operation,
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
        viewerLocale: 'en-GB',
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
  await seedPrincipalTimeZonePreference(operationContext, 'America/New_York');
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
  await seedPrincipalTimeZonePreference(operationContext, 'Europe/Prague');

  const filterCases = [
    ['before', [firstTask.taskId]],
    ['after', [thirdTask.taskId]],
    ['on_or_before', [firstTask.taskId, secondTask.taskId]],
    ['on_or_after', [secondTask.taskId, thirdTask.taskId]],
  ];
  const filterResults = await Promise.all(
    filterCases.map(([operator]) =>
      query({
        _tag: 'CreatedTimeFilter',
        operator,
        value: '2026-03-29T01:00:00Z',
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
