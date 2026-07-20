import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { createTextPropertyDefinitionActionRegistration } from '../src/actions/create-text-property-definition.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { updateTextPropertyValueActionRegistration } from '../src/actions/update-text-property-value.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_text_values where tenant_id = ${tenantId}`;
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
    values (${'Text tenant'}, ${`text-${suffix}`}, ${'en-GB'}, ${'active'})
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
      ${'Text legal entity'},
      ${'CZ'},
      ${`text-${suffix}`},
      ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Text editor'}, ${'human'}, ${'active'})
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

const createCollectionTaskAndTextDefinition = async (operationContext, name = 'Notes') => {
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
    registration: createTextPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition, task };
};

test('an Editor creates Text and a User saves formatted multiline content through public contracts', async () => {
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
    payload: { collectionId, mandatory: false, name: 'Notes' },
    registration: createTextPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  assert.deepEqual(definition.response.definition, {
    datatype: 'text',
    hidden: false,
    mandatory: false,
    name: 'Notes',
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    revision: 1,
  });

  const emptyWorkspace = await readWorkspace(operationContext, collectionId);
  assert.equal(emptyWorkspace._tag, 'OperationSucceeded', JSON.stringify(emptyWorkspace));
  assert.deepEqual(emptyWorkspace.response.tasks[0].textValues, [
    {
      document: null,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      readableText: null,
      revision: 1,
    },
  ]);

  const document = {
    content: [
      { marks: [{ type: 'bold' }], text: 'Release', type: 'text' },
      { type: 'lineBreak' },
      {
        marks: [
          { type: 'italic' },
          { type: 'underline' },
          { type: 'strikethrough' },
          { type: 'code' },
          { color: '#112233', type: 'foregroundColor' },
          { color: '#ddeeff', type: 'backgroundColor' },
          { href: 'https://example.com/runbook', type: 'link' },
        ],
        text: 'ready',
        type: 'text',
      },
    ],
    type: 'textDocument',
  };
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document,
      expectedRevision: 1,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));
  assert.deepEqual(updated.response, {
    taskRevision: 2,
    value: {
      document,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      readableText: 'Release\nready',
      revision: 2,
    },
  });

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].textValues, [updated.response.value]);
});

test('whitespace is Empty while an equation or opaque Core Reference alone is non-empty', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndTextDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const { taskId } = task.response.task;
  const update = (expectedRevision, document) =>
    runRegisteredAction({
      operationContext,
      payload: { collectionId, document, expectedRevision, propertyDefinitionId, taskId },
      registration: updateTextPropertyValueActionRegistration,
    });

  const whitespace = await update(1, {
    content: [
      { marks: [], text: '  ', type: 'text' },
      { type: 'lineBreak' },
      { marks: [], text: '\t', type: 'text' },
    ],
    type: 'textDocument',
  });
  assert.equal(whitespace._tag, 'OperationSucceeded', JSON.stringify(whitespace));
  assert.deepEqual(whitespace.response.value, {
    document: null,
    propertyDefinitionId,
    readableText: null,
    revision: 1,
  });

  const equationDocument = {
    content: [{ expression: 'x² + y²', type: 'equation' }],
    type: 'textDocument',
  };
  const equation = await update(1, equationDocument);
  assert.equal(equation._tag, 'OperationSucceeded', JSON.stringify(equation));
  assert.deepEqual(equation.response.value, {
    document: equationDocument,
    propertyDefinitionId,
    readableText: 'x² + y²',
    revision: 2,
  });

  const referenceDocument = {
    content: [
      {
        reference: {
          entityId: 'business-entity-42',
          entityType: 'customer',
          kind: 'mention',
          lastResolvedLabel: '@Žaneta',
          ownerModuleKey: 'crm',
          targetTenantId: randomUUID(),
          token: 'opaque-core-reference-token',
        },
        type: 'reference',
      },
    ],
    type: 'textDocument',
  };
  const reference = await update(2, referenceDocument);
  assert.equal(reference._tag, 'OperationSucceeded', JSON.stringify(reference));
  assert.deepEqual(reference.response.value, {
    document: referenceDocument,
    propertyDefinitionId,
    readableText: '@Žaneta',
    revision: 3,
  });

  const guessedRawId = structuredClone(referenceDocument);
  guessedRawId.content[0].reference.token = '   ';
  const rejected = await update(3, guessedRawId);
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.updateTextPropertyValue.invalid_reference');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].textValues, [reference.response.value]);
});

test('Text search uses readable content with locale case folding and diacritic sensitivity', async () => {
  const { queryTaskPropertyValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-property-values.ts');
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: formattedTask,
  } = await createCollectionTaskAndTextDefinition(operationContext);
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created.response.task;
  };
  const unaccentedTask = await createTask();
  const fallbackReferenceTask = await createTask();
  const { propertyDefinitionId } = definition.response.definition;
  const update = (taskId, document) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        document,
        expectedRevision: 1,
        propertyDefinitionId,
        taskId,
      },
      registration: updateTextPropertyValueActionRegistration,
    });

  const seeded = await Promise.all([
    update(formattedTask.response.task.taskId, {
      content: [{ marks: [{ type: 'bold' }], text: 'ČAJ', type: 'text' }],
      type: 'textDocument',
    }),
    update(unaccentedTask.taskId, {
      content: [{ marks: [], text: 'caj', type: 'text' }],
      type: 'textDocument',
    }),
    update(fallbackReferenceTask.taskId, {
      content: [
        {
          reference: {
            entityId: 'deleted-entity',
            entityType: 'customer',
            kind: 'relation',
            lastResolvedLabel: 'c\u030Caj',
            ownerModuleKey: 'crm',
            targetTenantId: randomUUID(),
            token: 'opaque-deleted-reference',
          },
          type: 'reference',
        },
      ],
      type: 'textDocument',
    }),
  ]);
  assert.equal(
    seeded.every((result) => result._tag === 'OperationSucceeded'),
    true,
    JSON.stringify(seeded),
  );

  const searched = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      propertyDefinitionId,
      query: { datatype: 'text', operation: { query: 'čaj', type: 'search' } },
    },
    registration: queryTaskPropertyValuesDataAccessRegistration,
    resultCount: (response) => response.taskIds.length,
    transport: { headers: new Headers() },
  });

  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(
    searched.response.taskIds,
    [formattedTask.response.task.taskId, fallbackReferenceTask.taskId].toSorted(),
  );
});

test('Text filters implement positive, negative, equality, boundary, and Empty membership', async () => {
  const { queryTaskPropertyValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-property-values.ts');
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: alphaTask,
  } = await createCollectionTaskAndTextDefinition(operationContext);
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created.response.task;
  };
  const gammaTask = await createTask();
  const emptyTask = await createTask();
  const { propertyDefinitionId } = definition.response.definition;
  const update = (taskId, text) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        document: {
          content: [{ marks: [], text, type: 'text' }],
          type: 'textDocument',
        },
        expectedRevision: 1,
        propertyDefinitionId,
        taskId,
      },
      registration: updateTextPropertyValueActionRegistration,
    });
  const seeded = await Promise.all([
    update(alphaTask.response.task.taskId, 'Alpha Beta'),
    update(gammaTask.taskId, 'Gamma'),
  ]);
  assert.equal(
    seeded.every((result) => result._tag === 'OperationSucceeded'),
    true,
    JSON.stringify(seeded),
  );

  const filter = async (operator, value) => {
    const result = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId,
        query: {
          datatype: 'text',
          operation: {
            operator,
            type: 'filter',
            ...(value === undefined ? {} : { value }),
          },
        },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
    return result.response.taskIds;
  };
  const alphaTaskId = alphaTask.response.task.taskId;
  const negativeExpected = [emptyTask.taskId, gammaTask.taskId].toSorted();

  assert.deepEqual(await filter('contains', 'BETA'), [alphaTaskId]);
  assert.deepEqual(await filter('doesNotContain', 'beta'), negativeExpected);
  assert.deepEqual(await filter('equals', 'alpha beta'), [alphaTaskId]);
  assert.deepEqual(await filter('doesNotEqual', 'Alpha Beta'), negativeExpected);
  assert.deepEqual(await filter('startsWith', 'ALPHA'), [alphaTaskId]);
  assert.deepEqual(await filter('endsWith', 'beta'), [alphaTaskId]);
  assert.deepEqual(await filter('isEmpty'), [emptyTask.taskId]);
  assert.deepEqual(await filter('isNotEmpty'), [alphaTaskId, gammaTask.taskId].toSorted());
});

test('Text sorting and grouping use locale equality, stable identities, and Empty-last ordering', async () => {
  const { queryTaskPropertyValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-property-values.ts');
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: firstAlphaTask,
  } = await createCollectionTaskAndTextDefinition(operationContext);
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created.response.task;
  };
  const secondAlphaTask = await createTask();
  const betaTask = await createTask();
  const emptyTask = await createTask();
  const { propertyDefinitionId } = definition.response.definition;
  const update = (taskId, text) =>
    runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        document: {
          content: [{ marks: [], text, type: 'text' }],
          type: 'textDocument',
        },
        expectedRevision: 1,
        propertyDefinitionId,
        taskId,
      },
      registration: updateTextPropertyValueActionRegistration,
    });
  const alphaTasks = [firstAlphaTask.response.task.taskId, secondAlphaTask.taskId].toSorted();
  const labelsByTaskId = new Map([
    [firstAlphaTask.response.task.taskId, 'Alpha'],
    [secondAlphaTask.taskId, 'aLPHa'],
  ]);
  const seeded = await Promise.all([
    update(firstAlphaTask.response.task.taskId, 'Alpha'),
    update(secondAlphaTask.taskId, 'aLPHa'),
    update(betaTask.taskId, 'Beta'),
  ]);
  assert.equal(
    seeded.every((result) => result._tag === 'OperationSucceeded'),
    true,
    JSON.stringify(seeded),
  );

  const query = async (operation) => {
    const result = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId,
        query: { datatype: 'text', operation },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
    return result.response;
  };

  const ascending = await query({ direction: 'ascending', type: 'sort' });
  assert.deepEqual(ascending.taskIds, [...alphaTasks, betaTask.taskId, emptyTask.taskId]);
  const descending = await query({ direction: 'descending', type: 'sort' });
  assert.deepEqual(descending.taskIds, [betaTask.taskId, ...alphaTasks, emptyTask.taskId]);
  const grouped = await query({ type: 'group' });
  assert.deepEqual(grouped.groups, [
    {
      heading: labelsByTaskId.get(alphaTasks[0]),
      taskIds: alphaTasks,
    },
    { heading: 'Beta', taskIds: [betaTask.taskId] },
    { heading: null, taskIds: [emptyTask.taskId] },
  ]);
});

test('Text queries retain the Task Collection locale independently of later tenant defaults', async () => {
  const { queryTaskPropertyValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-property-values.ts');
  const operationContext = await createOperationIdentity();
  await sqlClient`
    update core.tenants
    set default_locale = 'tr'
    where tenant_id = ${operationContext.tenantId}
  `;
  const { collectionId, definition, task } =
    await createCollectionTaskAndTextDefinition(operationContext);
  await sqlClient`
    update core.tenants
    set default_locale = 'en-GB'
    where tenant_id = ${operationContext.tenantId}
  `;
  const { propertyDefinitionId } = definition.response.definition;
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document: {
        content: [{ marks: [], text: 'I', type: 'text' }],
        type: 'textDocument',
      },
      expectedRevision: 1,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const searched = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: {
      collectionId,
      propertyDefinitionId,
      query: { datatype: 'text', operation: { query: 'ı', type: 'search' } },
    },
    registration: queryTaskPropertyValuesDataAccessRegistration,
    resultCount: (response) => response.taskIds.length,
    transport: { headers: new Headers() },
  });
  assert.equal(searched._tag, 'OperationSucceeded', JSON.stringify(searched));
  assert.deepEqual(searched.response.taskIds, [task.response.task.taskId]);
});

test('Text matching delegates locale-specific case equivalence to collection collation', async () => {
  const { queryTaskPropertyValuesDataAccessRegistration } =
    await import('../src/data-access/query-task-property-values.ts');
  const operationContext = await createOperationIdentity();
  await sqlClient`
    update core.tenants
    set default_locale = 'el'
    where tenant_id = ${operationContext.tenantId}
  `;
  const { collectionId, definition, task } =
    await createCollectionTaskAndTextDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const updated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document: {
        content: [{ marks: [], text: 'ΟΣ', type: 'text' }],
        type: 'textDocument',
      },
      expectedRevision: 1,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(updated._tag, 'OperationSucceeded', JSON.stringify(updated));

  const query = async (operation) => {
    const result = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId,
        query: { datatype: 'text', operation },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
    assert.equal(result._tag, 'OperationSucceeded', JSON.stringify(result));
    return result.response.taskIds;
  };
  const expected = [task.response.task.taskId];
  assert.deepEqual(await query({ query: 'οσ', type: 'search' }), expected);
  assert.deepEqual(await query({ operator: 'contains', type: 'filter', value: 'οσ' }), expected);
  assert.deepEqual(await query({ operator: 'equals', type: 'filter', value: 'οσ' }), expected);
  assert.deepEqual(await query({ operator: 'startsWith', type: 'filter', value: 'οσ' }), expected);
  assert.deepEqual(await query({ operator: 'endsWith', type: 'filter', value: 'οσ' }), expected);
});

test('Text duplication copies only Mandatory configuration and creates independent Empty values', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndTextDefinition(operationContext);
  const sourcePropertyDefinitionId = definition.response.definition.propertyDefinitionId;
  const sourceDocument = {
    content: [{ marks: [], text: 'Private source content', type: 'text' }],
    type: 'textDocument',
  };
  const savedSource = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document: sourceDocument,
      expectedRevision: 1,
      propertyDefinitionId: sourcePropertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(savedSource._tag, 'OperationSucceeded', JSON.stringify(savedSource));
  const configured = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: 1,
      hidden: true,
      mandatory: true,
      name: 'Notes',
      propertyDefinitionId: sourcePropertyDefinitionId,
    },
    registration: configureTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(configured._tag, 'OperationSucceeded', JSON.stringify(configured));

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: configured.response.definition.revision,
      propertyDefinitionId: sourcePropertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));
  assert.deepEqual(duplicated.response.definition, {
    datatype: 'text',
    hidden: false,
    mandatory: true,
    name: 'Notes Copy',
    propertyDefinitionId: duplicated.response.definition.propertyDefinitionId,
    revision: 1,
  });

  const duplicatedPropertyDefinitionId = duplicated.response.definition.propertyDefinitionId;
  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].textValues, [
    savedSource.response.value,
    {
      document: null,
      propertyDefinitionId: duplicatedPropertyDefinitionId,
      readableText: null,
      revision: 1,
    },
  ]);

  const duplicateDocument = {
    content: [{ marks: [], text: 'Independent duplicate', type: 'text' }],
    type: 'textDocument',
  };
  const changedDuplicate = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document: duplicateDocument,
      expectedRevision: 1,
      propertyDefinitionId: duplicatedPropertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(changedDuplicate._tag, 'OperationSucceeded', JSON.stringify(changedDuplicate));
  const independent = await readWorkspace(operationContext, collectionId);
  assert.equal(independent._tag, 'OperationSucceeded', JSON.stringify(independent));
  assert.deepEqual(independent.response.tasks[0].textValues, [
    savedSource.response.value,
    changedDuplicate.response.value,
  ]);
});

test('a submitted edit rejects an Empty Mandatory Text value without changing committed state', async () => {
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
    payload: { collectionId, mandatory: true, name: 'Summary' },
    registration: createTextPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  const { propertyDefinitionId } = definition.response.definition;

  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      document: {
        content: [{ marks: [], text: ' \n ', type: 'text' }],
        type: 'textDocument',
      },
      expectedRevision: 1,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: updateTextPropertyValueActionRegistration,
  });
  assert.equal(rejected._tag, 'OperationDomainRejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'ticketing.updateTextPropertyValue.mandatory_empty');

  const workspace = await readWorkspace(operationContext, collectionId);
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].textValues, [
    { document: null, propertyDefinitionId, readableText: null, revision: 1 },
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, 1);
});

test('Text Action descriptors expose revisions and identifiers without rich-text content', () => {
  const createInput = { collectionId: 'collection-1', mandatory: false, name: 'Secret notes' };
  const createResponse = {
    definition: {
      datatype: 'text',
      hidden: false,
      mandatory: false,
      name: 'Secret notes',
      propertyDefinitionId: 'property-1',
      revision: 1,
    },
  };
  const updateInput = {
    collectionId: 'collection-1',
    document: {
      content: [{ marks: [], text: 'Private customer detail', type: 'text' }],
      type: 'textDocument',
    },
    expectedRevision: 1,
    propertyDefinitionId: 'property-1',
    taskId: 'task-1',
  };
  const updateResponse = {
    taskRevision: 2,
    value: {
      document: updateInput.document,
      propertyDefinitionId: 'property-1',
      readableText: 'Private customer detail',
      revision: 2,
    },
  };

  const createEvidence =
    createTextPropertyDefinitionActionRegistration.descriptor.auditEvent.evidence(
      createInput,
      createResponse,
    );
  const updateEvidence = updateTextPropertyValueActionRegistration.descriptor.auditEvent.evidence(
    updateInput,
    updateResponse,
  );
  assert.deepEqual(createEvidence, {
    changedComponents: ['definition'],
    collectionId: 'collection-1',
    datatype: 'text',
    operation: 'created',
    propertyDefinitionId: 'property-1',
    revision: 1,
  });
  assert.deepEqual(updateEvidence, {
    changedComponents: ['textValue'],
    collectionId: 'collection-1',
    datatype: 'text',
    operation: 'changed',
    propertyDefinitionId: 'property-1',
    revision: 2,
    taskId: 'task-1',
    taskRevision: 2,
  });
  assert.equal(JSON.stringify({ createEvidence, updateEvidence }).includes('Secret notes'), false);
  assert.equal(
    JSON.stringify({ createEvidence, updateEvidence }).includes('Private customer detail'),
    false,
  );
  assert.deepEqual(
    createTextPropertyDefinitionActionRegistration.descriptor.domainEvent.payload(
      createInput,
      createResponse,
    ),
    createEvidence,
  );
  assert.deepEqual(
    updateTextPropertyValueActionRegistration.descriptor.domainEvent.payload(
      updateInput,
      updateResponse,
    ),
    updateEvidence,
  );
});
