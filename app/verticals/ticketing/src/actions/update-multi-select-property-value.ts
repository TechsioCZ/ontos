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
  updateMultiSelectPropertyValueActionKey,
  updateMultiSelectPropertyValueActionPayloadSchema,
  updateMultiSelectPropertyValueActionResponseSchema,
} from '../../shared/actions/update-multi-select-property-value.ts';
import type {
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse,
} from '../../shared/actions/update-multi-select-property-value.ts';

interface CurrentValueRow {
  readonly revision: number;
  readonly taskRevision: number;
  readonly updatedAt: string;
}

const evidence = (
  input: UpdateMultiSelectPropertyValueActionPayload,
  response: UpdateMultiSelectPropertyValueActionResponse,
) => ({
  changedComponents: ['multiSelectValue'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse
>;

const handler: ActionHandler<
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select
      value.revision,
      task.revision as "taskRevision",
      to_char(
        value.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt"
    from ticketing.task_multi_select_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id and task.tenant_id = value.tenant_id
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.schema_id = schema.schema_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'multi_select'
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
      and value.property_definition_id = ${input.propertyDefinitionId}
    for update of task, value
  `);
  const current = rowsFromResult<CurrentValueRow>(currentResult).at(0);
  if (current === undefined || current.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateMultiSelectPropertyValue.stale_or_missing',
      message: 'The Multi-select value changed elsewhere or is no longer available.',
    });
  }

  const requestedIds = [...new Set(input.optionIds)];
  const optionsResult = await services.tx.execute(sql`
    select option.option_id as "optionId"
    from ticketing.multi_select_options as option
    where option.property_definition_id = ${input.propertyDefinitionId}
      and option.tenant_id = ${services.context.tenantId}
      and option.option_id::text = any(string_to_array(${requestedIds.join(',')}, ','))
    order by option.catalog_position, option.option_id
  `);
  const optionIds = rowsFromResult<{ readonly optionId: string }>(optionsResult).map(
    ({ optionId }) => optionId,
  );
  if (optionIds.length !== requestedIds.length) {
    throw rejectAction({
      code: 'ticketing.updateMultiSelectPropertyValue.option_not_found',
      message: 'Every selected option must belong to this Multi-select property.',
    });
  }

  const currentSelectionsResult = await services.tx.execute(sql`
    select selection.option_id as "optionId"
    from ticketing.task_multi_select_selections as selection
    inner join ticketing.multi_select_options as option
      on option.option_id = selection.option_id
      and option.property_definition_id = selection.property_definition_id
      and option.tenant_id = selection.tenant_id
    where selection.task_id = ${input.taskId}
      and selection.property_definition_id = ${input.propertyDefinitionId}
      and selection.tenant_id = ${services.context.tenantId}
    order by option.catalog_position, option.option_id
  `);
  const currentOptionIds = rowsFromResult<{ readonly optionId: string }>(
    currentSelectionsResult,
  ).map(({ optionId }) => optionId);
  if (
    currentOptionIds.length === optionIds.length &&
    currentOptionIds.every((optionId, index) => optionId === optionIds[index])
  ) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        optionIds,
        propertyDefinitionId: input.propertyDefinitionId,
        revision: current.revision,
        updatedAt: current.updatedAt,
      },
    };
  }

  await services.tx.execute(sql`
    delete from ticketing.task_multi_select_selections
    where task_id = ${input.taskId}
      and property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  if (optionIds.length > 0) {
    await services.tx.execute(sql`
      insert into ticketing.task_multi_select_selections (
        option_id, property_definition_id, task_id, tenant_id
      )
      select
        option.option_id,
        ${input.propertyDefinitionId},
        ${input.taskId},
        ${services.context.tenantId}
      from ticketing.multi_select_options as option
      where option.property_definition_id = ${input.propertyDefinitionId}
        and option.tenant_id = ${services.context.tenantId}
        and option.option_id::text = any(string_to_array(${optionIds.join(',')}, ','))
    `);
  }
  const result = await services.tx.execute(sql`
    with changed_value as (
      update ticketing.task_multi_select_values as value
      set revision = value.revision + 1,
          updated_at = statement_timestamp()
      where value.task_id = ${input.taskId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.tenant_id = ${services.context.tenantId}
        and value.revision = ${input.expectedRevision}
      returning value.property_definition_id, value.revision, value.task_id, value.updated_at
    ), updated_task as (
      update ticketing.tasks as task
      set last_edited_at = statement_timestamp(),
          last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
          revision = task.revision + 1
      from changed_value
      where task.task_id = changed_value.task_id and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ), created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select updated_task.last_edited_at, ${services.effectiveEditorPrincipalId}, 'multi_select_value_changed', updated_task.revision, updated_task.task_id, ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      changed_value.property_definition_id as "propertyDefinitionId",
      changed_value.revision,
      to_char(
        changed_value.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt",
      updated_task.revision as "taskRevision"
    from changed_value inner join updated_task using (task_id) inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<{
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly taskRevision: number;
    readonly updatedAt: string;
  }>(result).at(0);
  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateMultiSelectPropertyValue.stale_or_missing',
      message: 'The Multi-select value changed elsewhere or is no longer available.',
    });
  }
  return {
    taskRevision: updated.taskRevision,
    value: {
      optionIds,
      propertyDefinitionId: updated.propertyDefinitionId,
      revision: updated.revision,
      updatedAt: updated.updatedAt,
    },
  };
};

export const updateMultiSelectPropertyValueActionRegistration: ActionRegistration<
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateMultiSelectPropertyValueActionKey,
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
    transportRequestSchema: updateMultiSelectPropertyValueActionPayloadSchema,
    transportResponseSchema: updateMultiSelectPropertyValueActionResponseSchema,
  },
  handler,
};
