import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createIdPropertyDefinitionActionRegistration } from '../src/actions/create-id-property-definition.ts';
import { configureIdPropertyPrefixActionRegistration } from '../src/actions/configure-id-property-prefix.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { duplicateTaskActionRegistration } from '../src/actions/duplicate-task.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';

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
      await sqlClient`delete from ticketing.task_id_assignments where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_id_sequences where tenant_id = ${tenantId}`;
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
    values (${'ID property tenant'}, ${`id-property-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'ID property legal entity'},
      ${'CZ'},
      ${`id-property-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'ID property editor'}, ${'human'}, ${'active'})
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

const createCollection = async (operationContext) => {
  const result = await runRegisteredAction({
    operationContext,
    payload: {},
    registration: createTaskCollectionActionRegistration,
  });
  assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  return result.response.collection.collectionId;
};

const createTask = async (operationContext, collectionId) => {
  const result = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  return result.response.task;
};

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

const activateId = (operationContext, collectionId, overrides = {}) =>
  runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      mandatory: false,
      name: 'ID',
      prefix: '',
      ...overrides,
    },
    registration: createIdPropertyDefinitionActionRegistration,
  });

test('activating ID backfills every retained Task in deterministic creation order', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const oldest = await createTask(operationContext, collectionId);
  const archived = await createTask(operationContext, collectionId);
  const softDeleted = await createTask(operationContext, collectionId);

  const transitions = await Promise.all(
    [
      [archived, 'archive'],
      [softDeleted, 'softDelete'],
    ].map(([task, transition]) =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId, expectedRevision: 1, taskId: task.taskId, transition },
        registration: transitionTaskRetentionActionRegistration,
      }),
    ),
  );
  for (const transitioned of transitions) {
    assert.equal(transitioned._tag, 'OperationSucceeded', JSON.stringify(transitioned));
  }

  const activated = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: '  Identifier  ', prefix: '  Work  ' },
    registration: createIdPropertyDefinitionActionRegistration,
  });

  assert.equal(activated._tag, 'OperationSucceeded', JSON.stringify(activated));
  assert.deepEqual(activated.response.definition, {
    datatype: 'id',
    hidden: false,
    mandatory: true,
    name: 'Identifier',
    prefix: 'Work',
    propertyDefinitionId: activated.response.definition.propertyDefinitionId,
    revision: 1,
  });

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const assignments = workspace.response.tasks.map(({ idAssignment, taskId }) => ({
    idAssignment,
    taskId,
  }));
  assert.deepEqual(assignments, [
    {
      idAssignment: {
        displayValue: 'Work-1',
        number: '1',
        propertyDefinitionId: activated.response.definition.propertyDefinitionId,
      },
      taskId: oldest.taskId,
    },
    {
      idAssignment: {
        displayValue: 'Work-2',
        number: '2',
        propertyDefinitionId: activated.response.definition.propertyDefinitionId,
      },
      taskId: archived.taskId,
    },
    {
      idAssignment: {
        displayValue: 'Work-3',
        number: '3',
        propertyDefinitionId: activated.response.definition.propertyDefinitionId,
      },
      taskId: softDeleted.taskId,
    },
  ]);
  assert.deepEqual(
    workspace.response.idGroups,
    assignments.map(({ idAssignment, taskId }) => ({
      number: idAssignment.number,
      taskIds: [taskId],
    })),
  );
});

test('concurrent Task creation allocates unique consecutive IDs isolated by collection', async () => {
  const operationContext = await createOperationIdentity();
  const firstCollectionId = await createCollection(operationContext);
  const secondCollectionId = await createCollection(operationContext);
  const firstActivation = await activateId(operationContext, firstCollectionId);
  const secondActivation = await activateId(operationContext, secondCollectionId);
  assert.equal(firstActivation._tag, 'OperationSucceeded', JSON.stringify(firstActivation));
  assert.equal(secondActivation._tag, 'OperationSucceeded', JSON.stringify(secondActivation));

  const firstCollectionCreations = await Promise.all(
    Array.from({ length: 8 }, () => createTask(operationContext, firstCollectionId)),
  );
  const secondCollectionTask = await createTask(operationContext, secondCollectionId);

  const firstWorkspace = await readWorkspace(operationContext, firstCollectionId);
  const secondWorkspace = await readWorkspace(operationContext, secondCollectionId);
  assert.equal(firstWorkspace._tag, 'OperationSucceeded', JSON.stringify(firstWorkspace));
  assert.equal(secondWorkspace._tag, 'OperationSucceeded', JSON.stringify(secondWorkspace));
  assert.deepEqual(
    firstWorkspace.response.tasks.map((task) => task.idAssignment.number),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
  assert.deepEqual(
    new Set(firstWorkspace.response.tasks.map((task) => task.taskId)),
    new Set(firstCollectionCreations.map((task) => task.taskId)),
  );
  assert.equal(secondWorkspace.response.tasks[0].taskId, secondCollectionTask.taskId);
  assert.equal(secondWorkspace.response.tasks[0].idAssignment.number, '1');
});

test('a rolled-back Task creation does not consume an ID number', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));

  const rolledBackRegistration = {
    ...createTaskActionRegistration,
    handler: async (...arguments_) => {
      await createTaskActionRegistration.handler(...arguments_);
      throw new Error('force rollback after allocation');
    },
  };
  const rolledBack = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: rolledBackRegistration,
  });
  assert.equal(rolledBack._tag, 'OperationExecutionFailed', JSON.stringify(rolledBack));

  const created = await createTask(operationContext, collectionId);
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks.length, 1);
  assert.equal(workspace.response.tasks[0].taskId, created.taskId);
  assert.equal(workspace.response.tasks[0].idAssignment.number, '1');
});

test('prefix configuration is trimmed presentation only', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId, { prefix: 'OLD' });
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));
  await createTask(operationContext, collectionId);

  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      prefix: '  MixedCase  ',
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: configureIdPropertyPrefixActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.equal(configured.response.definition.prefix, 'MixedCase');
  assert.equal(configured.response.definition.revision, 2);

  const schemaConfigured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      hidden: true,
      mandatory: true,
      name: '  Identifier  ',
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(schemaConfigured._tag, 'OperationSucceeded', JSON.stringify(schemaConfigured));
  assert.equal(schemaConfigured.response.definition.prefix, 'MixedCase');
  assert.equal(schemaConfigured.response.definition.revision, 3);

  const withPrefix = await readWorkspace(operationContext, collectionId);
  assert.equal(withPrefix._tag, 'OperationSucceeded', JSON.stringify(withPrefix));
  assert.equal(withPrefix.response.tasks[0].idAssignment.number, '1');
  assert.equal(withPrefix.response.tasks[0].idAssignment.displayValue, 'MixedCase-1');

  const cleared = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 3,
      prefix: '   ',
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: configureIdPropertyPrefixActionRegistration,
  });
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  const withoutPrefix = await readWorkspace(operationContext, collectionId);
  assert.equal(withoutPrefix._tag, 'OperationSucceeded', JSON.stringify(withoutPrefix));
  assert.equal(withoutPrefix.response.tasks[0].idAssignment.number, '1');
  assert.equal(withoutPrefix.response.tasks[0].idAssignment.displayValue, '1');
});

test('ID is a singleton definition and rejects definition duplication', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));

  const secondActivation = await activateId(operationContext, collectionId, { name: 'Other ID' });
  assert.equal(secondActivation._tag, 'OperationDomainRejected', JSON.stringify(secondActivation));
  assert.equal(secondActivation.code, 'ticketing.createIdPropertyDefinition.not_created');

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: 1,
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationDomainRejected', JSON.stringify(duplicated));
  assert.equal(duplicated.code, 'ticketing.duplicateTaskPropertyDefinition.id_not_duplicable');
});

test('confirmed ID deletion removes its namespace and reactivation deterministically starts at 1', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  await createTask(operationContext, collectionId);
  await createTask(operationContext, collectionId);
  const activation = await activateId(operationContext, collectionId, { prefix: 'OLD' });
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 2);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 2,
      expectedRevision: 1,
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(deleted._tag, 'OperationSucceeded', JSON.stringify(deleted));
  const afterDeletion = await readWorkspace(operationContext, collectionId);
  assert.equal(afterDeletion._tag, 'OperationSucceeded', JSON.stringify(afterDeletion));
  assert.equal(
    afterDeletion.response.tasks.every((task) => task.idAssignment === undefined),
    true,
  );

  const reactivated = await activateId(operationContext, collectionId, { prefix: 'NEW' });
  assert.equal(reactivated._tag, 'OperationSucceeded', JSON.stringify(reactivated));
  const nextTask = await createTask(operationContext, collectionId);
  const afterReactivation = await readWorkspace(operationContext, collectionId);
  assert.equal(afterReactivation._tag, 'OperationSucceeded', JSON.stringify(afterReactivation));
  assert.deepEqual(
    afterReactivation.response.tasks.map((task) => task.idAssignment.displayValue),
    ['NEW-1', 'NEW-2', 'NEW-3'],
  );
  assert.equal(afterReactivation.response.tasks[2].taskId, nextTask.taskId);
});

test('archive and restore retain an assignment while Task duplication allocates a fresh one', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));
  const source = await createTask(operationContext, collectionId);

  const archived = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      taskId: source.taskId,
      transition: 'archive',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(archived._tag, 'OperationSucceeded', JSON.stringify(archived));
  const restored = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 2,
      taskId: source.taskId,
      transition: 'restore',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(restored._tag, 'OperationSucceeded', JSON.stringify(restored));

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: { collectionId, sourceTaskId: source.taskId },
    registration: duplicateTaskActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks.map(({ idAssignment, taskId }) => ({
      number: idAssignment.number,
      taskId,
    })),
    [
      { number: '1', taskId: source.taskId },
      { number: '2', taskId: duplicated.response.task.taskId },
    ],
  );
});

test('hard-deleting a Task does not make its consumed ID reusable', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));
  const first = await createTask(operationContext, collectionId);

  const hardDeleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      taskId: first.taskId,
      transition: 'hardDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(hardDeleted._tag, 'OperationSucceeded', JSON.stringify(hardDeleted));
  const second = await createTask(operationContext, collectionId);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks.length, 1);
  assert.equal(workspace.response.tasks[0].taskId, second.taskId);
  assert.equal(workspace.response.tasks[0].idAssignment.number, '2');
});

test('retrying Task creation through the idempotency contract does not allocate twice', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));
  const idempotencyKey = randomUUID();
  const create = () =>
    runAction({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: createTaskActionRegistration,
      transport: { headers: new Headers({ 'Idempotency-Key': idempotencyKey }) },
    });

  const first = await create();
  const retried = await create();
  assert.equal(first._tag, 'OperationSucceeded', JSON.stringify(first));
  assert.equal(retried._tag, 'OperationIdempotencyReplayUnavailable', JSON.stringify(retried));
  await createTask(operationContext, collectionId);

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks.map((task) => task.idAssignment.number),
    ['1', '2'],
  );
});
