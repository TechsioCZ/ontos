// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import {
  MediaUploadConfigurationError,
  MediaUploadRejectedError,
  rejectAction,
  rowsFromResult,
} from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  uploadFilesMediaItemsActionKey,
  uploadFilesMediaItemsActionPayloadSchema,
  uploadFilesMediaItemsActionResponseSchema,
} from '../../shared/actions/upload-files-media-items.ts';
import type {
  FilesMediaUploadOutcome,
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse,
} from '../../shared/actions/upload-files-media-items.ts';
import {
  commitFilesMediaItem,
  InvalidFilesMediaUploadBytesError,
} from '../files-media-item-commit.ts';

interface TargetRow {
  readonly nextPosition: number;
  readonly taskId: string;
  readonly taskRevision: number;
}

interface UpdatedTaskRow {
  readonly taskRevision: number;
}

const successfulItems = (response: UploadFilesMediaItemsActionResponse) =>
  response.outcomes.flatMap((outcome) => (outcome.ok ? [outcome.item] : []));

const evidence = (
  input: UploadFilesMediaItemsActionPayload,
  response: UploadFilesMediaItemsActionResponse,
) => {
  const items = successfulItems(response);
  return {
    changedComponents: ['filesMediaItems'],
    collectionId: input.collectionId,
    committedItemCount: items.length,
    committedItemIds: items.map(({ itemId }) => itemId),
    operation: 'bulkUploaded',
    propertyDefinitionId: input.propertyDefinitionId,
    rejectedFileCount: response.outcomes.length - items.length,
    submittedFileCount: response.outcomes.length,
    taskId: input.taskId,
    taskRevision: response.taskRevision,
  };
};

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse
>;

const uploadRejected = (code: string, message: string): FilesMediaUploadOutcome => ({
  code,
  message,
  ok: false,
});

const handler: ActionHandler<
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse
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
      task.task_id as "taskId",
      task.revision as "taskRevision"
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
      code: 'ticketing.uploadFilesMediaItems.target_missing',
      message: 'The Task or Files & media Task Property Definition was not found.',
    });
  }
  if (target.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.uploadFilesMediaItems.stale',
      message: 'The Files & media value changed elsewhere.',
    });
  }

  const outcomes: FilesMediaUploadOutcome[] = [];
  let committedItemCount = 0;
  for (const file of input.files) {
    let outcome: FilesMediaUploadOutcome;
    const position = target.nextPosition + committedItemCount;
    try {
      // The lock-held savepoints preserve submitted order and isolate a failed file's writes.
      // oxlint-disable-next-line no-await-in-loop
      outcome = await services.tx.transaction(async (tx) => {
        const item = await commitFilesMediaItem(
          {
            ...file,
            position,
            propertyDefinitionId: input.propertyDefinitionId,
            taskId: input.taskId,
          },
          { context: services.context, tx },
        );
        return { item, ok: true } as const;
      });
    } catch (error) {
      if (error instanceof MediaUploadConfigurationError) {
        throw error;
      }
      if (error instanceof InvalidFilesMediaUploadBytesError) {
        outcome = uploadRejected(
          'ticketing.uploadFilesMediaItems.invalid_bytes',
          'Uploaded bytes must use canonical base64 encoding.',
        );
      } else if (error instanceof MediaUploadRejectedError) {
        outcome = uploadRejected(error.code, error.message);
      } else {
        outcome = uploadRejected(
          'ticketing.uploadFilesMediaItems.file_failed',
          'The file could not be committed.',
        );
      }
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      committedItemCount += 1;
    }
  }

  if (committedItemCount === 0) {
    services.markNoOp();
    return { outcomes, taskRevision: target.taskRevision };
  }

  const updated = await services.tx.execute(sql`
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
  const task = rowsFromResult<UpdatedTaskRow>(updated).at(0);
  if (task === undefined) {
    throw rejectAction({
      code: 'ticketing.uploadFilesMediaItems.not_committed',
      message: 'The Files & media items could not be committed.',
    });
  }

  return { outcomes, taskRevision: task.taskRevision };
};

export const uploadFilesMediaItemsActionRegistration: ActionRegistration<
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse
> = {
  descriptor: {
    actionKey: uploadFilesMediaItemsActionKey,
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
    transportRequestSchema: uploadFilesMediaItemsActionPayloadSchema,
    transportResponseSchema: uploadFilesMediaItemsActionResponseSchema,
  },
  handler,
};
