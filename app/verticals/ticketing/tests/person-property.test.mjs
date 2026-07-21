import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createPersonPropertyDefinitionActionRegistration } from '../src/actions/create-person-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { updatePersonPropertyValueActionRegistration } from '../src/actions/update-person-property-value.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { searchEligiblePeopleDataAccessRegistration } from '../src/data-access/search-eligible-people.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.domain_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.audit_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.action_invocations where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.data_access_events where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_person_assignments where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_person_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_person_property_configurations where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principal_directory_field_visibility where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principal_directory_entries where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principals where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenant_module_states where tenant_id = ${tenantId}`;
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
    values (${'Person tenant'}, ${`person-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Person legal entity'},
      ${'CZ'},
      ${`person-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [editor] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Person editor'}, ${'human'}, ${'active'})
    returning principal_id
  `;
  await sqlClient`
    insert into core.tenant_module_states (tenant_id, module_key, state)
    values (${tenant.tenant_id}, ${'ticketing'}, ${'active'})
  `;
  return {
    legalEntityId: legalEntity.legal_entity_id,
    principalId: editor.principal_id,
    tenantId: tenant.tenant_id,
  };
};

const createDirectoryPerson = async (
  operationContext,
  {
    displayName,
    email = null,
    login = null,
    membershipKind = 'member',
    membershipStatus = 'active',
    status = 'active',
  },
) => {
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${operationContext.tenantId}, ${displayName}, ${'human'}, ${status})
    returning principal_id
  `;
  await sqlClient`
    insert into core.principal_directory_entries (
      email,
      login,
      principal_id,
      tenant_id,
      membership_kind,
      membership_status
    )
    values (
      ${email},
      ${login},
      ${principal.principal_id},
      ${operationContext.tenantId},
      ${membershipKind},
      ${membershipStatus}
    )
  `;
  return principal.principal_id;
};

const grantDirectoryVisibility = async ({
  displayNameVisible,
  emailVisible,
  loginVisible,
  operationContext,
  subjectPrincipalId,
  viewerPrincipalId = operationContext.principalId,
}) => {
  await sqlClient`
    insert into core.principal_directory_field_visibility (
      display_name_visible,
      email_visible,
      login_visible,
      subject_principal_id,
      tenant_id,
      viewer_principal_id
    )
    values (
      ${displayNameVisible},
      ${emailVisible},
      ${loginVisible},
      ${subjectPrincipalId},
      ${operationContext.tenantId},
      ${viewerPrincipalId}
    )
  `;
};

const operationContextResolver = (operationContext) => () => ({
  _tag: 'Success',
  operationContext,
});

const allowedAuthorization = () => ({ _tag: 'Allowed' });

const authorizationForRole = (role) => (check) => {
  const permissions = {
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

const createCollectionTaskAndPersonDefinition = async (operationContext, name = 'Assignees') => {
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
    payload: { collectionId, mandatory: false, name },
    registration: createPersonPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition, task };
};

const updatePersonValue = ({
  collectionId,
  expectedRevision,
  operationContext,
  principalIds,
  propertyDefinitionId,
  taskId,
}) =>
  runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision,
      principalIds,
      propertyDefinitionId,
      taskId,
    },
    registration: updatePersonPropertyValueActionRegistration,
  });

test('an eligible tenant member can be assigned through the Person action and public read', async () => {
  const operationContext = await createOperationIdentity();
  const assigneePrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Ada Lovelace',
  });
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
    payload: { collectionId, mandatory: false, name: 'Assignees' },
    registration: createPersonPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  assert.deepEqual(definition.response.definition, {
    cardinality: 'unlimited',
    datatype: 'person',
    hidden: false,
    mandatory: false,
    name: 'Assignees',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
  });

  const assigned = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      principalIds: [assigneePrincipalId],
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updatePersonPropertyValueActionRegistration,
  });
  assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));
  assert.deepEqual(assigned.response, {
    taskRevision: 2,
    value: {
      principalIds: [assigneePrincipalId],
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: 2,
    },
  });

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.propertyDefinitions, [definition.response.definition]);
  assert.deepEqual(workspace.response.tasks, [
    {
      checkboxValues: [],
      personValues: [
        {
          people: [
            {
              displayName: 'Ada Lovelace',
              eligible: true,
              principalId: assigneePrincipalId,
              status: 'active',
            },
          ],
          principalIds: [assigneePrincipalId],
          propertyDefinitionId: definition.response.definition.propertyDefinitionId,
          revision: 2,
        },
      ],
      taskId: task.response.task.taskId,
      taskRevision: 2,
      title: '',
    },
  ]);
});

test('generic Task Property configuration preserves the Person cardinality contract', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition } =
    await createCollectionTaskAndPersonDefinition(operationContext);

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: definition.response.definition.revision,
      hidden: true,
      mandatory: false,
      name: 'Owners',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });

  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    cardinality: 'unlimited',
    datatype: 'person',
    hidden: true,
    mandatory: false,
    name: 'Owners',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 2,
  });
});

test('eligible-person search is governed by the authenticated viewer and per-field visibility', async () => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(collection._tag, 'OperationSucceeded', JSON.stringify(collection));
  const subjectPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Private Person',
    email: 'visible@example.test',
    login: 'private-login',
  });
  const otherViewerPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Other viewer',
  });
  await grantDirectoryVisibility({
    displayNameVisible: true,
    emailVisible: true,
    loginVisible: true,
    operationContext,
    subjectPrincipalId,
    viewerPrincipalId: otherViewerPrincipalId,
  });

  const search = (payload) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId: collection.response.collection.collectionId, ...payload },
      registration: searchEligiblePeopleDataAccessRegistration,
      resultCount: (response) => response.people.length,
      transport: { headers: new Headers() },
    });
  const cannotBorrowVisibility = await search({
    query: 'private-login',
    viewerPrincipalId: otherViewerPrincipalId,
  });
  assert.equal(
    cannotBorrowVisibility._tag,
    'OperationSucceeded',
    JSON.stringify(cannotBorrowVisibility),
  );
  assert.deepEqual(cannotBorrowVisibility.response.people, []);

  await grantDirectoryVisibility({
    displayNameVisible: true,
    emailVisible: true,
    loginVisible: false,
    operationContext,
    subjectPrincipalId,
  });
  const visibleEmail = await search({ query: 'visible@example' });
  assert.equal(visibleEmail._tag, 'OperationSucceeded', JSON.stringify(visibleEmail));
  assert.deepEqual(visibleEmail.response.people, [
    {
      displayName: 'Private Person',
      email: 'visible@example.test',
      principalId: subjectPrincipalId,
    },
  ]);
  const hiddenLogin = await search({ query: 'private-login' });
  assert.equal(hiddenLogin._tag, 'OperationSucceeded', JSON.stringify(hiddenLogin));
  assert.deepEqual(hiddenLogin.response.people, []);
});

test('ineligible identities cannot be newly assigned while stored inactive references remain resolvable', async () => {
  const operationContext = await createOperationIdentity();
  const eligiblePrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Eligible member',
  });
  const disabledPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Disabled member',
    status: 'disabled',
  });
  const departedPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Departed guest',
    membershipKind: 'guest',
    membershipStatus: 'departed',
  });
  const otherTenant = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;

  for (const principalId of [disabledPrincipalId, departedPrincipalId, otherTenant.principalId]) {
    // oxlint-disable-next-line no-await-in-loop -- Each ineligible identity observes revision 1.
    const rejected = await updatePersonValue({
      collectionId,
      expectedRevision: 1,
      operationContext,
      principalIds: [principalId],
      propertyDefinitionId,
      taskId,
    });
    assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
    assert.equal(rejected.code, 'ticketing.updatePersonPropertyValue.principal_ineligible');
  }

  const assigned = await updatePersonValue({
    collectionId,
    expectedRevision: 1,
    operationContext,
    principalIds: [eligiblePrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));
  await sqlClient`
    update core.principals
    set status = 'disabled', disabled_at = statement_timestamp()
    where principal_id = ${eligiblePrincipalId}
  `;
  const historical = await readWorkspace(operationContext, collectionId);
  assert.equal(historical._tag, 'OperationSucceeded', JSON.stringify(historical));
  assert.deepEqual(historical.response.tasks[0].personValues[0].people, [
    {
      displayName: 'Eligible member',
      eligible: false,
      principalId: eligiblePrincipalId,
      status: 'disabled',
    },
  ]);

  const duplicateNoOp = await updatePersonValue({
    collectionId,
    expectedRevision: 2,
    operationContext,
    principalIds: [eligiblePrincipalId, eligiblePrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(duplicateNoOp._tag, 'OperationSucceeded', JSON.stringify(duplicateNoOp));
  assert.equal(duplicateNoOp.response.value.revision, 2);
  assert.equal(
    duplicateNoOp.context.auditEvents?.some(({ eventType }) => eventType === 'action.succeeded'),
    false,
  );

  const cleared = await updatePersonValue({
    collectionId,
    expectedRevision: 2,
    operationContext,
    principalIds: [],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  const reassignDisabled = await updatePersonValue({
    collectionId,
    expectedRevision: 3,
    operationContext,
    principalIds: [eligiblePrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(reassignDisabled._tag, 'OperationDomainRejected', JSON.stringify(reassignDisabled));
});

test('cardinality reduction reports the violating retained-Task count and one-person replacement is atomic', async () => {
  const { configurePersonPropertyCardinalityActionRegistration } =
    await import('../src/actions/configure-person-property-cardinality.ts');
  const operationContext = await createOperationIdentity();
  const firstPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'First assignee',
  });
  const secondPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Second assignee',
  });
  const { collectionId, definition, task } =
    await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const assigned = await updatePersonValue({
    collectionId,
    expectedRevision: 1,
    operationContext,
    principalIds: [firstPrincipalId, secondPrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));

  const configure = (cardinality, expectedRevision) =>
    runRegisteredAction({
      operationContext,
      payload: { cardinality, collectionId, expectedRevision, propertyDefinitionId },
      registration: configurePersonPropertyCardinalityActionRegistration,
    });
  const rejected = await configure('one', 1);
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(
    rejected.code,
    'ticketing.configurePersonPropertyCardinality.assignments_violate_limit',
  );
  assert.deepEqual(rejected.state, { violatingTaskCount: 1 });

  const reducedValue = await updatePersonValue({
    collectionId,
    expectedRevision: 2,
    operationContext,
    principalIds: [firstPrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(reducedValue._tag, 'OperationSucceeded', JSON.stringify(reducedValue));
  const configured = await configure('one', 1);
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    cardinality: 'one',
    datatype: 'person',
    hidden: false,
    mandatory: false,
    name: 'Assignees',
    propertyDefinitionId,
    revision: 2,
  });

  const replaced = await updatePersonValue({
    collectionId,
    expectedRevision: 3,
    operationContext,
    principalIds: [secondPrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(replaced._tag, 'OperationSucceeded', JSON.stringify(replaced));
  assert.deepEqual(replaced.response.value.principalIds, [secondPrincipalId]);
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].personValues[0].principalIds, [secondPrincipalId]);
});

test('Person query filters, display-name search, sequence sort, and membership grouping are observable publicly', async () => {
  const { queryTaskPersonValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-person-values.ts');
  const operationContext = await createOperationIdentity();
  const adaPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Ada Lovelace',
  });
  const emilePrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Émile Zola',
  });
  const zanetaPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Žaneta Nováková',
  });
  const {
    collectionId,
    definition,
    task: firstTask,
  } = await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
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
  const emptyTask = await createTask();
  const fourthTask = await createTask();
  for (const [taskId, principalIds] of [
    [firstTask.response.task.taskId, [zanetaPrincipalId, adaPrincipalId]],
    [secondTask.taskId, [adaPrincipalId]],
    [fourthTask.taskId, [emilePrincipalId]],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each Task owns an independent Person value.
    const assigned = await updatePersonValue({
      collectionId,
      expectedRevision: 1,
      operationContext,
      principalIds,
      propertyDefinitionId,
      taskId,
    });
    assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));
  }

  const query = (payload) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId, propertyDefinitionId, ...payload },
      registration: queryTaskPersonValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
  const containsAda = await query({
    filter: { operator: 'contains', principalId: adaPrincipalId },
  });
  assert.equal(containsAda._tag, 'OperationSucceeded', JSON.stringify(containsAda));
  assert.deepEqual(containsAda.response.taskIds, [
    firstTask.response.task.taskId,
    secondTask.taskId,
  ]);
  const lacksAda = await query({
    filter: { operator: 'doesNotContain', principalId: adaPrincipalId },
  });
  assert.equal(lacksAda._tag, 'OperationSucceeded', JSON.stringify(lacksAda));
  assert.deepEqual(lacksAda.response.taskIds, [emptyTask.taskId, fourthTask.taskId]);
  const empty = await query({ filter: { operator: 'isEmpty' } });
  assert.equal(empty._tag, 'OperationSucceeded', JSON.stringify(empty));
  assert.deepEqual(empty.response.taskIds, [emptyTask.taskId]);
  const searched = await query({ search: 'ADA' });
  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(searched.response.taskIds, [firstTask.response.task.taskId, secondTask.taskId]);
  const diacriticSensitive = await query({ search: 'Emile' });
  assert.equal(diacriticSensitive._tag, 'OperationSucceeded', JSON.stringify(diacriticSensitive));
  assert.deepEqual(diacriticSensitive.response.taskIds, []);

  const sortedAndGrouped = await query({ group: true, sort: 'ascending' });
  assert.equal(sortedAndGrouped._tag, 'OperationSucceeded', JSON.stringify(sortedAndGrouped));
  assert.deepEqual(sortedAndGrouped.response.taskIds, [
    secondTask.taskId,
    firstTask.response.task.taskId,
    fourthTask.taskId,
    emptyTask.taskId,
  ]);
  assert.deepEqual(sortedAndGrouped.response.groups, [
    {
      person: {
        displayName: 'Ada Lovelace',
        eligible: true,
        principalId: adaPrincipalId,
        status: 'active',
      },
      taskIds: [firstTask.response.task.taskId, secondTask.taskId],
    },
    {
      person: {
        displayName: 'Émile Zola',
        eligible: true,
        principalId: emilePrincipalId,
        status: 'active',
      },
      taskIds: [fourthTask.taskId],
    },
    {
      person: {
        displayName: 'Žaneta Nováková',
        eligible: true,
        principalId: zanetaPrincipalId,
        status: 'active',
      },
      taskIds: [firstTask.response.task.taskId],
    },
    { person: null, taskIds: [emptyTask.taskId] },
  ]);
});

test('Person sorting uses the persisted Task Collection locale and compares full name sequences before identities', async () => {
  const { queryTaskPersonValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-person-values.ts');
  const operationContext = await createOperationIdentity();
  const firstAlexPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Alex',
  });
  const secondAlexPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Alex',
  });
  const betaPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Beta',
  });
  const zuluPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Zulu',
  });
  const chataPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Chata',
  });
  const holubPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Holub',
  });
  const {
    collectionId,
    definition,
    task: firstTask,
  } = await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  await sqlClient`
    update ticketing.task_collections
    set locale = ${'cs-CZ'}
    where collection_id = ${collectionId}
      and tenant_id = ${operationContext.tenantId}
  `;
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
  const chataTask = await createTask();
  const holubTask = await createTask();
  const [lowerAlexPrincipalId, higherAlexPrincipalId] = [
    firstAlexPrincipalId,
    secondAlexPrincipalId,
  ].toSorted();
  for (const [taskId, principalIds] of [
    [firstTask.response.task.taskId, [lowerAlexPrincipalId, zuluPrincipalId]],
    [secondTask.taskId, [higherAlexPrincipalId, betaPrincipalId]],
    [chataTask.taskId, [chataPrincipalId]],
    [holubTask.taskId, [holubPrincipalId]],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each Task owns an independent Person value.
    const assigned = await updatePersonValue({
      collectionId,
      expectedRevision: 1,
      operationContext,
      principalIds,
      propertyDefinitionId,
      taskId,
    });
    assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));
  }

  const sorted = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId, sort: 'ascending' },
    registration: queryTaskPersonValuesDataAccessRegistration,
    resultCount: (response) => response.taskIds.length,
    transport: { headers: new Headers() },
  });
  assert.equal(sorted._tag, 'OperationSucceeded', JSON.stringify(sorted));
  assert.deepEqual(sorted.response.taskIds, [
    secondTask.taskId,
    firstTask.response.task.taskId,
    holubTask.taskId,
    chataTask.taskId,
  ]);
});

test('Person duplication snapshots inactive assignments independently and lifecycle deletion remains referentially safe', async () => {
  const operationContext = await createOperationIdentity();
  const assigneePrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Historical assignee',
  });
  const { collectionId, definition, task } =
    await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId: sourcePropertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const assigned = await updatePersonValue({
    collectionId,
    expectedRevision: 1,
    operationContext,
    principalIds: [assigneePrincipalId],
    propertyDefinitionId: sourcePropertyDefinitionId,
    taskId,
  });
  assert.equal(assigned._tag, 'OperationSucceeded', JSON.stringify(assigned));
  await sqlClient`
    update core.principals
    set status = 'archived'
    where principal_id = ${assigneePrincipalId}
  `;

  const duplicate = (copyValues) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        copyValues,
        expectedRevision: 1,
        propertyDefinitionId: sourcePropertyDefinitionId,
      },
      registration: duplicateTaskPropertyDefinitionActionRegistration,
    });
  const copied = await duplicate(true);
  assert.equal(copied._tag, 'OperationSucceeded', JSON.stringify(copied));
  assert.equal(copied.response.definition.cardinality, 'unlimited');
  assert.equal(copied.response.definition.name, 'Assignees Copy');
  const blank = await duplicate(false);
  assert.equal(blank._tag, 'OperationSucceeded', JSON.stringify(blank));
  assert.equal(blank.response.definition.name, 'Assignees Copy 2');

  const clearedSource = await updatePersonValue({
    collectionId,
    expectedRevision: 2,
    operationContext,
    principalIds: [],
    propertyDefinitionId: sourcePropertyDefinitionId,
    taskId,
  });
  assert.equal(clearedSource._tag, 'OperationSucceeded', JSON.stringify(clearedSource));
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const valuesByDefinition = new Map(
    workspace.response.tasks[0].personValues.map((value) => [value.propertyDefinitionId, value]),
  );
  assert.deepEqual(valuesByDefinition.get(sourcePropertyDefinitionId).principalIds, []);
  assert.deepEqual(valuesByDefinition.get(copied.response.definition.propertyDefinitionId).people, [
    {
      displayName: 'Historical assignee',
      eligible: false,
      principalId: assigneePrincipalId,
      status: 'archived',
    },
  ]);
  assert.deepEqual(
    valuesByDefinition.get(blank.response.definition.propertyDefinitionId).principalIds,
    [],
  );

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      propertyDefinitionId: copied.response.definition.propertyDefinitionId,
    },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
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
      propertyDefinitionId: copied.response.definition.propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));

  const hardDeleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 3,
      taskId,
      transition: 'hardDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(hardDeleted._tag, 'OperationSucceeded', JSON.stringify(hardDeleted));
  assert.equal(hardDeleted.response.retentionState, 'hardDeleted');
});

test('Person writes enforce Mandatory, authorization, stale revisions, metadata evidence, and no notification', async () => {
  const operationContext = await createOperationIdentity();
  const firstPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Sensitive first assignee',
  });
  const secondPrincipalId = await createDirectoryPerson(operationContext, {
    displayName: 'Sensitive second assignee',
  });
  const { collectionId, definition, task } =
    await createCollectionTaskAndPersonDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;

  const viewerWrite = await runAction({
    options: {
      authorizationChecker: authorizationForRole('Viewer'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: 1,
      principalIds: [firstPrincipalId],
      propertyDefinitionId,
      taskId,
    },
    registration: updatePersonPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(viewerWrite._tag, 'OperationAuthorizationDenied', JSON.stringify(viewerWrite));

  const [beforeOutbox] = await sqlClient`
    select count(*)::integer as count
    from core.outbox_messages
    where tenant_id = ${operationContext.tenantId}
  `;
  const userWrite = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User'),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      expectedRevision: 1,
      principalIds: [firstPrincipalId],
      propertyDefinitionId,
      taskId,
    },
    registration: updatePersonPropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(userWrite._tag, 'OperationSucceeded', JSON.stringify(userWrite));
  const [afterOutbox] = await sqlClient`
    select count(*)::integer as count
    from core.outbox_messages
    where tenant_id = ${operationContext.tenantId}
  `;
  assert.equal(afterOutbox.count, beforeOutbox.count);

  const stale = await updatePersonValue({
    collectionId,
    expectedRevision: 1,
    operationContext,
    principalIds: [secondPrincipalId],
    propertyDefinitionId,
    taskId,
  });
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updatePersonPropertyValue.stale_or_missing');
  const afterStale = await readWorkspace(operationContext, collectionId);
  assert.equal(afterStale._tag, 'OperationSucceeded', JSON.stringify(afterStale));
  assert.deepEqual(afterStale.response.tasks[0].personValues[0].principalIds, [firstPrincipalId]);

  const mandatoryDefinition = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Mandatory reviewer' },
    registration: createPersonPropertyDefinitionActionRegistration,
  });
  assert.equal(mandatoryDefinition._tag, 'OperationSucceeded', JSON.stringify(mandatoryDefinition));
  const mandatoryEmpty = await updatePersonValue({
    collectionId,
    expectedRevision: 1,
    operationContext,
    principalIds: [],
    propertyDefinitionId: mandatoryDefinition.response.definition.propertyDefinitionId,
    taskId,
  });
  assert.equal(mandatoryEmpty._tag, 'OperationDomainRejected', JSON.stringify(mandatoryEmpty));
  assert.equal(mandatoryEmpty.code, 'ticketing.updatePersonPropertyValue.mandatory_empty');

  const [persistedEvidence] = await sqlClient`
    select evidence_json as evidence
    from core.audit_events
    where tenant_id = ${operationContext.tenantId}
      and event_type = 'action.succeeded'
      and target_resource_id = ${taskId}
      and target_resource_type = 'task'
    order by occurred_at desc, audit_event_id desc
    limit 1
  `;
  const { evidence } = persistedEvidence;
  assert.deepEqual(evidence, {
    changedComponents: ['personValue'],
    collectionId,
    datatype: 'person',
    operation: 'changed',
    propertyDefinitionId,
    revision: 2,
    taskId,
    taskRevision: 2,
  });
  assert.equal(JSON.stringify(evidence).includes(firstPrincipalId), false);
  assert.equal(JSON.stringify(evidence).includes('Sensitive first assignee'), false);
});
