// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  removeFilesMediaItemActionKey,
  removeFilesMediaItemActionPayloadSchema,
  removeFilesMediaItemActionResponseSchema,
} from '../../shared/actions/remove-files-media-item.ts';
import type {
  RemoveFilesMediaItemActionPayload,
  RemoveFilesMediaItemActionResponse,
} from '../../shared/actions/remove-files-media-item.ts';

interface RemovedRow {
  readonly position: number;
}

interface TaskRow {
  readonly taskRevision: number;
}

const evidence = (
  input: RemoveFilesMediaItemActionPayload,
  response: RemoveFilesMediaItemActionResponse,
) => ({
  changedComponents: ['filesMediaItems'],
  collectionId: input.collectionId,
  itemId: input.itemId,
  operation: 'itemRemoved',
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
  RemoveFilesMediaItemActionPayload,
  RemoveFilesMediaItemActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  RemoveFilesMediaItemActionPayload,
  RemoveFilesMediaItemActionResponse
>;

const handler: ActionHandler<
  RemoveFilesMediaItemActionPayload,
  RemoveFilesMediaItemActionResponse
> = async (input, services) => {
  const selectedTask = await services.tx.execute(sql`
    select task.revision as "taskRevision"
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
  const task = rowsFromResult<TaskRow>(selectedTask).at(0);
  if (task === undefined) {
    throw rejectAction({
      code: 'ticketing.removeFilesMediaItem.target_missing',
      message: 'The Task or Files & media Task Property Definition was not found.',
    });
  }
  if (task.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.removeFilesMediaItem.stale',
      message: 'The Files & media value changed elsewhere.',
    });
  }

  const removed = await services.tx.execute(sql`
    delete from ticketing.task_files_media_items as item
    where item.item_id = ${input.itemId}
      and item.task_id = ${input.taskId}
      and item.property_definition_id = ${input.propertyDefinitionId}
      and item.tenant_id = ${services.context.tenantId}
    returning item.position
  `);
  const item = rowsFromResult<RemovedRow>(removed).at(0);
  if (item === undefined) {
    throw rejectAction({
      code: 'ticketing.removeFilesMediaItem.item_missing',
      message: 'The Files & media item is no longer available.',
    });
  }
  await services.tx.execute(sql`
    update ticketing.task_files_media_items as item
    set position = item.position - 1
    where item.task_id = ${input.taskId}
      and item.property_definition_id = ${input.propertyDefinitionId}
      and item.tenant_id = ${services.context.tenantId}
      and item.position > ${item.position}
  `);

  const changedAt = services.clock.now().toISOString();
  const updated = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = ${changedAt}::timestamptz,
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
      select updated_task.last_edited_at, ${services.context.principalId},
        'files_media_value_changed', updated_task.revision, updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select updated_task.revision as "taskRevision"
    from updated_task
    inner join created_revision using (task_id)
  `);
  const result = rowsFromResult<TaskRow>(updated).at(0);
  if (result === undefined) {
    throw rejectAction({
      code: 'ticketing.removeFilesMediaItem.not_committed',
      message: 'The Files & media item removal could not be committed.',
    });
  }
  return { removedItemId: input.itemId, taskRevision: result.taskRevision };
};

export const removeFilesMediaItemActionRegistration: ActionRegistration<
  RemoveFilesMediaItemActionPayload,
  RemoveFilesMediaItemActionResponse
> = {
  descriptor: {
    actionKey: removeFilesMediaItemActionKey,
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
    transportRequestSchema: removeFilesMediaItemActionPayloadSchema,
    transportResponseSchema: removeFilesMediaItemActionResponseSchema,
  },
  handler,
};
