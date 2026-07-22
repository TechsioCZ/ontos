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
  updateMultiSelectOptionActionKey,
  updateMultiSelectOptionActionPayloadSchema,
  updateMultiSelectOptionActionResponseSchema,
} from '../../shared/actions/update-multi-select-option.ts';
import type {
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse,
} from '../../shared/actions/update-multi-select-option.ts';
import type { MultiSelectOption } from '../../shared/task-property-definition.ts';
import { prepareMultiSelectOptionName } from '../multi-select-option-name.ts';

interface UpdatedOptionRow extends MultiSelectOption {
  readonly definitionRevision: number;
}
const evidence = (
  input: UpdateMultiSelectOptionActionPayload,
  response: UpdateMultiSelectOptionActionResponse,
) => ({
  changedComponents: ['optionPresentation'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'option_updated',
  optionId: input.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.optionId,
  targetResourceType: 'multi_select_option',
} satisfies ActionAuditEventDescriptor<
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.multiSelectOption.updated',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.optionId,
  subjectResourceType: 'multi_select_option',
} satisfies ActionDomainEventDescriptor<
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse
>;

const handler: ActionHandler<
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareMultiSelectOptionName(
    input.name,
    'updateMultiSelectOption',
  );
  const currentResult = await services.tx.execute(sql`
    select
      option.catalog_position as "catalogPosition",
      option.color,
      definition.revision as "definitionRevision",
      option.name,
      option.option_id as "optionId",
      option.revision,
      to_char(
        option.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt"
    from ticketing.multi_select_options as option
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = option.property_definition_id
      and definition.tenant_id = option.tenant_id
      and definition.datatype = 'multi_select'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where option.option_id = ${input.optionId}
      and option.property_definition_id = ${input.propertyDefinitionId}
      and option.revision = ${input.expectedRevision}
      and option.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of option, definition
  `);
  const current = rowsFromResult<UpdatedOptionRow>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updateMultiSelectOption.stale_missing_or_name_conflict',
      message:
        'The Multi-select option changed, is unavailable, or conflicts with another option name.',
    });
  }
  if (current.color === input.color && current.name === displayName) {
    services.markNoOp();
    const { definitionRevision, ...option } = current;
    return { definitionRevision, option };
  }
  const result = await services.tx.execute(sql`
    with updated_option as (
      update ticketing.multi_select_options as option
      set color = ${input.color},
          name = ${displayName},
          normalized_name = ${normalizedName},
          revision = option.revision + 1,
          updated_at = statement_timestamp()
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
      where option.option_id = ${input.optionId}
        and option.property_definition_id = ${input.propertyDefinitionId}
        and option.revision = ${input.expectedRevision}
        and option.tenant_id = ${services.context.tenantId}
        and definition.property_definition_id = option.property_definition_id
        and definition.datatype = 'multi_select'
        and schema.collection_id = ${input.collectionId}
        and not exists (
          select 1 from ticketing.multi_select_options as sibling
          where sibling.property_definition_id = option.property_definition_id
            and sibling.option_id <> option.option_id
            and sibling.normalized_name = ${normalizedName}
        )
      returning option.catalog_position, option.color, option.name, option.option_id, option.property_definition_id, option.revision, option.updated_at
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from updated_option
      where definition.property_definition_id = updated_option.property_definition_id
      returning definition.revision
    )
    select
      updated_option.catalog_position as "catalogPosition",
      updated_option.color,
      updated_definition.revision as "definitionRevision",
      updated_option.name,
      updated_option.option_id as "optionId",
      updated_option.revision,
      to_char(
        updated_option.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt"
    from updated_option cross join updated_definition
  `);
  const row = rowsFromResult<UpdatedOptionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.updateMultiSelectOption.stale_missing_or_name_conflict',
      message:
        'The Multi-select option changed, is unavailable, or conflicts with another option name.',
    });
  }
  const { definitionRevision, ...option } = row;
  return { definitionRevision, option };
};

export const updateMultiSelectOptionActionRegistration: ActionRegistration<
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse
> = {
  descriptor: {
    actionKey: updateMultiSelectOptionActionKey,
    auditEvent,
    auditProfile: 'standard',
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
    transportRequestSchema: updateMultiSelectOptionActionPayloadSchema,
    transportResponseSchema: updateMultiSelectOptionActionResponseSchema,
  },
  handler,
};
