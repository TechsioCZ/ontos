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
import { createFilesMediaPropertyDefinitionActionRegistration } from '../src/actions/create-files-media-property-definition.ts';
import { uploadFilesMediaItemActionRegistration } from '../src/actions/upload-files-media-item.ts';
import { uploadFilesMediaItemsActionRegistration } from '../src/actions/upload-files-media-items.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';

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
      payload: { ...payload, bytesBase64: Buffer.alloc(5).toString('base64') },
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
