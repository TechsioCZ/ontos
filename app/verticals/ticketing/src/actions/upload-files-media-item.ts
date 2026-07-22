// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import { MediaUploadRejectedError, rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  uploadFilesMediaItemActionKey,
  uploadFilesMediaItemActionPayloadSchema,
  uploadFilesMediaItemActionResponseSchema,
} from '../../shared/actions/upload-files-media-item.ts';
import type {
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse,
} from '../../shared/actions/upload-files-media-item.ts';
import {
  commitFilesMediaItem,
  InvalidFilesMediaUploadBytesError,
} from '../files-media-item-commit.ts';

interface ItemRow {
  readonly taskRevision: number;
}

interface TargetRow {
  readonly nextPosition: number;
  readonly taskId: string;
}

const evidence = (
  input: UploadFilesMediaItemActionPayload,
  response: UploadFilesMediaItemActionResponse,
) => ({
  changedComponents: ['filesMediaItems'],
  collectionId: input.collectionId,
  itemId: response.item.itemId,
  operation: 'uploaded',
  propertyDefinitionId: input.propertyDefinitionId,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse
>;

const handler: ActionHandler<
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse
> = async (input, services) => {
  const selected = await services.tx.execute(sql`
    select
      coalesce((
        select max(item.position) + 1
        from ticketing.task_files_media_items as item
        where item.task_id = task.task_id
          and item.property_definition_id = definition.property_definition_id
          and item.tenant_id = task.tenant_id
      ), 0)::integer as "nextPosition",
      task.task_id as "taskId"
    from ticketing.tasks as task
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.schema_id = schema.schema_id
      and definition.tenant_id = schema.tenant_id
      and definition.datatype = 'files_media'
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
      and definition.property_definition_id = ${input.propertyDefinitionId}
    for update of task
  `);
  const target = rowsFromResult<TargetRow>(selected).at(0);
  if (target === undefined) {
    throw rejectAction({
      code: 'ticketing.uploadFilesMediaItem.target_missing',
      message: 'The Task or Files & media Task Property Definition was not found.',
    });
  }

  let committedItem;
  try {
    committedItem = await commitFilesMediaItem(
      {
        bytesBase64: input.bytesBase64,
        ...(input.clientMimeType === undefined ? {} : { clientMimeType: input.clientMimeType }),
        filename: input.filename,
        position: target.nextPosition,
        propertyDefinitionId: input.propertyDefinitionId,
        taskId: input.taskId,
      },
      { context: services.context, tx: services.tx },
    );
  } catch (error) {
    if (error instanceof InvalidFilesMediaUploadBytesError) {
      throw rejectAction({
        code: 'ticketing.uploadFilesMediaItem.invalid_bytes',
        message: 'Uploaded bytes must use canonical base64 encoding.',
      });
    }
    if (error instanceof MediaUploadRejectedError) {
      throw rejectAction({ code: error.code, message: error.message });
    }
    throw error;
  }

  const result = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = statement_timestamp(),
        last_edited_by_principal_id = ${services.context.principalId},
        revision = task.revision + 1
      where task.task_id = ${input.taskId}
        and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select
        updated_task.last_edited_at,
        ${services.context.principalId},
        'files_media_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select updated_task.revision as "taskRevision"
    from updated_task
    inner join created_revision using (task_id)
  `);
  const item = rowsFromResult<ItemRow>(result).at(0);
  if (item === undefined) {
    throw rejectAction({
      code: 'ticketing.uploadFilesMediaItem.not_committed',
      message: 'The Files & media item could not be committed.',
    });
  }
  return {
    item: committedItem,
    taskRevision: item.taskRevision,
  };
};

export const uploadFilesMediaItemActionRegistration: ActionRegistration<
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse
> = {
  descriptor: {
    actionKey: uploadFilesMediaItemActionKey,
    auditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: uploadFilesMediaItemActionPayloadSchema,
    transportResponseSchema: uploadFilesMediaItemActionResponseSchema,
  },
  handler,
};
