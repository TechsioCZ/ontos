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
  addFilesMediaExternalItemActionKey,
  addFilesMediaExternalItemActionPayloadSchema,
  addFilesMediaExternalItemActionResponseSchema,
} from '../../shared/actions/add-files-media-external-item.ts';
import type {
  AddFilesMediaExternalItemActionPayload,
  AddFilesMediaExternalItemActionResponse,
} from '../../shared/actions/add-files-media-external-item.ts';
import { InvalidUrlPropertyValueError, validateUrlPropertyValue } from '../url-property.ts';

interface TargetRow {
  readonly nextPosition: number;
  readonly taskRevision: number;
}

interface CommittedRow {
  readonly itemId: string;
  readonly taskRevision: number;
}

const evidence = (
  input: AddFilesMediaExternalItemActionPayload,
  response: AddFilesMediaExternalItemActionResponse,
) => ({
  changedComponents: ['filesMediaItems'],
  collectionId: input.collectionId,
  itemId: response.item.itemId,
  operation: 'externalItemAdded',
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
  AddFilesMediaExternalItemActionPayload,
  AddFilesMediaExternalItemActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  AddFilesMediaExternalItemActionPayload,
  AddFilesMediaExternalItemActionResponse
>;

const handler: ActionHandler<
  AddFilesMediaExternalItemActionPayload,
  AddFilesMediaExternalItemActionResponse
> = async (input, services) => {
  let externalUrl: string | null;
  try {
    externalUrl = validateUrlPropertyValue(input.url);
  } catch (error) {
    if (error instanceof InvalidUrlPropertyValueError) {
      throw rejectAction({ code: error.code, message: error.message });
    }
    throw error;
  }
  if (externalUrl === null) {
    throw rejectAction({
      code: 'ticketing.addFilesMediaExternalItem.url_required',
      message: 'An external Files & media item requires a URL.',
    });
  }

  const selected = await services.tx.execute(sql`
    select
      coalesce((
        select max(item.position) + 1
        from ticketing.task_files_media_items as item
        where item.task_id = task.task_id
          and item.property_definition_id = definition.property_definition_id
          and item.tenant_id = task.tenant_id
      ), 0)::integer as "nextPosition",
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
      code: 'ticketing.addFilesMediaExternalItem.target_missing',
      message: 'The Task or Files & media Task Property Definition was not found.',
    });
  }
  if (target.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.addFilesMediaExternalItem.stale',
      message: 'The Files & media value changed elsewhere.',
    });
  }

  const changedAt = services.clock.now().toISOString();
  const committed = await services.tx.execute(sql`
    with created_item as (
      insert into ticketing.task_files_media_items (
        external_url, position, property_definition_id, task_id, tenant_id
      )
      values (
        ${externalUrl}, ${target.nextPosition}, ${input.propertyDefinitionId},
        ${input.taskId}, ${services.context.tenantId}
      )
      returning item_id, task_id
    ),
    updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = ${changedAt}::timestamptz,
        last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
        revision = task.revision + 1
      from created_item
      where task.task_id = created_item.task_id
        and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select
        updated_task.last_edited_at, ${services.effectiveEditorPrincipalId},
        'files_media_value_changed', updated_task.revision, updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      created_item.item_id as "itemId",
      updated_task.revision as "taskRevision"
    from created_item
    inner join updated_task using (task_id)
    inner join created_revision using (task_id)
  `);
  const row = rowsFromResult<CommittedRow>(committed).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.addFilesMediaExternalItem.not_committed',
      message: 'The external Files & media item could not be committed.',
    });
  }

  return {
    item: {
      access: 'external',
      externalUrl,
      itemId: row.itemId,
      position: target.nextPosition,
      propertyDefinitionId: input.propertyDefinitionId,
    },
    taskRevision: row.taskRevision,
  };
};

export const addFilesMediaExternalItemActionRegistration: ActionRegistration<
  AddFilesMediaExternalItemActionPayload,
  AddFilesMediaExternalItemActionResponse
> = {
  descriptor: {
    actionKey: addFilesMediaExternalItemActionKey,
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
    transportRequestSchema: addFilesMediaExternalItemActionPayloadSchema,
    transportResponseSchema: addFilesMediaExternalItemActionResponseSchema,
  },
  handler,
};
