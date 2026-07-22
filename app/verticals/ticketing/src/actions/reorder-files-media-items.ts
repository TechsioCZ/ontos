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
  reorderFilesMediaItemsActionKey,
  reorderFilesMediaItemsActionPayloadSchema,
  reorderFilesMediaItemsActionResponseSchema,
} from '../../shared/actions/reorder-files-media-items.ts';
import type {
  ReorderFilesMediaItemsActionPayload,
  ReorderFilesMediaItemsActionResponse,
} from '../../shared/actions/reorder-files-media-items.ts';

interface ItemRow {
  readonly itemId: string;
}

interface TaskRow {
  readonly taskRevision: number;
}

const evidence = (
  input: ReorderFilesMediaItemsActionPayload,
  response: ReorderFilesMediaItemsActionResponse,
) => ({
  changedComponents: ['filesMediaItems'],
  collectionId: input.collectionId,
  itemCount: input.itemIds.length,
  operation: 'reordered',
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
  ReorderFilesMediaItemsActionPayload,
  ReorderFilesMediaItemsActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  ReorderFilesMediaItemsActionPayload,
  ReorderFilesMediaItemsActionResponse
>;

const handler: ActionHandler<
  ReorderFilesMediaItemsActionPayload,
  ReorderFilesMediaItemsActionResponse
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
      code: 'ticketing.reorderFilesMediaItems.target_missing',
      message: 'The Task or Files & media Task Property Definition was not found.',
    });
  }
  if (task.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.reorderFilesMediaItems.stale',
      message: 'The Files & media value changed elsewhere.',
    });
  }

  const selectedItems = await services.tx.execute(sql`
    select item.item_id as "itemId"
    from ticketing.task_files_media_items as item
    where item.task_id = ${input.taskId}
      and item.property_definition_id = ${input.propertyDefinitionId}
      and item.tenant_id = ${services.context.tenantId}
    order by item.position
    for update of item
  `);
  const currentItemIds = rowsFromResult<ItemRow>(selectedItems).map(({ itemId }) => itemId);
  if (
    new Set(input.itemIds).size !== input.itemIds.length ||
    input.itemIds.length !== currentItemIds.length ||
    input.itemIds.some((itemId) => !currentItemIds.includes(itemId))
  ) {
    throw rejectAction({
      code: 'ticketing.reorderFilesMediaItems.complete_order_required',
      message: 'Reorder must contain every current Files & media item exactly once.',
    });
  }
  if (input.itemIds.every((itemId, index) => itemId === currentItemIds[index])) {
    services.markNoOp();
    return { taskRevision: task.taskRevision };
  }

  await services.tx.execute(sql`
    update ticketing.task_files_media_items as item
    set position = item.position + ${input.itemIds.length}
    where item.task_id = ${input.taskId}
      and item.property_definition_id = ${input.propertyDefinitionId}
      and item.tenant_id = ${services.context.tenantId}
  `);
  await services.tx.execute(sql`
    update ticketing.task_files_media_items as item
    set position = (requested.ordinal - 1)::integer
    from jsonb_array_elements_text(${JSON.stringify(input.itemIds)}::jsonb)
      with ordinality as requested(item_id, ordinal)
    where item.item_id = requested.item_id::uuid
      and item.task_id = ${input.taskId}
      and item.property_definition_id = ${input.propertyDefinitionId}
      and item.tenant_id = ${services.context.tenantId}
  `);

  const changedAt = services.clock.now().toISOString();
  const updated = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = ${changedAt}::timestamptz,
        last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
        revision = task.revision + 1
      where task.task_id = ${input.taskId}
        and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select updated_task.last_edited_at, ${services.effectiveEditorPrincipalId},
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
      code: 'ticketing.reorderFilesMediaItems.not_committed',
      message: 'The Files & media order could not be committed.',
    });
  }
  return { taskRevision: result.taskRevision };
};

export const reorderFilesMediaItemsActionRegistration: ActionRegistration<
  ReorderFilesMediaItemsActionPayload,
  ReorderFilesMediaItemsActionResponse
> = {
  descriptor: {
    actionKey: reorderFilesMediaItemsActionKey,
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
    transportRequestSchema: reorderFilesMediaItemsActionPayloadSchema,
    transportResponseSchema: reorderFilesMediaItemsActionResponseSchema,
  },
  handler,
};
