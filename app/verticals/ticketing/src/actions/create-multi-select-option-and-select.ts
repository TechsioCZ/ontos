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
  createMultiSelectOptionAndSelectActionKey,
  createMultiSelectOptionAndSelectActionPayloadSchema,
  createMultiSelectOptionAndSelectActionResponseSchema,
} from '../../shared/actions/create-multi-select-option-and-select.ts';
import type {
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse,
} from '../../shared/actions/create-multi-select-option-and-select.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

interface AtomicRow {
  readonly catalogPosition: number;
  readonly color: string;
  readonly definitionRevision: number;
  readonly name: string;
  readonly optionId: string;
  readonly optionRevision: number;
  readonly taskRevision: number;
  readonly valueRevision: number;
}
const evidence = (
  input: CreateMultiSelectOptionAndSelectActionPayload,
  response: CreateMultiSelectOptionAndSelectActionResponse,
) => ({
  changedComponents: ['optionCatalog', 'multiSelectValue'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'option_created_and_selected',
  optionId: response.option.optionId,
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
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.multiSelectOption.createdAndSelected',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse
>;

const handler: ActionHandler<
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (displayName.length === 0) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectOptionAndSelect.name_required',
      message: 'An option name is required.',
    });
  }
  if (displayName.includes(',')) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectOptionAndSelect.comma_not_allowed',
      message: 'A Multi-select option name cannot contain a comma.',
    });
  }
  const currentResult = await services.tx.execute(sql`
    select
      definition.revision as "definitionRevision",
      task.revision as "taskRevision",
      value.revision as "valueRevision"
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
    inner join ticketing.tasks as task
      on task.collection_id = schema.collection_id and task.tenant_id = schema.tenant_id
    inner join ticketing.task_multi_select_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'multi_select'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and task.task_id = ${input.taskId}
    for update of definition, task, value
  `);
  const current = rowsFromResult<{
    readonly definitionRevision: number;
    readonly taskRevision: number;
    readonly valueRevision: number;
  }>(currentResult).at(0);
  if (
    current === undefined ||
    current.definitionRevision !== input.expectedDefinitionRevision ||
    current.valueRevision !== input.expectedValueRevision
  ) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectOptionAndSelect.stale_or_missing',
      message: 'The Multi-select catalog or value changed elsewhere or is no longer available.',
    });
  }
  const result = await services.tx.execute(sql`
    with inserted_option as (
      insert into ticketing.multi_select_options (
        catalog_position, color, name, normalized_name, property_definition_id, tenant_id
      ) values (
        coalesce((select max(option.catalog_position) + 1 from ticketing.multi_select_options as option where option.property_definition_id = ${input.propertyDefinitionId}), 0),
        ${input.color},
        ${displayName},
        ${normalizedName},
        ${input.propertyDefinitionId},
        ${services.context.tenantId}
      )
      on conflict do nothing
      returning catalog_position, color, name, option_id, revision
    ), inserted_selection as (
      insert into ticketing.task_multi_select_selections (
        option_id, property_definition_id, task_id, tenant_id
      )
      select option_id, ${input.propertyDefinitionId}, ${input.taskId}, ${services.context.tenantId}
      from inserted_option
      returning task_id
    ), changed_value as (
      update ticketing.task_multi_select_values as value
      set revision = value.revision + 1
      from inserted_selection
      where value.task_id = inserted_selection.task_id
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.revision = ${input.expectedValueRevision}
      returning value.revision, value.task_id
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from changed_value
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.revision = ${input.expectedDefinitionRevision}
      returning definition.revision
    ), updated_task as (
      update ticketing.tasks as task
      set last_edited_at = statement_timestamp(),
          last_edited_by_principal_id = ${services.context.principalId},
          revision = task.revision + 1
      from changed_value
      where task.task_id = changed_value.task_id and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ), created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select updated_task.last_edited_at, ${services.context.principalId}, 'multi_select_value_changed', updated_task.revision, updated_task.task_id, ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      inserted_option.catalog_position as "catalogPosition",
      inserted_option.color,
      updated_definition.revision as "definitionRevision",
      inserted_option.name,
      inserted_option.option_id as "optionId",
      inserted_option.revision as "optionRevision",
      updated_task.revision as "taskRevision",
      changed_value.revision as "valueRevision"
    from inserted_option
    cross join changed_value
    cross join updated_definition
    cross join updated_task
    cross join created_revision
  `);
  const row = rowsFromResult<AtomicRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectOptionAndSelect.stale_missing_or_name_conflict',
      message: 'The option could not be created and selected atomically.',
    });
  }
  const selectionsResult = await services.tx.execute(sql`
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
  return {
    definitionRevision: row.definitionRevision,
    option: {
      catalogPosition: row.catalogPosition,
      color: row.color,
      name: row.name,
      optionId: row.optionId,
      revision: row.optionRevision,
    },
    taskRevision: row.taskRevision,
    value: {
      optionIds: rowsFromResult<{ readonly optionId: string }>(selectionsResult).map(
        ({ optionId }) => optionId,
      ),
      propertyDefinitionId: input.propertyDefinitionId,
      revision: row.valueRevision,
    },
  };
};

export const createMultiSelectOptionAndSelectActionRegistration: ActionRegistration<
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse
> = {
  descriptor: {
    actionKey: createMultiSelectOptionAndSelectActionKey,
    auditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createMultiSelectOptionAndSelectActionPayloadSchema,
    transportResponseSchema: createMultiSelectOptionAndSelectActionResponseSchema,
  },
  handler,
};
