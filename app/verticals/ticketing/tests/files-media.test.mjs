import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import {
  getAuthorizedMediaDownload,
  getMediaUploadPolicy,
} from '../../../packages/core-runtime/src/media.ts';
import { runAction, runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { db, sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { addFilesMediaExternalItemActionRegistration } from '../src/actions/add-files-media-external-item.ts';
import { createFilesMediaPropertyDefinitionActionRegistration } from '../src/actions/create-files-media-property-definition.ts';
import { createIntrinsicPropertyDefinitionActionRegistration } from '../src/actions/create-intrinsic-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { uploadFilesMediaItemActionRegistration } from '../src/actions/upload-files-media-item.ts';
import { uploadFilesMediaItemsActionRegistration } from '../src/actions/upload-files-media-items.ts';
import { reorderFilesMediaItemsActionRegistration } from '../src/actions/reorder-files-media-items.ts';
import { removeFilesMediaItemActionRegistration } from '../src/actions/remove-files-media-item.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { queryTaskPropertyValuesDataAccessRegistration } from '../src/data-access/query-task-property-values.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.outbox_messages where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.media_links where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_files_media_items where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.media_asset_bytes where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.media_assets where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_revisions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.tasks where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_property_definitions where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_schemas where tenant_id = ${tenantId}`;
      await sqlClient`delete from ticketing.task_collections where tenant_id = ${tenantId}`;
    }),
  );
  await sqlClient.end({ timeout: 1 });
});

const allowedAuthorization = () => ({ _tag: 'Allowed' });
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

const createOperationIdentity = async () => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${'Files tenant'}, ${`files-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    )
    values (
      ${tenant.tenant_id}, ${'Files legal entity'}, ${'CZ'}, ${`files-${suffix}`}, ${'active'}
    )
    returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, ${'Files editor'}, ${'human'}, ${'active'})
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
    payload: { collectionId, mandatory: false, name: 'Attachments' },
    registration: createFilesMediaPropertyDefinitionActionRegistration,
  });
  assert.equal(definition._tag, 'OperationSucceeded', JSON.stringify(definition));
  return { collectionId, definition, task };
};

test('Core Media defaults the per-file upload limit to exactly 100 MiB', () => {
  assert.deepEqual(getMediaUploadPolicy({}), { maxBytesPerFile: 104_857_600 });
});

test('Core Media exposes a configured positive integer upload limit', () => {
  assert.deepEqual(getMediaUploadPolicy({ CORE_MEDIA_MAX_UPLOAD_BYTES: '2048' }), {
    maxBytesPerFile: 2048,
  });
});

test('Core Media fails explicitly for every invalid upload-limit configuration', () => {
  for (const configured of ['', 'abc', '1.5', '1e3', ' 2 ', '0', '-1', '9007199254740992']) {
    assert.throws(
      () => getMediaUploadPolicy({ CORE_MEDIA_MAX_UPLOAD_BYTES: configured }),
      (error) =>
        error?.name === 'MediaUploadConfigurationError' &&
        error?.code === 'core.media.upload_limit_invalid',
      configured,
    );
  }
});

test('an Editor uploads one generic download-only item through Ticketing and reads its stable order', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const upload = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: Buffer.from([0, 1, 2, 3]).toString('base64'),
      clientMimeType: 'application/octet-stream',
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'payload',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });

  assert.equal(upload._tag, 'OperationSucceeded', JSON.stringify(upload));
  assert.deepEqual(upload.response.item, {
    access: 'download',
    byteSize: 4,
    displayFilename: 'payload',
    effectiveMimeType: 'application/octet-stream',
    itemId: upload.response.item.itemId,
    mediaAssetId: upload.response.item.mediaAssetId,
    position: 0,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
  });
  assert.equal('previewUrl' in upload.response.item, false);

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [upload.response.item]);
});

test('uploaded and exact external items coexist in one committed order', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const uploaded = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: Buffer.from('uploaded').toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'uploaded.txt',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(uploaded._tag, 'OperationSucceeded', JSON.stringify(uploaded));

  const externalUrl = '  https://example.com/Media/%E2%9C%93?Case=Kept#Part  ';
  const external = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: uploaded.response.taskRevision,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
      url: externalUrl,
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(external._tag, 'OperationSucceeded', JSON.stringify(external));
  assert.deepEqual(external.response.item, {
    access: 'external',
    externalUrl: externalUrl.trim(),
    itemId: external.response.item.itemId,
    position: 1,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
  });

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [
    uploaded.response.item,
    external.response.item,
  ]);
});

test('Files & media item mutations attribute automation to the originating Principal', async () => {
  const originContext = await createOperationIdentity();
  const { collectionId, definition, task } = await createCollectionTaskAndDefinition(originContext);
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
  const [automation] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${originContext.tenantId}, ${'Files automation'}, ${'system'}, ${'active'})
    returning principal_id
  `;
  const automationContext = {
    ...originContext,
    originatingPrincipalId: originContext.principalId,
    principalId: automation.principal_id,
  };
  const { taskId } = task.response.task;
  const { propertyDefinitionId } = definition.response.definition;
  const readLastEditedBy = async () => {
    const workspace = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(originContext),
      },
      payload: { collectionId },
      registration: getTaskPropertyWorkspaceDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
      transport: { headers: new Headers() },
    });
    assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
    return workspace.response.tasks[0].lastEditedBy;
  };
  const expectedAttribution = {
    displayName: 'Files editor',
    inactive: false,
    principalId: originContext.principalId,
  };

  const first = await runRegisteredAction({
    operationContext: automationContext,
    payload: {
      collectionId,
      expectedRevision: task.response.task.revision,
      propertyDefinitionId,
      taskId,
      url: 'https://example.com/first',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(first._tag, 'OperationSucceeded', JSON.stringify(first));
  assert.deepEqual(await readLastEditedBy(), expectedAttribution);

  const second = await runRegisteredAction({
    operationContext: automationContext,
    payload: {
      collectionId,
      expectedRevision: first.response.taskRevision,
      propertyDefinitionId,
      taskId,
      url: 'https://example.com/second',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(second._tag, 'OperationSucceeded', JSON.stringify(second));
  const reordered = await runRegisteredAction({
    operationContext: automationContext,
    payload: {
      collectionId,
      expectedRevision: second.response.taskRevision,
      itemIds: [second.response.item.itemId, first.response.item.itemId],
      propertyDefinitionId,
      taskId,
    },
    registration: reorderFilesMediaItemsActionRegistration,
  });
  assert.equal(reordered._tag, 'OperationSucceeded', JSON.stringify(reordered));
  assert.deepEqual(await readLastEditedBy(), expectedAttribution);

  const removed = await runRegisteredAction({
    operationContext: automationContext,
    payload: {
      collectionId,
      expectedRevision: reordered.response.taskRevision,
      itemId: first.response.item.itemId,
      propertyDefinitionId,
      taskId,
    },
    registration: removeFilesMediaItemActionRegistration,
  });
  assert.equal(removed._tag, 'OperationSucceeded', JSON.stringify(removed));
  assert.deepEqual(await readLastEditedBy(), expectedAttribution);
});

test('a stale single upload preserves the concurrently committed Files & media value', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const committed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: task.response.task.revision,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      url: 'https://example.com/concurrent',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(committed._tag, 'OperationSucceeded', JSON.stringify(committed));

  const stale = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: Buffer.from('stale upload').toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'stale.txt',
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.deepEqual(stale, {
    _tag: 'OperationDomainRejected',
    code: 'ticketing.uploadFilesMediaItem.stale',
    message: 'The Files & media value changed elsewhere.',
  });

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [committed.response.item]);
});

test('reordering a complete mixed Files & media value commits atomically', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const uploaded = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      bytesBase64: Buffer.from('first').toString('base64'),
      expectedRevision: task.response.task.revision,
      filename: 'first.txt',
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(uploaded._tag, 'OperationSucceeded', JSON.stringify(uploaded));
  const external = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: uploaded.response.taskRevision,
      url: 'https://example.com/external',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(external._tag, 'OperationSucceeded', JSON.stringify(external));

  const reordered = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: external.response.taskRevision,
      itemIds: [external.response.item.itemId, uploaded.response.item.itemId],
    },
    registration: reorderFilesMediaItemsActionRegistration,
  });
  assert.equal(reordered._tag, 'OperationSucceeded', JSON.stringify(reordered));
  assert.equal(reordered.response.taskRevision, external.response.taskRevision + 1);

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(
    workspace.response.tasks[0].filesMediaItems.map(({ itemId, position }) => ({
      itemId,
      position,
    })),
    [
      { itemId: external.response.item.itemId, position: 0 },
      { itemId: uploaded.response.item.itemId, position: 1 },
    ],
  );
});

test('removing one Files & media item needs no confirmation and preserves compact order', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const first = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: task.response.task.revision,
      url: 'https://example.com/duplicate',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(first._tag, 'OperationSucceeded', JSON.stringify(first));
  const duplicate = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: first.response.taskRevision,
      url: 'https://example.com/duplicate',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(duplicate._tag, 'OperationSucceeded', JSON.stringify(duplicate));

  const removed = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: duplicate.response.taskRevision,
      itemId: first.response.item.itemId,
    },
    registration: removeFilesMediaItemActionRegistration,
  });
  assert.equal(removed._tag, 'OperationSucceeded', JSON.stringify(removed));
  assert.deepEqual(removed.response, {
    removedItemId: first.response.item.itemId,
    taskRevision: duplicate.response.taskRevision + 1,
  });

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [
    { ...duplicate.response.item, position: 0 },
  ]);
});

test('copying a Files & media value creates new item identities and shares uploaded assets', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const uploaded = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      bytesBase64: Buffer.from('shared bytes').toString('base64'),
      expectedRevision: task.response.task.revision,
      filename: 'shared.bin',
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(uploaded._tag, 'OperationSucceeded', JSON.stringify(uploaded));
  const external = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: uploaded.response.taskRevision,
      url: 'https://example.com/exact?Value=Kept',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(external._tag, 'OperationSucceeded', JSON.stringify(external));

  const duplicated = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      copyValues: true,
      expectedRevision: definition.response.definition.revision,
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    },
    registration: duplicateTaskPropertyDefinitionActionRegistration,
  });
  assert.equal(duplicated._tag, 'OperationSucceeded', JSON.stringify(duplicated));

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  const copiedItems = workspace.response.tasks[0].filesMediaItems.filter(
    ({ propertyDefinitionId }) =>
      propertyDefinitionId === duplicated.response.definition.propertyDefinitionId,
  );
  assert.equal(copiedItems.length, 2);
  assert.deepEqual(
    copiedItems.map(({ access, position }) => ({ access, position })),
    [
      { access: 'download', position: 0 },
      { access: 'external', position: 1 },
    ],
  );
  assert.notEqual(copiedItems[0].itemId, uploaded.response.item.itemId);
  assert.equal(copiedItems[0].mediaAssetId, uploaded.response.item.mediaAssetId);
  assert.notEqual(copiedItems[1].itemId, external.response.item.itemId);
  assert.equal(copiedItems[1].externalUrl, external.response.item.externalUrl);
  assert.equal(workspace.response.tasks[0].taskRevision, external.response.taskRevision);

  const removedSource = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: external.response.taskRevision,
      itemId: uploaded.response.item.itemId,
    },
    registration: removeFilesMediaItemActionRegistration,
  });
  assert.equal(removedSource._tag, 'OperationSucceeded', JSON.stringify(removedSource));
  const retainedAsset = await getAuthorizedMediaDownload(
    { mediaAssetId: uploaded.response.item.mediaAssetId, tenantId: operationContext.tenantId },
    { authorize: () => true, db },
  );
  assert.equal(retainedAsset._tag, 'MediaDownloadReady');
});

test('external items reuse the exact URL contract without reachability or content checks', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    expectedRevision: task.response.task.revision,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const unreachableButValid = await runRegisteredAction({
    operationContext,
    payload: { ...target, url: '  https://never-resolves.invalid/Exact%2FPath  ' },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(unreachableButValid._tag, 'OperationSucceeded', JSON.stringify(unreachableButValid));
  assert.equal(
    unreachableButValid.response.item.externalUrl,
    'https://never-resolves.invalid/Exact%2FPath',
  );

  const invalid = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: unreachableButValid.response.taskRevision,
      url: 'https://user:secret@example.com/file',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(invalid._tag, 'OperationDomainRejected');
  assert.equal(invalid.code, 'ticketing.updateUrlPropertyValue.invalid_url');

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [
    unreachableButValid.response.item,
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, unreachableButValid.response.taskRevision);
});

test('Files & media deletion counts distinct committed Tasks and rejects stale impact', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const first = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: task.response.task.revision,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      url: 'https://example.com/one',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(first._tag, 'OperationSucceeded', JSON.stringify(first));
  const secondItemSameTask = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: first.response.taskRevision,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      url: 'https://example.com/two',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(secondItemSameTask._tag, 'OperationSucceeded', JSON.stringify(secondItemSameTask));

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 1);

  const otherTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(otherTask._tag, 'OperationSucceeded', JSON.stringify(otherTask));
  const otherItem = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: otherTask.response.task.revision,
      propertyDefinitionId,
      taskId: otherTask.response.task.taskId,
      url: 'https://example.com/other',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(otherItem._tag, 'OperationSucceeded', JSON.stringify(otherItem));

  const staleDeletion = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: impact.response.impactCount,
      expectedImpactRevision: impact.response.impactRevision,
      expectedRevision: impact.response.revision,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.deepEqual(staleDeletion, {
    _tag: 'OperationDomainRejected',
    code: 'ticketing.deleteTaskPropertyDefinition.stale_impact',
    message: 'The affected retained Tasks changed. Review the impact and confirm again.',
  });
});

test('Files & media deletion rejects a same-count affected-Task population change', async () => {
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: firstTask,
  } = await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const secondTask = await runRegisteredAction({
    operationContext,
    payload: { collectionId },
    registration: createTaskActionRegistration,
  });
  assert.equal(secondTask._tag, 'OperationSucceeded', JSON.stringify(secondTask));
  const firstItem = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: firstTask.response.task.revision,
      propertyDefinitionId,
      taskId: firstTask.response.task.taskId,
      url: 'https://example.com/first-task',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(firstItem._tag, 'OperationSucceeded', JSON.stringify(firstItem));

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 1);

  const removed = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: firstItem.response.taskRevision,
      itemId: firstItem.response.item.itemId,
      propertyDefinitionId,
      taskId: firstTask.response.task.taskId,
    },
    registration: removeFilesMediaItemActionRegistration,
  });
  assert.equal(removed._tag, 'OperationSucceeded', JSON.stringify(removed));
  const replacement = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: secondTask.response.task.revision,
      propertyDefinitionId,
      taskId: secondTask.response.task.taskId,
      url: 'https://example.com/second-task',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(replacement._tag, 'OperationSucceeded', JSON.stringify(replacement));

  const staleDeletion = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      confirmed: true,
      expectedImpactCount: impact.response.impactCount,
      expectedImpactRevision: impact.response.impactRevision,
      expectedRevision: impact.response.revision,
      propertyDefinitionId,
    },
    registration: deleteTaskPropertyDefinitionActionRegistration,
  });
  assert.deepEqual(staleDeletion, {
    _tag: 'OperationDomainRejected',
    code: 'ticketing.deleteTaskPropertyDefinition.stale_impact',
    message: 'The affected retained Tasks changed. Review the impact and confirm again.',
  });
});

test('Files & media deletion impact includes archived and soft-deleted Tasks but excludes hard-deleted Tasks', async () => {
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: activeTask,
  } = await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created;
  };
  const softDeletedTask = await createTask();
  const hardDeletedTask = await createTask();
  const addItem = async (task, suffix) => {
    const added = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: task.response.task.revision,
        propertyDefinitionId,
        taskId: task.response.task.taskId,
        url: `https://example.com/${suffix}`,
      },
      registration: addFilesMediaExternalItemActionRegistration,
    });
    assert.equal(added._tag, 'OperationSucceeded', JSON.stringify(added));
    return added;
  };
  const activeItem = await addItem(activeTask, 'archived');
  const softDeletedItem = await addItem(softDeletedTask, 'soft-deleted');
  const hardDeletedItem = await addItem(hardDeletedTask, 'hard-deleted');
  const archive = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: activeItem.response.taskRevision,
      taskId: activeTask.response.task.taskId,
      transition: 'archive',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(archive._tag, 'OperationSucceeded', JSON.stringify(archive));
  const softDelete = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: softDeletedItem.response.taskRevision,
      taskId: softDeletedTask.response.task.taskId,
      transition: 'softDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(softDelete._tag, 'OperationSucceeded', JSON.stringify(softDelete));
  const hardDelete = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: hardDeletedItem.response.taskRevision,
      taskId: hardDeletedTask.response.task.taskId,
      transition: 'hardDelete',
    },
    registration: transitionTaskRetentionActionRegistration,
  });
  assert.equal(hardDelete._tag, 'OperationSucceeded', JSON.stringify(hardDelete));

  const impact = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId, propertyDefinitionId },
    registration: getTaskPropertyDeletionImpactDataAccessRegistration,
    resultCount: () => 1,
    transport: { headers: new Headers() },
  });
  assert.equal(impact._tag, 'OperationSucceeded', JSON.stringify(impact));
  assert.equal(impact.response.impactCount, 2);
});

test('Files & media search matches uploaded filenames and exact external URLs', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const uploaded = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: Buffer.from('searchable').toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'Résumé.txt',
      propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(uploaded._tag, 'OperationSucceeded', JSON.stringify(uploaded));
  const external = await runRegisteredAction({
    operationContext,
    payload: {
      collectionId,
      expectedRevision: uploaded.response.taskRevision,
      propertyDefinitionId,
      taskId: task.response.task.taskId,
      url: 'https://example.com/Media?Exact=Yes',
    },
    registration: addFilesMediaExternalItemActionRegistration,
  });
  assert.equal(external._tag, 'OperationSucceeded', JSON.stringify(external));

  const search = (query) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId,
        query: { datatype: 'files_media', operation: { query, type: 'search' } },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
  const filenameResult = await search('RÉSUMÉ');
  assert.equal(filenameResult._tag, 'OperationSucceeded', JSON.stringify(filenameResult));
  assert.deepEqual(filenameResult.response.taskIds, [task.response.task.taskId]);
  const urlResult = await search('EXACT=YES');
  assert.equal(urlResult._tag, 'OperationSucceeded', JSON.stringify(urlResult));
  assert.deepEqual(urlResult.response.taskIds, [task.response.task.taskId]);
  const accentSensitive = await search('resume');
  assert.equal(accentSensitive._tag, 'OperationSucceeded', JSON.stringify(accentSensitive));
  assert.deepEqual(accentSensitive.response.taskIds, []);
});

test('Files & media filters, stored-order sorting, and locale-equal fan-out grouping are observable', async () => {
  const operationContext = await createOperationIdentity();
  const {
    collectionId,
    definition,
    task: taskA,
  } = await createCollectionTaskAndDefinition(operationContext);
  const { propertyDefinitionId } = definition.response.definition;
  const createTask = async () => {
    const created = await runRegisteredAction({
      operationContext,
      payload: { collectionId },
      registration: createTaskActionRegistration,
    });
    assert.equal(created._tag, 'OperationSucceeded', JSON.stringify(created));
    return created;
  };
  const taskB = await createTask();
  const taskC = await createTask();
  const addUrls = async (task, urls) => {
    const { taskId } = task.response.task;
    let { revision } = task.response.task;
    for (const url of urls) {
      // oxlint-disable-next-line no-await-in-loop -- Each append uses the prior committed Task revision.
      const added = await runRegisteredAction({
        operationContext,
        payload: {
          collectionId,
          expectedRevision: revision,
          propertyDefinitionId,
          taskId,
          url,
        },
        registration: addFilesMediaExternalItemActionRegistration,
      });
      assert.equal(added._tag, 'OperationSucceeded', JSON.stringify(added));
      revision = added.response.taskRevision;
    }
  };
  await addUrls(taskA, ['https://example.com/Zulu', 'https://example.com/alpha']);
  await addUrls(taskB, ['https://example.com/Alpha', 'https://example.com/ALPHA']);

  const query = (operation) =>
    runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: {
        collectionId,
        propertyDefinitionId,
        query: { datatype: 'files_media', operation },
      },
      registration: queryTaskPropertyValuesDataAccessRegistration,
      resultCount: (response) => response.taskIds.length,
      transport: { headers: new Headers() },
    });
  const aId = taskA.response.task.taskId;
  const bId = taskB.response.task.taskId;
  const cId = taskC.response.task.taskId;

  const contains = await query({ operator: 'contains', type: 'filter', value: '/ALPHA' });
  assert.equal(contains._tag, 'OperationSucceeded', JSON.stringify(contains));
  assert.deepEqual(contains.response.taskIds, [aId, bId].toSorted());
  const negative = await query({ operator: 'doesNotContain', type: 'filter', value: 'zulu' });
  assert.equal(negative._tag, 'OperationSucceeded', JSON.stringify(negative));
  assert.deepEqual(negative.response.taskIds, [bId, cId].toSorted());
  const empty = await query({ operator: 'isEmpty', type: 'filter' });
  assert.equal(empty._tag, 'OperationSucceeded', JSON.stringify(empty));
  assert.deepEqual(empty.response.taskIds, [cId]);

  const ascending = await query({ direction: 'ascending', type: 'sort' });
  assert.equal(ascending._tag, 'OperationSucceeded', JSON.stringify(ascending));
  assert.deepEqual(ascending.response.taskIds, [bId, aId, cId]);
  const descending = await query({ direction: 'descending', type: 'sort' });
  assert.equal(descending._tag, 'OperationSucceeded', JSON.stringify(descending));
  assert.deepEqual(descending.response.taskIds, [aId, bId, cId]);

  const grouped = await query({ type: 'group' });
  assert.equal(grouped._tag, 'OperationSucceeded', JSON.stringify(grouped));
  const alphaGroup = grouped.response.groups.find(
    ({ heading }) => heading !== null && heading.toLowerCase().endsWith('/alpha'),
  );
  assert.deepEqual(alphaGroup.taskIds, [aId, bId].toSorted());
  assert.deepEqual(grouped.response.groups.find(({ heading }) => heading === null)?.taskIds, [cId]);
});

test('bulk upload reports every file independently and appends successful items in submitted order', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const prior = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      bytesBase64: Buffer.from([9, 8, 7]).toString('base64'),
      expectedRevision: task.response.task.revision,
      filename: 'prior',
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(prior._tag, 'OperationSucceeded', JSON.stringify(prior));

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  const upload = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      expectedRevision: prior.response.taskRevision,
      files: [
        { bytesBase64: Buffer.from('first').toString('base64'), filename: 'first' },
        {
          bytesBase64: png.toString('base64'),
          clientMimeType: 'application/pdf',
          filename: 'rejected.pdf',
        },
        { bytesBase64: Buffer.from('third').toString('base64'), filename: 'third' },
      ],
    },
    registration: uploadFilesMediaItemsActionRegistration,
  });

  assert.equal(upload._tag, 'OperationSucceeded', JSON.stringify(upload));
  assert.deepEqual(upload.response.outcomes, [
    {
      item: upload.response.outcomes[0].item,
      ok: true,
    },
    {
      code: 'core.media.type_mismatch',
      message: 'Detected file content conflicts with a supplied filename extension or MIME type.',
      ok: false,
    },
    {
      item: upload.response.outcomes[2].item,
      ok: true,
    },
  ]);
  assert.equal(upload.response.taskRevision, prior.response.taskRevision + 1);

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [
    prior.response.item,
    upload.response.outcomes[0].item,
    upload.response.outcomes[2].item,
  ]);
  assert.deepEqual(
    workspace.response.tasks[0].filesMediaItems.map(({ position }) => position),
    [0, 1, 2],
  );
});

test('an all-rejected bulk leaves the Files & media value Empty and the Task unchanged', async () => {
  const previous = process.env.CORE_MEDIA_MAX_UPLOAD_BYTES;
  process.env.CORE_MEDIA_MAX_UPLOAD_BYTES = '64';
  try {
    const operationContext = await createOperationIdentity();
    const { collectionId, definition, task } =
      await createCollectionTaskAndDefinition(operationContext);
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const upload = await runRegisteredAction({
      operationContext,
      payload: {
        collectionId,
        expectedRevision: task.response.task.revision,
        files: [
          { bytesBase64: 'not-canonical-base64', filename: 'staged' },
          { bytesBase64: Buffer.alloc(65).toString('base64'), filename: 'oversized' },
          {
            bytesBase64: png.toString('base64'),
            clientMimeType: 'application/pdf',
            filename: 'mismatched.pdf',
          },
        ],
        propertyDefinitionId: definition.response.definition.propertyDefinitionId,
        taskId: task.response.task.taskId,
      },
      registration: uploadFilesMediaItemsActionRegistration,
    });

    assert.equal(upload._tag, 'OperationSucceeded', JSON.stringify(upload));
    assert.deepEqual(upload.response, {
      outcomes: [
        {
          code: 'ticketing.uploadFilesMediaItems.invalid_bytes',
          message: 'Uploaded bytes must use canonical base64 encoding.',
          ok: false,
        },
        {
          code: 'core.media.upload_too_large',
          message: 'The upload exceeds the 64 byte per-file limit.',
          ok: false,
        },
        {
          code: 'core.media.type_mismatch',
          message:
            'Detected file content conflicts with a supplied filename extension or MIME type.',
          ok: false,
        },
      ],
      taskRevision: task.response.task.revision,
    });

    const workspace = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: getTaskPropertyWorkspaceDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
      transport: { headers: new Headers() },
    });
    assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
    assert.deepEqual(workspace.response.tasks[0].filesMediaItems, []);
    assert.equal(workspace.response.tasks[0].taskRevision, task.response.task.revision);
  } finally {
    if (previous === undefined) {
      delete process.env.CORE_MEDIA_MAX_UPLOAD_BYTES;
    } else {
      process.env.CORE_MEDIA_MAX_UPLOAD_BYTES = previous;
    }
  }
});

test('a stale bulk upload preserves the currently committed Files & media items', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const target = {
    collectionId,
    expectedRevision: task.response.task.revision,
    propertyDefinitionId: definition.response.definition.propertyDefinitionId,
    taskId: task.response.task.taskId,
  };
  const committed = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      files: [{ bytesBase64: Buffer.from('committed').toString('base64'), filename: 'committed' }],
    },
    registration: uploadFilesMediaItemsActionRegistration,
  });
  assert.equal(committed._tag, 'OperationSucceeded', JSON.stringify(committed));

  const stale = await runRegisteredAction({
    operationContext,
    payload: {
      ...target,
      files: [{ bytesBase64: Buffer.from('stale').toString('base64'), filename: 'stale' }],
    },
    registration: uploadFilesMediaItemsActionRegistration,
  });
  assert.deepEqual(stale, {
    _tag: 'OperationDomainRejected',
    code: 'ticketing.uploadFilesMediaItems.stale',
    message: 'The Files & media value changed elsewhere.',
  });

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [
    committed.response.outcomes[0].item,
  ]);
  assert.equal(workspace.response.tasks[0].taskRevision, committed.response.taskRevision);
});

test('Core Media accepts positively detected content when the filename agrees and MIME is absent', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  const upload = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: png.toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'diagram.png',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });

  assert.equal(upload._tag, 'OperationSucceeded', JSON.stringify(upload));
  assert.equal(upload.response.item.effectiveMimeType, 'image/png');
});

test('a positive content mismatch rejects the action and commits no Files & media item', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  const rejected = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: png.toString('base64'),
      clientMimeType: 'application/pdf',
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'invoice.pdf',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.deepEqual(rejected, {
    _tag: 'OperationDomainRejected',
    code: 'core.media.type_mismatch',
    message: 'Detected file content conflicts with a supplied filename extension or MIME type.',
  });

  const docxExtensionMismatch = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: png.toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'invoice.docx',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(docxExtensionMismatch._tag, 'OperationDomainRejected');
  assert.equal(docxExtensionMismatch.code, 'core.media.type_mismatch');

  const workspace = await runDataAccess({
    options: {
      authorizationChecker: allowedAuthorization,
      operationContextResolver: operationContextResolver(operationContext),
    },
    payload: { collectionId },
    registration: getTaskPropertyWorkspaceDataAccessRegistration,
    resultCount: (response) => response.tasks.length,
    transport: { headers: new Headers() },
  });
  assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
  assert.deepEqual(workspace.response.tasks[0].filesMediaItems, []);
});

test('Core Media accepts exactly the effective limit and rejects the next byte independently', async () => {
  const previous = process.env.CORE_MEDIA_MAX_UPLOAD_BYTES;
  process.env.CORE_MEDIA_MAX_UPLOAD_BYTES = '4';
  try {
    const operationContext = await createOperationIdentity();
    const { collectionId, definition, task } =
      await createCollectionTaskAndDefinition(operationContext);
    const payload = {
      clientMimeType: 'application/octet-stream',
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'payload',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    };
    const accepted = await runRegisteredAction({
      operationContext,
      payload: { ...payload, bytesBase64: Buffer.alloc(4).toString('base64') },
      registration: uploadFilesMediaItemActionRegistration,
    });
    assert.equal(accepted._tag, 'OperationSucceeded', JSON.stringify(accepted));

    const rejected = await runRegisteredAction({
      operationContext,
      payload: {
        ...payload,
        bytesBase64: Buffer.alloc(5).toString('base64'),
        expectedRevision: accepted.response.taskRevision,
      },
      registration: uploadFilesMediaItemActionRegistration,
    });
    assert.equal(rejected._tag, 'OperationDomainRejected');
    assert.equal(rejected.code, 'core.media.upload_too_large');

    const workspace = await runDataAccess({
      options: {
        authorizationChecker: allowedAuthorization,
        operationContextResolver: operationContextResolver(operationContext),
      },
      payload: { collectionId },
      registration: getTaskPropertyWorkspaceDataAccessRegistration,
      resultCount: (response) => response.tasks.length,
      transport: { headers: new Headers() },
    });
    assert.equal(workspace._tag, 'OperationSucceeded', JSON.stringify(workspace));
    assert.deepEqual(workspace.response.tasks[0].filesMediaItems, [accepted.response.item]);
  } finally {
    if (previous === undefined) {
      delete process.env.CORE_MEDIA_MAX_UPLOAD_BYTES;
    } else {
      process.env.CORE_MEDIA_MAX_UPLOAD_BYTES = previous;
    }
  }
});

test('Core Media authorizes download-only access and exposes no preview result', async () => {
  const operationContext = await createOperationIdentity();
  const { collectionId, definition, task } =
    await createCollectionTaskAndDefinition(operationContext);
  const bytes = Buffer.from([9, 8, 7]);
  const upload = await runRegisteredAction({
    operationContext,
    payload: {
      bytesBase64: bytes.toString('base64'),
      collectionId,
      expectedRevision: task.response.task.revision,
      filename: 'artifact',
      propertyDefinitionId: definition.response.definition.propertyDefinitionId,
      taskId: task.response.task.taskId,
    },
    registration: uploadFilesMediaItemActionRegistration,
  });
  assert.equal(upload._tag, 'OperationSucceeded', JSON.stringify(upload));

  const denied = await getAuthorizedMediaDownload(
    { mediaAssetId: upload.response.item.mediaAssetId, tenantId: operationContext.tenantId },
    { authorize: () => false, db },
  );
  assert.deepEqual(denied, { _tag: 'MediaDownloadDenied' });

  const allowed = await getAuthorizedMediaDownload(
    { mediaAssetId: upload.response.item.mediaAssetId, tenantId: operationContext.tenantId },
    { authorize: () => true, db },
  );
  assert.equal(allowed._tag, 'MediaDownloadReady');
  assert.deepEqual(allowed.download, {
    bytes,
    contentDisposition: 'attachment',
    displayFilename: 'artifact',
    mimeType: 'application/octet-stream',
  });
  assert.equal('preview' in allowed, false);
  assert.equal('previewUrl' in allowed.download, false);
});
