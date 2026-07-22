import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { db, sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { observeCoreActionEvidence } from '@app/core-runtime/testing/evidence-observer';
import { allowPolicy } from '../../../packages/core-runtime/src/policy.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { createIdPropertyDefinitionActionRegistration } from '../src/actions/create-id-property-definition.ts';
import { configureIdPropertyPrefixActionRegistration } from '../src/actions/configure-id-property-prefix.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { duplicateTaskActionRegistration } from '../src/actions/duplicate-task.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
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

const runRegisteredAction = ({ clock, operationContext, payload, policyChecks, registration }) =>
  runAction({
    options: {
      authorizationChecker: allowedAuthorization,
      ...(clock === undefined ? {} : { clock }),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration: policyChecks === undefined ? registration : { ...registration, policyChecks },
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

const createTask = async (operationContext, collectionId, clock) => {
  const result = await runRegisteredAction({
    clock,
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  return result.response.task;
};

const synchronizedPolicyGate = (participantCount) => {
  const release = Promise.withResolvers();
  let arrived = 0;
  return async () => {
    arrived += 1;
    if (arrived === participantCount) {
      release.resolve();
    }
    await release.promise;
    return allowPolicy({
      policyKey: 'ticketing.test.concurrent-id-activation',
      reason: 'Release ID activation and Task creation at the same public Action boundary.',
    });
  };
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

const transitionTasks = async (operationContext, collectionId, taskTransitions) => {
  const results = await Promise.all(
    taskTransitions.map(([task, transition]) =>
      runRegisteredAction({
        operationContext,
        payload: { collectionId, expectedRevision: 1, taskId: task.taskId, transition },
        registration: transitionTaskRetentionActionRegistration,
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
  }
};

test('activating ID backfills every retained Task in deterministic creation order', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const laterClock = { now: () => new Date('2026-07-21T10:00:00.000Z') };
  const earlierClock = { now: () => new Date('2026-07-21T09:00:00.000Z') };
  const createdFirstAtLaterTime = await createTask(operationContext, collectionId, laterClock);
  const archived = await createTask(operationContext, collectionId, earlierClock);
  const softDeleted = await createTask(operationContext, collectionId, earlierClock);

  await transitionTasks(operationContext, collectionId, [
    [archived, 'archive'],
    [softDeleted, 'softDelete'],
  ]);

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
      taskId: archived.taskId,
    },
    {
      idAssignment: {
        displayValue: 'Work-2',
        number: '2',
        propertyDefinitionId: activated.response.definition.propertyDefinitionId,
      },
      taskId: softDeleted.taskId,
    },
    {
      idAssignment: {
        displayValue: 'Work-3',
        number: '3',
        propertyDefinitionId: activated.response.definition.propertyDefinitionId,
      },
      taskId: createdFirstAtLaterTime.taskId,
    },
  ]);
  assert.deepEqual(
    workspace.response.idGroups,
    assignments.map(({ idAssignment, taskId }) => ({
      number: idAssignment.number,
      taskIds: [taskId],
    })),
  );

  const checkbox = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'Done' },
    registration: createCheckboxPropertyDefinitionActionRegistration,
  });
  assert.equal(checkbox._tag, 'OperationSucceeded', JSON.stringify(checkbox));
  const edited = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      propertyDefinitionId: checkbox.response.definition.propertyDefinitionId,
      taskId: archived.taskId,
      value: true,
    },
    registration: updateCheckboxPropertyValueActionRegistration,
  });
  assert.equal(edited._tag, 'OperationSucceeded', JSON.stringify(edited));
  const afterOrdinaryEdit = await readWorkspace(operationContext, collectionId);
  assert.equal(afterOrdinaryEdit._tag, 'OperationSucceeded', JSON.stringify(afterOrdinaryEdit));
  assert.equal(
    afterOrdinaryEdit.response.tasks.find(({ taskId }) => taskId === archived.taskId).idAssignment
      .number,
    '1',
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

test('ID activation serializes with concurrent Task creation without gaps', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const taskCount = 4;
  const gate = synchronizedPolicyGate(taskCount + 1);
  const activation = runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: false, name: 'ID', prefix: '' },
    policyChecks: [gate],
    registration: createIdPropertyDefinitionActionRegistration,
  });
  const creations = Array.from({ length: taskCount }, () =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId },
      policyChecks: [gate],
      registration: createTaskActionRegistration,
    }),
  );
  const [activationResult, ...creationResults] = await Promise.all([activation, ...creations]);

  assert.equal(activationResult._tag, 'OperationSucceeded', JSON.stringify(activationResult));
  assert.equal(
    creationResults.every((result) => result._tag === 'OperationSucceeded'),
    true,
    JSON.stringify(creationResults),
  );
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks.map(({ idAssignment }) => idAssignment.number),
    ['1', '2', '3', '4'],
  );
});

test('a rolled-back Task creation does not consume an ID number', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));

  const rolledBackRegistration = {
    ...createTaskActionRegistration,
    descriptor: {
      ...createTaskActionRegistration.descriptor,
      domainEvent: {
        ...createTaskActionRegistration.descriptor.domainEvent,
        payload: () => {
          throw new Error('force rollback after allocation');
        },
      },
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
      expectedRevision: 1,
      propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationDomainRejected', JSON.stringify(duplicated));
  assert.equal(duplicated.code, 'ticketing.duplicateTaskPropertyDefinition.id_not_duplicable');
});

test('confirmed ID deletion removes every retained assignment and reactivation starts a fresh namespace at 1', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const active = await createTask(operationContext, collectionId);
  const archived = await createTask(operationContext, collectionId);
  const softDeleted = await createTask(operationContext, collectionId);
  const hardDeleted = await createTask(operationContext, collectionId);
  const activation = await activateId(operationContext, collectionId, { prefix: 'OLD' });
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));

  await transitionTasks(operationContext, collectionId, [
    [archived, 'archive'],
    [softDeleted, 'softDelete'],
    [hardDeleted, 'hardDelete'],
  ]);

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
  assert.equal(impact.response.impactCount, 3);

  const deleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: 3,
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
  assert.equal(
    afterDeletion.response.propertyDefinitions.some(({ datatype }) => datatype === 'id'),
    false,
  );

  const activationInvocationId = activation.context.actionInvocation?.actionInvocationId;
  const deletionInvocationId = deleted.context.actionInvocation?.actionInvocationId;
  assert.ok(activationInvocationId);
  assert.ok(deletionInvocationId);
  const [retainedActivationEvidence, deletionEvidence] = await Promise.all(
    [activationInvocationId, deletionInvocationId].map((actionInvocationId) =>
      observeCoreActionEvidence({
        actionInvocationId,
        db,
        tenantId: operationContext.tenantId,
      }),
    ),
  );
  const persistedActivationEvidence = retainedActivationEvidence.auditEvents.find(
    ({ eventType }) => eventType === 'action.succeeded',
  )?.evidence;
  assert.deepEqual(persistedActivationEvidence, {
    changedComponents: ['definition', 'idAssignments'],
    collectionId,
    datatype: 'id',
    operation: 'created',
    propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    revision: 1,
  });
  assert.deepEqual(retainedActivationEvidence.domainEvents, [
    {
      eventType: 'ticketing.taskPropertyDefinition.created',
      payload: persistedActivationEvidence,
    },
  ]);
  const persistedDeletionEvidence = deletionEvidence.auditEvents.find(
    ({ eventType }) => eventType === 'action.succeeded',
  )?.evidence;
  assert.deepEqual(persistedDeletionEvidence, {
    changedComponents: ['definition', 'idPrefix', 'idAssignments', 'idSequence'],
    collectionId,
    datatype: 'id',
    impactCount: 3,
    operation: 'deleted',
    propertyDefinitionId: activation.response.definition.propertyDefinitionId,
    revision: 1,
  });
  assert.deepEqual(deletionEvidence.domainEvents, [
    {
      eventType: 'ticketing.taskPropertyDefinition.deleted',
      payload: persistedDeletionEvidence,
    },
  ]);
  const evidenceText = JSON.stringify({ persistedDeletionEvidence, retainedActivationEvidence });
  assert.equal(evidenceText.includes('OLD'), false);
  assert.equal(evidenceText.includes(active.taskId), false);
  assert.equal(evidenceText.includes(archived.taskId), false);
  assert.equal(evidenceText.includes(softDeleted.taskId), false);
  assert.equal(evidenceText.includes(hardDeleted.taskId), false);

  const reactivated = await activateId(operationContext, collectionId, { prefix: 'NEW' });
  assert.equal(reactivated._tag, 'OperationSucceeded', JSON.stringify(reactivated));
  assert.notEqual(
    reactivated.response.definition.propertyDefinitionId,
    activation.response.definition.propertyDefinitionId,
  );
  const nextTask = await createTask(operationContext, collectionId);
  const afterReactivation = await readWorkspace(operationContext, collectionId);
  assert.equal(afterReactivation._tag, 'OperationSucceeded', JSON.stringify(afterReactivation));
  assert.deepEqual(
    afterReactivation.response.tasks.map((task) => task.idAssignment.displayValue),
    ['NEW-1', 'NEW-2', 'NEW-3', 'NEW-4'],
  );
  assert.deepEqual(
    afterReactivation.response.tasks.map(({ taskId }) => taskId),
    [active.taskId, archived.taskId, softDeleted.taskId, nextTask.taskId],
  );
});

test('soft delete and restore retain an assignment while Task duplication allocates a fresh one', async () => {
  const operationContext = await createOperationIdentity();
  const collectionId = await createCollection(operationContext);
  const activation = await activateId(operationContext, collectionId);
  assert.equal(activation._tag, 'OperationSucceeded', JSON.stringify(activation));
  const source = await createTask(operationContext, collectionId);

  const softDeleted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      taskId: source.taskId,
      transition: 'softDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(softDeleted._tag, 'OperationSucceeded', JSON.stringify(softDeleted));
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
