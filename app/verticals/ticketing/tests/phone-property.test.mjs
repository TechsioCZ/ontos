import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createEmailPropertyDefinitionActionRegistration } from '../src/actions/create-email-property-definition.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { createPhonePropertyDefinitionActionRegistration } from '../src/actions/create-phone-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updatePhonePropertyValueActionRegistration } from '../src/actions/update-phone-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_phone_values where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_email_values where tenant_id = ${tenantId}`;
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
    values (${'Phone tenant'}, ${`phone-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    ) values (
      ${tenant.tenant_id}, ${'Phone legal entity'}, ${'CZ'}, ${`phone-${suffix}`}, ${'active'}
    ) returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Phone editor'}, ${'human'}, ${'active'})
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

const allowedAuthorization = () => ({ _tag: 'Allowed' });
const authorizationForRole =
  (role, checks = []) =>
  (check) => {
    checks.push(check);
    const permissions = {
      User: ['edit_task_property_values', 'view_task_properties'],
      Viewer: ['view_task_properties'],
    };
    return permissions[role].includes(check.permission)
      ? { _tag: 'Allowed' }
      : { _tag: 'Denied', message: `${role} lacks ${check.permission}.` };
  };
const operationContextResolver = (operationContext) => () => ({
  _tag: 'Success',
  operationContext,
});
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

const createPhoneFixture = async ({ mandatory = false } = {}) => {
  const operationContext = await createOperationIdentity();
  const collection = await runRegisteredAction({
    operationContext,
    payload: { name: 'Test Collection' },
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
    payload: { collectionId, mandatory, name: 'Direct line' },
    registration: createPhonePropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition, operationContext, task };
};

test('a Phone value preserves non-normalized text exactly through the public action/read seam', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();

  const exactValue = '  +420 (777) 123-456, ext. 42  ';
  const saved = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: exactValue,
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(saved._tag, 'OperationSucceeded', JSON.stringify(saved));
  assert.equal(saved.response.value.value, exactValue);
  const savedRevision = saved.response.value.revision;

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, [
    {
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      revision: savedRevision,
      value: exactValue,
    },
  ]);
});

test('invalid Phone input is rejected atomically without truncating or replacing the committed value', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const exactLimitValue = '📞'.repeat(256);
  const accepted = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId,
      value: exactLimitValue,
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));
  const acceptedRevision = accepted.response.value.revision;

  const rejectedInputs = await Promise.all(
    [
      '📞'.repeat(257),
      'line\t42',
      'line\n42',
      'line\r42',
      'line\u000042',
      'line\u007F42',
      'line\u202842',
      'line\u202942',
    ].map((invalid) =>
      runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: acceptedRevision,
          propertyDefinitionId,
          taskId,
          value: invalid,
        },
        registration: updatePhonePropertyValueActionRegistration,
      }),
    ),
  );
  for (const rejected of rejectedInputs) {
    assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  }

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, [
    { propertyDefinitionId, revision: acceptedRevision, value: exactLimitValue },
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, 2);
});

test('Unicode-whitespace-only clears Phone sparsely and stale writes cannot restore the old value', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, expectedRevision, propertyDefinitionId, taskId, value },
      registration: updatePhonePropertyValueActionRegistration,
    });

  const populated = await update(0, '555 / 123');
  assert.equal(populated._tag, 'OperationSucceeded', JSON.stringify(populated));
  const populatedRevision = populated.response.value.revision;
  const cleared = await update(populatedRevision, '\u2003\u00A0');
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  assert.equal(cleared.response.value, null);
  assert.equal(cleared.response.taskRevision, 3);

  const stale = await update(populatedRevision, 'old draft');
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));
  assert.equal(stale.code, 'ticketing.updatePhonePropertyValue.stale_or_missing');
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, []);
  assert.equal(workspace.response.tasks[0].taskRevision, 3);
});

test('a sparse clear and reinsert cannot revive an old matching Phone revision', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, value) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, expectedRevision, propertyDefinitionId, taskId, value },
      registration: updatePhonePropertyValueActionRegistration,
    });

  const original = await update(0, 'original');
  assert.equal(original._tag, 'OperationSucceeded', JSON.stringify(original));
  const originalRevision = original.response.value.revision;
  const cleared = await update(originalRevision, null);
  assert.equal(cleared._tag, 'OperationSucceeded', JSON.stringify(cleared));
  const replacement = await update(0, 'replacement');
  assert.equal(replacement._tag, 'OperationSucceeded', JSON.stringify(replacement));
  assert.ok(replacement.response.value.revision > originalRevision);

  const stale = await update(originalRevision, 'old draft');
  assert.equal(stale._tag, 'OperationDomainRejected', JSON.stringify(stale));

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.equal(workspace.response.tasks[0].phoneValues[0].value, 'replacement');
});

test('a Phone edit is rejected while another Mandatory Email property is Empty', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const mandatoryEmail = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Required email' },
    registration: createEmailPropertyDefinitionActionRegistration,
  });
  assert.equal(mandatoryEmail._tag, 'OperationSucceeded', JSON.stringify(mandatoryEmail));

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '+420 777 123 456',
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.taskEdit.mandatory_email_empty');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, []);
  assert.equal(workspace.response.tasks[0].taskRevision, 1);
});

test('a Mandatory Phone rejects clearing without changing the committed value', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture({
    mandatory: true,
  });
  const {
    response: { definition: createdDefinition },
  } = definition;
  const {
    response: { task: createdTask },
  } = task;
  const { propertyDefinitionId } = createdDefinition;
  const { taskId } = createdTask;
  const populated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId,
      value: '+420 777 123 456',
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(populated._tag, 'OperationSucceeded', JSON.stringify(populated));

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: populated.response.value.revision,
      propertyDefinitionId,
      taskId,
      value: '\u2003\u00A0',
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.updatePhonePropertyValue.mandatory_empty');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, [populated.response.value]);
  assert.equal(workspace.response.tasks[0].taskRevision, populated.response.taskRevision);
});

test('a Phone edit is rejected while another Mandatory Phone remains Empty', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const required = await runRegisteredAction({
    operationContext,
    payload: { collectionId, mandatory: true, name: 'Required direct line' },
    registration: createPhonePropertyDefinitionActionRegistration,
  });
  assert.equal(required._tag, 'OperationSucceeded', JSON.stringify(required));

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      value: '+420 777 123 456',
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.taskEdit.mandatory_phone_empty');
});

test('shared configuration preserves the Phone datatype', async () => {
  const { collectionId, definition, operationContext } = await createPhoneFixture();
  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: definition.response.definition.revision,
      hidden: true,
      mandatory: true,
      name: 'Emergency line',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));
  assert.deepEqual(configured.response.definition, {
    datatype: 'phone',
    hidden: true,
    mandatory: true,
    name: 'Emergency line',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 2,
  });
});

test('accepted Phone Actions persist metadata evidence without Phone content', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const {
    response: { definition: createdDefinition },
  } = definition;
  const {
    response: { task: createdTask },
  } = task;
  const { propertyDefinitionId } = createdDefinition;
  const { taskId } = createdTask;
  const secretValue = '+420 secret content';
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId,
      taskId,
      value: secretValue,
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const createInvocationId = definition.context.actionInvocation.actionInvocationId;
  const updateInvocationId = updated.context.actionInvocation.actionInvocationId;
  const [createAudit] = await sqlClient`
    select audit_profile as "auditProfile", evidence_json as evidence
    from core.audit_events
    where action_invocation_id = ${createInvocationId}
      and event_type = 'action.succeeded'
  `;
  const [createDomain] = await sqlClient`
    select payload_json as payload
    from core.domain_events
    where action_invocation_id = ${createInvocationId}
      and event_type = 'ticketing.taskPropertyDefinition.created'
  `;
  const [updateAudit] = await sqlClient`
    select audit_profile as "auditProfile", evidence_json as evidence
    from core.audit_events
    where action_invocation_id = ${updateInvocationId}
      and event_type = 'action.succeeded'
  `;
  const [updateDomain] = await sqlClient`
    select payload_json as payload
    from core.domain_events
    where action_invocation_id = ${updateInvocationId}
      and event_type = 'ticketing.taskPropertyValue.changed'
  `;

  assert.deepEqual(createAudit.evidence, {
    changedComponents: ['definition'],
    collectionId,
    datatype: 'phone',
    operation: 'created',
    propertyDefinitionId,
    revision: 1,
  });
  assert.deepEqual(createDomain.payload, createAudit.evidence);
  assert.equal(createAudit.auditProfile, 'standard');

  assert.deepEqual(updateAudit.evidence, {
    changedComponents: ['phoneValue'],
    collectionId,
    datatype: 'phone',
    operation: 'changed',
    propertyDefinitionId,
    revision: updated.response.value.revision,
    taskId,
    taskRevision: updated.response.taskRevision,
  });
  assert.deepEqual(updateDomain.payload, updateAudit.evidence);
  assert.equal(updateAudit.auditProfile, 'sensitive');
  assert.equal(JSON.stringify([createAudit, createDomain]).includes('Direct line'), false);
  assert.equal(JSON.stringify([updateAudit, updateDomain]).includes(secretValue), false);
});

test('a User may edit Phone while a Viewer can read but cannot mutate it', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const payload = {
    collectionId,
    expectedRevision: 0,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
    value: '555 / 123',
  };
  const viewerChecks = [];
  const denied = await runAction({
    options: {
      authorizationChecker: authorizationForRole('Viewer', viewerChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration: updatePhonePropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(denied._tag, 'OperationAuthorizationDenied', JSON.stringify(denied));
  assert.equal(viewerChecks[0].permission, 'edit_task_property_values');
  assert.equal(viewerChecks[0].resourceObjectId, `${operationContext.tenantId}_${collectionId}`);

  const userChecks = [];
  const accepted = await runAction({
    options: {
      authorizationChecker: authorizationForRole('User', userChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload,
    registration: updatePhonePropertyValueActionRegistration,
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));
  assert.equal(userChecks[0].permission, 'edit_task_property_values');

  const readChecks = [];
  const viewed = await runDataAccess({
    options: {
      authorizationChecker: authorizationForRole('Viewer', readChecks),
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(viewed._tag, 'OperationSucceeded', JSON.stringify(viewed));
  assert.equal(readChecks[0].permission, 'view_task_properties');
  assert.equal(viewed.response.tasks[0].phoneValues[0].value, '555 / 123');
});

test('Phone duplication optionally snapshots exact values into an independent definition', async () => {
  const { collectionId, definition, operationContext, task } = await createPhoneFixture();
  const sourcePropertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const exactValue = ' +420 (777) 123-456 ';
  const populated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 0,
      propertyDefinitionId: sourcePropertyDefinitionId,
      taskId: task.response.task.taskId,
      value: exactValue,
    },
    registration: updatePhonePropertyValueActionRegistration,
  });
  assert.equal(populated._tag, 'OperationSucceeded', JSON.stringify(populated));
  const sourceRevision = populated.response.value.revision;
  const blankCopy = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: false,
      expectedRevision: 1,
      propertyDefinitionId: sourcePropertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  const valueCopy = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: 1,
      propertyDefinitionId: sourcePropertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(blankCopy._tag, 'OperationSucceeded', JSON.stringify(blankCopy));
  assert.equal(valueCopy._tag, 'OperationSucceeded', JSON.stringify(valueCopy));
  assert.equal(blankCopy.response.definition.name, 'Direct line Copy');
  assert.equal(valueCopy.response.definition.name, 'Direct line Copy 2');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].phoneValues, [
    {
      propertyDefinitionId: sourcePropertyDefinitionId,
      revision: sourceRevision,
      value: exactValue,
    },
    {
      propertyDefinitionId: valueCopy.response.definition.propertyDefinitionId,
      revision: 1,
      value: exactValue,
    },
  ]);
});
