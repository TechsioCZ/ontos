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
  createSelectOptionAndSelectActionKey,
  createSelectOptionAndSelectActionPayloadSchema,
  createSelectOptionAndSelectActionResponseSchema,
} from '../../shared/actions/create-select-option-and-select.ts';
import type {
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse,
} from '../../shared/actions/create-select-option-and-select.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

interface AtomicRow {
  readonly color: string;
  readonly definitionRevision: number;
  readonly manualPosition: number;
  readonly name: string;
  readonly optionId: string;
  readonly optionRevision: number;
  readonly taskRevision: number;
  readonly valueRevision: number;
}

const evidence = (
  input: CreateSelectOptionAndSelectActionPayload,
  response: CreateSelectOptionAndSelectActionResponse,
) => ({
  changedComponents: ['optionCatalog', 'selectValue'],
  collectionId: input.collectionId,
  datatype: 'select',
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
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.selectOption.createdAndSelected',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse
>;

const handler: ActionHandler<
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (displayName.length === 0) {
    throw rejectAction({
      code: 'ticketing.createSelectOptionAndSelect.name_required',
      message: 'An option name is required.',
    });
  }
  const currentResult = await services.tx.execute(sql`
    select
      definition.revision as "definitionRevision",
      value.revision as "valueRevision"
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
    inner join ticketing.tasks as task
      on task.collection_id = schema.collection_id and task.tenant_id = schema.tenant_id
    left join ticketing.task_select_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'select'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and task.task_id = ${input.taskId}
    for update of definition, task
  `);
  const current = rowsFromResult<{
    readonly definitionRevision: number;
    readonly valueRevision: number | null;
  }>(currentResult).at(0);
  if (
    current === undefined ||
    current.definitionRevision !== input.expectedDefinitionRevision ||
    (current.valueRevision ?? 0) !== input.expectedValueRevision
  ) {
    throw rejectAction({
      code: 'ticketing.createSelectOptionAndSelect.stale_or_missing',
      message: 'The Select catalog or value changed elsewhere or is no longer available.',
    });
  }
  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with inserted_option as (
      insert into ticketing.select_options (
        color, manual_position, name, normalized_name, property_definition_id, tenant_id
      ) values (
        ${input.color},
        coalesce((select max(option.manual_position) + 1 from ticketing.select_options as option where option.property_definition_id = ${input.propertyDefinitionId}), 0),
        ${displayName},
        ${normalizedName},
        ${input.propertyDefinitionId},
        ${services.context.tenantId}
      )
      on conflict do nothing
      returning color, manual_position, name, option_id, revision
    ), changed_value as (
      insert into ticketing.task_select_values (
        option_id, property_definition_id, revision, task_id, tenant_id
      )
      select option_id, ${input.propertyDefinitionId}, 1, ${input.taskId}, ${services.context.tenantId}
      from inserted_option
      on conflict (task_id, property_definition_id) do update
      set option_id = excluded.option_id,
          revision = task_select_values.revision + 1
      where task_select_values.revision = ${input.expectedValueRevision}
      returning revision, task_id
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from changed_value
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.revision = ${input.expectedDefinitionRevision}
      returning definition.revision
    ), updated_task as (
      update ticketing.tasks as task
      set last_edited_at = ${changedAt}::timestamptz,
          last_edited_by_principal_id = ${services.context.principalId},
          revision = task.revision + 1
      from changed_value
      where task.task_id = changed_value.task_id and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ), created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select updated_task.last_edited_at, ${services.context.principalId}, 'select_value_changed', updated_task.revision, updated_task.task_id, ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      inserted_option.color,
      updated_definition.revision as "definitionRevision",
      inserted_option.manual_position as "manualPosition",
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
      code: 'ticketing.createSelectOptionAndSelect.stale_missing_or_name_conflict',
      message: 'The option could not be created and selected atomically.',
    });
  }
  return {
    definitionRevision: row.definitionRevision,
    option: {
      color: row.color,
      manualPosition: row.manualPosition,
      name: row.name,
      optionId: row.optionId,
      revision: row.optionRevision,
    },
    taskRevision: row.taskRevision,
    value: {
      optionId: row.optionId,
      propertyDefinitionId: input.propertyDefinitionId,
      revision: row.valueRevision,
    },
  };
};

export const createSelectOptionAndSelectActionRegistration: ActionRegistration<
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse
> = {
  descriptor: {
    actionKey: createSelectOptionAndSelectActionKey,
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
    transportRequestSchema: createSelectOptionAndSelectActionPayloadSchema,
    transportResponseSchema: createSelectOptionAndSelectActionResponseSchema,
  },
  handler,
};
