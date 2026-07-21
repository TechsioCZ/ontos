import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { Schema } from '@modern-js/plugin-bff/effect-client';
import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createSelectOptionActionRegistration } from '../src/actions/create-select-option.ts';
import { createSelectOptionAndSelectActionRegistration } from '../src/actions/create-select-option-and-select.ts';
import { configureSelectOptionOrderActionRegistration } from '../src/actions/configure-select-option-order.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createSelectPropertyDefinitionActionRegistration } from '../src/actions/create-select-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteSelectOptionActionRegistration } from '../src/actions/delete-select-option.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { updateSelectOptionActionRegistration } from '../src/actions/update-select-option.ts';
import { updateSelectPropertyValueActionRegistration } from '../src/actions/update-select-property-value.ts';
import { getSelectOptionDeletionImpactDataAccessRegistration } from '../src/data-access/get-select-option-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { queryTaskPropertyValuesDataAccessRegistration } from '../src/data-access/query-task-property-values.ts';
import { taskPropertyQuerySchema } from '../shared/task-property-query.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_select_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.select_options where tenant_id = ${tenantId}`;
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
    values (${'Select tenant'}, ${`select-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    ) values (
      ${tenant.tenant_id}, ${'Select legal entity'}, ${'CZ'}, ${`select-${suffix}`}, ${'active'}
    ) returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Select editor'}, ${'human'}, ${'active'})
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

const readWorkspace = (operationContext, collectionId, locale = 'en-GB') =>
  runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, locale },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
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
  return { collectionId, task };
};

test('Select values keep a stable option identity when its presentation changes', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
  const { optionId } = option.response.option;
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  const updatedOption = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'crimson',
      expectedRevision: 1,
      name: 'Urgent',
      optionId,
      propertyDefinitionId,
    },
    registration: updateSelectOptionActionRegistration,
  });
  assert.equal(updatedOption._tag, 'OperationSucceeded', JSON.stringify(updatedOption));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const selectDefinition = workspace.response.propertyDefinitions.find(
    (candidate) => candidate.propertyDefinitionId === propertyDefinitionId,
  );
  assert.deepEqual(selectDefinition.options, [
    {
      color: 'crimson',
      manualPosition: 0,
      name: 'Urgent',
      optionId,
      revision: 2,
    },
  ]);
  assert.deepEqual(workspace.response.tasks[0].selectValues, [
    { optionId, propertyDefinitionId, revision: 1 },
  ]);
});

test('generic Select configuration returns the complete ordered public definition', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: option.response.definitionRevision,
      hidden: true,
      mandatory: false,
      name: 'Renamed priority',
      propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    datatype: 'select',
    hidden: true,
    mandatory: false,
    name: 'Renamed priority',
    optionOrderMode: 'manual',
    options: [option.response.option],
    propertyDefinitionId,
    revision: option.response.definitionRevision + 1,
  });
});

test('inline option creation and selection is atomic and limited to schema editors', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const userChecks = [];
  const userAttempt = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User', userChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      expectedValueRevision: 0,
      name: 'High',
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: createSelectOptionAndSelectActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(userAttempt._tag, 'OperationAuthorizationDenied');
  assert.equal(userChecks[0].permission, 'manage_property_definitions');

  const createdAndSelected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      expectedValueRevision: 0,
      name: 'High',
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: createSelectOptionAndSelectActionRegistration,
  });
  assert.equal(createdAndSelected._tag, 'OperationSucceeded', JSON.stringify(createdAndSelected));
  assert.equal(
    createdAndSelected.response.value.optionId,
    createdAndSelected.response.option.optionId,
  );

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'blue',
      expectedDefinitionRevision: createdAndSelected.response.definitionRevision,
      expectedValueRevision: 0,
      name: 'Orphan',
      propertyDefinitionId,
      taskId: randomUUID(),
    },
    registration: createSelectOptionAndSelectActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded');
  const selectDefinition = workspace.response.propertyDefinitions.find(
    (candidate) => candidate.propertyDefinitionId === propertyDefinitionId,
  );
  assert.deepEqual(
    selectDefinition.options.map(({ name }) => name),
    ['High'],
  );
});

test('automatic option order uses viewer locale and switching to Manual snapshots displayed order', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  let definitionRevision = 1;
  const optionIds = [];
  for (const [name, color] of [
    ['Zulu', 'red'],
    ['Älg', 'green'],
    ['Alpha', 'blue'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Catalog revisions make this setup sequential.
    const option = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        color,
        expectedDefinitionRevision: definitionRevision,
        name,
        propertyDefinitionId,
      },
      registration: createSelectOptionActionRegistration,
    });
    assert.equal(option._tag, 'OperationSucceeded');
    optionIds.push(option.response.option.optionId);
    ({ definitionRevision } = option.response);
  }
  const alphabetical = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: definitionRevision,
      optionOrderMode: 'alphabetical',
      propertyDefinitionId,
      viewerLocale: 'en-GB',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(alphabetical._tag, 'OperationSucceeded', JSON.stringify(alphabetical));
  const english = await readWorkspace(operationContext, collectionId, 'en-GB');
  const swedish = await readWorkspace(operationContext, collectionId, 'sv-SE');
  const names = (workspace) =>
    workspace.response.propertyDefinitions
      .find((candidate) => candidate.propertyDefinitionId === propertyDefinitionId)
      .options.map(({ name }) => name);
  assert.deepEqual(names(swedish), ['Alpha', 'Zulu', 'Älg']);
  assert.notDeepEqual(names(english), names(swedish));

  const reverse = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: alphabetical.response.definition.revision,
      optionOrderMode: 'reverse_alphabetical',
      propertyDefinitionId,
      viewerLocale: 'sv-SE',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(reverse._tag, 'OperationSucceeded', JSON.stringify(reverse));
  assert.deepEqual(names(await readWorkspace(operationContext, collectionId, 'sv-SE')), [
    'Älg',
    'Zulu',
    'Alpha',
  ]);

  const manual = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: reverse.response.definition.revision,
      manualOptionIds: optionIds,
      optionOrderMode: 'manual',
      propertyDefinitionId,
      viewerLocale: 'sv-SE',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(manual._tag, 'OperationSucceeded', JSON.stringify(manual));
  assert.deepEqual(names(await readWorkspace(operationContext, collectionId, 'en-GB')), [
    'Älg',
    'Zulu',
    'Alpha',
  ]);

  const curatedOptionIds = manual.response.definition.options
    .map(({ optionId }) => optionId)
    .toReversed();
  const curated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: manual.response.definition.revision,
      manualOptionIds: curatedOptionIds,
      optionOrderMode: 'manual',
      propertyDefinitionId,
      viewerLocale: 'en-GB',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(curated._tag, 'OperationSucceeded', JSON.stringify(curated));
  assert.deepEqual(
    curated.response.definition.options.map(({ optionId }) => optionId),
    curatedOptionIds,
  );
});

test('Reverse alphabetical reverses stable identity tie-breaks', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Tie-breaks' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  let definitionRevision = 1;
  for (const name of ['Same', 'Same\u200B']) {
    // oxlint-disable-next-line no-await-in-loop -- Catalog revisions make this setup sequential.
    const option = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        color: 'red',
        expectedDefinitionRevision: definitionRevision,
        name,
        propertyDefinitionId,
      },
      registration: createSelectOptionActionRegistration,
    });
    assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
    ({ definitionRevision } = option.response);
  }
  const alphabetical = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: definitionRevision,
      optionOrderMode: 'alphabetical',
      propertyDefinitionId,
      viewerLocale: 'en-GB',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(alphabetical._tag, 'OperationSucceeded', JSON.stringify(alphabetical));
  const alphabeticalIds = alphabetical.response.definition.options.map(({ optionId }) => optionId);
  const reverse = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: alphabetical.response.definition.revision,
      optionOrderMode: 'reverse_alphabetical',
      propertyDefinitionId,
      viewerLocale: 'en-GB',
    },
    registration: configureSelectOptionOrderActionRegistration,
  });
  assert.equal(reverse._tag, 'OperationSucceeded', JSON.stringify(reverse));
  assert.deepEqual(
    reverse.response.definition.options.map(({ optionId }) => optionId),
    alphabeticalIds.toReversed(),
  );
});

test('a User selects and clears existing options while a Viewer remains read-only', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded');
  const checks = [];
  const selected = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User', checks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: 0,
      optionId: option.response.option.optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  assert.equal(checks[0].permission, 'edit_task_property_values');

  const cleared = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: selected.response.value.revision,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.equal(cleared.response.value.optionId, undefined);

  const viewerAttempt = await runAction({
    options: {
      authorizationChecker: authorizationForRole('Viewer'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: cleared.response.value.revision,
      optionId: option.response.option.optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(viewerAttempt._tag, 'OperationAuthorizationDenied');
});

test('Select option names are trimmed, case-insensitively unique, and accent-sensitive', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Skill' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded');
  const { propertyDefinitionId } = definition.response.definition;
  const resume = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: ' Resume ',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(resume._tag, 'OperationSucceeded');
  assert.equal(resume.response.option.name, 'Resume');
  const duplicate = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'blue',
      expectedDefinitionRevision: resume.response.definitionRevision,
      name: 'resume',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(duplicate._tag, 'OperationDomainRejected');
  const accented = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'green',
      expectedDefinitionRevision: resume.response.definitionRevision,
      name: 'Résumé',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(accented._tag, 'OperationSucceeded', JSON.stringify(accented));
});

test('confirmed Select option deletion clears every retained affected Task', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task: activeTask } = await createCollectionAndTask(operationContext);
  const archivedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const softDeletedTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(archivedTask._tag, 'OperationSucceeded', JSON.stringify(archivedTask));
  assert.equal(softDeletedTask._tag, 'OperationSucceeded', JSON.stringify(softDeletedTask));

  for (const [createdTask, transition] of [
    [archivedTask, 'archive'],
    [softDeletedTask, 'softDelete'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Retention transitions have independent Task revisions.
    const transitioned = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: createdTask.response.task.revision,
        taskId: createdTask.response.task.taskId,
        transition,
      },
      registration: transitionTaskRetentionActionRegistration,
    });
    assert.equal(transitioned._tag, 'OperationSucceeded', JSON.stringify(transitioned));
  }

  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: definition.response.definition.revision,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
  const { optionId } = option.response.option;

  for (const createdTask of [activeTask, archivedTask, softDeletedTask]) {
    // oxlint-disable-next-line no-await-in-loop -- Each Task value is an independent public mutation.
    const selected = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        optionId,
        propertyDefinitionId,
        taskId: createdTask.response.task.taskId,
      },
      registration: updateSelectPropertyValueActionRegistration,
    });
    assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  }

  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, optionId, propertyDefinitionId },
    registration: getSelectOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  assert.equal(preview.response.impactCount, 3);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: preview.response.definitionRevision,
      expectedImpactCount: preview.response.impactCount,
      expectedOptionRevision: preview.response.optionRevision,
      optionId,
      propertyDefinitionId,
    },
    registration: deleteSelectOptionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  assert.equal(deleted.response.impactCount, 3);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.propertyDefinitions.find(
      (candidate) => candidate.propertyDefinitionId === propertyDefinitionId,
    ).options,
    [],
  );
  assert.deepEqual(
    workspace.response.tasks.map(({ selectValues }) => selectValues),
    [
      [{ propertyDefinitionId, revision: 2 }],
      [{ propertyDefinitionId, revision: 2 }],
      [{ propertyDefinitionId, revision: 2 }],
    ],
  );
});

test('Select option deletion previews zero after an affected Task is hard-deleted', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: definition.response.definition.revision,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      optionId: option.response.option.optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  const hardDeleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: selected.response.taskRevision,
      taskId: task.response.task.taskId,
      transition: 'hardDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(hardDeleted._tag, 'OperationSucceeded', JSON.stringify(hardDeleted));

  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, optionId: option.response.option.optionId, propertyDefinitionId },
    registration: getSelectOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  assert.equal(preview.response.impactCount, 0);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedDefinitionRevision: preview.response.definitionRevision,
      expectedImpactCount: 0,
      expectedOptionRevision: preview.response.optionRevision,
      optionId: option.response.option.optionId,
      propertyDefinitionId,
    },
    registration: deleteSelectOptionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
});

test('Select option deletion requires fresh confirmation when retained impact changes', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const option = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
  const { optionId } = option.response.option;
  const preview = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, optionId, propertyDefinitionId },
    registration: getSelectOptionDeletionImpactDataAccessRegistration,
    resultCount: ({ impactCount }) => impactCount,
    transport: { headers: new Headers() },
  });
  assert.equal(preview._tag, 'OperationSucceeded', JSON.stringify(preview));
  assert.equal(preview.response.impactCount, 0);

  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  const deletionPayload = {
    collectionId,
    confirmed: true,
    expectedDefinitionRevision: preview.response.definitionRevision,
    expectedImpactCount: preview.response.impactCount,
    expectedOptionRevision: preview.response.optionRevision,
    optionId,
    propertyDefinitionId,
  };
  const unconfirmed = await runRegisteredAction({
    operationContext,
    payload: { ...deletionPayload, confirmed: false },
    registration: deleteSelectOptionActionRegistration,
  });
  assert.equal(unconfirmed._tag, 'OperationDomainRejected', JSON.stringify(unconfirmed));
  assert.equal(unconfirmed.code, 'ticketing.deleteSelectOption.confirmation_required');

  const stale = await runRegisteredAction({
    operationContext,
    payload: deletionPayload,
    registration: deleteSelectOptionActionRegistration,
  });
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.deleteSelectOption.stale_impact');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.propertyDefinitions[0].options[0].optionId, optionId);
  assert.equal(workspace.response.tasks[0].selectValues[0].optionId, optionId);
});

test('Select is-not filtering includes another selection and Empty', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task: selectedHighTask } = await createCollectionAndTask(operationContext);
  const selectedLowTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  const emptyTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(selectedLowTask._tag, 'OperationSucceeded', JSON.stringify(selectedLowTask));
  assert.equal(emptyTask._tag, 'OperationSucceeded', JSON.stringify(emptyTask));

  const definition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;
  const high = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'red',
      expectedDefinitionRevision: 1,
      name: 'High',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(high._tag, 'OperationSucceeded', JSON.stringify(high));
  const low = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'blue',
      expectedDefinitionRevision: high.response.definitionRevision,
      name: 'Low',
      propertyDefinitionId,
    },
    registration: createSelectOptionActionRegistration,
  });
  assert.equal(low._tag, 'OperationSucceeded', JSON.stringify(low));

  for (const [createdTask, optionId] of [
    [selectedHighTask, high.response.option.optionId],
    [selectedLowTask, low.response.option.optionId],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each Task value is an independent public mutation.
    const selected = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: 0,
        optionId,
        propertyDefinitionId,
        taskId: createdTask.response.task.taskId,
      },
      registration: updateSelectPropertyValueActionRegistration,
    });
    assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));
  }

  const filter = (operation) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId, propertyDefinitionId, query: { datatype: 'select', operation } },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: ({ taskIds }) => taskIds.length,
      transport: { headers: new Headers() },
    });
  const filterCases = [
    [
      { operator: 'is', optionId: high.response.option.optionId, type: 'filter' },
      [selectedHighTask.response.task.taskId],
    ],
    [
      { operator: 'isNot', optionId: high.response.option.optionId, type: 'filter' },
      [emptyTask.response.task.taskId, selectedLowTask.response.task.taskId],
    ],
    [{ operator: 'isEmpty', type: 'filter' }, [emptyTask.response.task.taskId]],
    [
      { operator: 'isNotEmpty', type: 'filter' },
      [selectedHighTask.response.task.taskId, selectedLowTask.response.task.taskId],
    ],
  ];
  for (const [operation, expectedTaskIds] of filterCases) {
    // oxlint-disable-next-line no-await-in-loop -- Each query is an independently observable filter.
    const filtered = await filter(operation);
    assert.equal(filtered._tag, 'OperationSucceeded', JSON.stringify(filtered));
    assert.deepEqual(filtered.response.taskIds, expectedTaskIds.toSorted());
  }

  for (const unsupportedOperation of [
    { query: 'High', type: 'search' },
    { direction: 'ascending', type: 'sort' },
    { type: 'group' },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(taskPropertyQuerySchema)({
        datatype: 'select',
        operation: unsupportedOperation,
      }),
    );
  }
});

test('Select duplication remaps copied values to new option identities beside its source', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, task } = await createCollectionAndTask(operationContext);
  const source = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Priority' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(source._tag, 'OperationSucceeded', JSON.stringify(source));
  const { propertyDefinitionId } = source.response.definition;
  let definitionRevision = source.response.definition.revision;
  const sourceOptions = [];
  for (const [name, color] of [
    ['High', 'red'],
    ['Low', 'blue'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Catalog revisions make setup sequential.
    const option = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        color,
        expectedDefinitionRevision: definitionRevision,
        name,
        propertyDefinitionId,
      },
      registration: createSelectOptionActionRegistration,
    });
    assert.equal(option._tag, 'OperationSucceeded', JSON.stringify(option));
    sourceOptions.push(option.response.option);
    ({ definitionRevision } = option.response);
  }
  const sibling = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Stage' },
    registration: createSelectPropertyDefinitionActionRegistration,
  });
  assert.equal(sibling._tag, 'OperationSucceeded', JSON.stringify(sibling));
  const selected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      optionId: sourceOptions[0].optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
  });
  assert.equal(selected._tag, 'OperationSucceeded', JSON.stringify(selected));

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: definitionRevision,
      propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));
  const duplicate = duplicated.response.definition;
  assert.equal(duplicate.datatype, 'select');
  assert.equal(duplicate.name, 'Priority Copy');
  assert.equal(duplicate.mandatory, true);
  assert.deepEqual(
    duplicate.options.map(({ color, manualPosition, name }) => ({ color, manualPosition, name })),
    sourceOptions.map(({ color, manualPosition, name }) => ({ color, manualPosition, name })),
  );
  assert.equal(
    duplicate.options.some(({ optionId }) =>
      sourceOptions.some((sourceOption) => sourceOption.optionId === optionId),
    ),
    false,
  );

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.propertyDefinitions.map(({ propertyDefinitionId: id }) => id),
    [
      propertyDefinitionId,
      duplicate.propertyDefinitionId,
      sibling.response.definition.propertyDefinitionId,
    ],
  );
  const duplicateValue = workspace.response.tasks[0].selectValues.find(
    (value) => value.propertyDefinitionId === duplicate.propertyDefinitionId,
  );
  assert.deepEqual(duplicateValue, {
    optionId: duplicate.options[0].optionId,
    propertyDefinitionId: duplicate.propertyDefinitionId,
    revision: 1,
  });

  const blankDuplication = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: definitionRevision,
      propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(blankDuplication._tag, 'OperationSucceeded', JSON.stringify(blankDuplication));
  const blankDuplicate = blankDuplication.response.definition;
  assert.equal(blankDuplicate.name, 'Priority Copy 2');
  assert.equal(blankDuplicate.options.length, 2);

  const changedSourceOption = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      color: 'crimson',
      expectedRevision: sourceOptions[0].revision,
      name: 'Urgent',
      optionId: sourceOptions[0].optionId,
      propertyDefinitionId,
    },
    registration: updateSelectOptionActionRegistration,
  });
  assert.equal(changedSourceOption._tag, 'OperationSucceeded', JSON.stringify(changedSourceOption));
  const changedSourceValue = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: selected.response.value.revision,
      optionId: sourceOptions[1].optionId,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateSelectPropertyValueActionRegistration,
  });
  assert.equal(changedSourceValue._tag, 'OperationSucceeded', JSON.stringify(changedSourceValue));

  const independentWorkspace = await readWorkspace(operationContext, collectionId);
  assert.equal(
    independentWorkspace._tag,
    'OperationSucceeded',
    JSON.stringify(independentWorkspace),
  );
  assert.deepEqual(
    independentWorkspace.response.propertyDefinitions.map(({ propertyDefinitionId: id }) => id),
    [
      propertyDefinitionId,
      blankDuplicate.propertyDefinitionId,
      duplicate.propertyDefinitionId,
      sibling.response.definition.propertyDefinitionId,
    ],
  );
  assert.deepEqual(
    independentWorkspace.response.propertyDefinitions
      .find(({ propertyDefinitionId: id }) => id === duplicate.propertyDefinitionId)
      .options.map(({ color, name }) => ({ color, name })),
    [
      { color: 'red', name: 'High' },
      { color: 'blue', name: 'Low' },
    ],
  );
  const independentValues = independentWorkspace.response.tasks[0].selectValues;
  assert.equal(
    independentValues.find((value) => value.propertyDefinitionId === propertyDefinitionId).optionId,
    sourceOptions[1].optionId,
  );
  assert.equal(
    independentValues.find((value) => value.propertyDefinitionId === duplicate.propertyDefinitionId)
      .optionId,
    duplicate.options[0].optionId,
  );
  assert.equal(
    independentValues.some(
      (value) => value.propertyDefinitionId === blankDuplicate.propertyDefinitionId,
    ),
    false,
  );
});
