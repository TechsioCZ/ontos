import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createSelectOptionActionRegistration } from '../src/actions/create-select-option.ts';
import { createSelectOptionAndSelectActionRegistration } from '../src/actions/create-select-option-and-select.ts';
import { configureSelectOptionOrderActionRegistration } from '../src/actions/configure-select-option-order.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createSelectPropertyDefinitionActionRegistration } from '../src/actions/create-select-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { updateSelectOptionActionRegistration } from '../src/actions/update-select-option.ts';
import { updateSelectPropertyValueActionRegistration } from '../src/actions/update-select-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

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
