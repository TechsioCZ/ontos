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
  updateSelectOptionActionKey,
  updateSelectOptionActionPayloadSchema,
  updateSelectOptionActionResponseSchema,
} from '../../shared/actions/update-select-option.ts';
import type {
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse,
} from '../../shared/actions/update-select-option.ts';
import type { SelectOption } from '../../shared/task-property-definition.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

interface UpdatedOptionRow extends SelectOption {
  readonly definitionRevision: number;
}

const evidence = (
  input: UpdateSelectOptionActionPayload,
  response: UpdateSelectOptionActionResponse,
) => ({
  changedComponents: ['optionPresentation'],
  collectionId: input.collectionId,
  datatype: 'select',
  operation: 'option_updated',
  optionId: input.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.optionId,
  targetResourceType: 'select_option',
} satisfies ActionAuditEventDescriptor<
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.selectOption.updated',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.optionId,
  subjectResourceType: 'select_option',
} satisfies ActionDomainEventDescriptor<
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse
>;

const handler: ActionHandler<
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (displayName.length === 0) {
    throw rejectAction({
      code: 'ticketing.updateSelectOption.name_required',
      message: 'An option name is required.',
    });
  }
  const result = await services.tx.execute(sql`
    with updated_option as (
      update ticketing.select_options as option
      set color = ${input.color},
          name = ${displayName},
          normalized_name = ${normalizedName},
          revision = option.revision + 1
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
      where option.option_id = ${input.optionId}
        and option.property_definition_id = ${input.propertyDefinitionId}
        and option.revision = ${input.expectedRevision}
        and option.tenant_id = ${services.context.tenantId}
        and definition.property_definition_id = option.property_definition_id
        and definition.datatype = 'select'
        and schema.collection_id = ${input.collectionId}
        and not exists (
          select 1 from ticketing.select_options as sibling
          where sibling.property_definition_id = option.property_definition_id
            and sibling.option_id <> option.option_id
            and sibling.normalized_name = ${normalizedName}
        )
      returning option.color, option.manual_position, option.name, option.option_id, option.property_definition_id, option.revision
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from updated_option
      where definition.property_definition_id = updated_option.property_definition_id
      returning definition.revision
    )
    select
      updated_option.color,
      updated_definition.revision as "definitionRevision",
      updated_option.manual_position as "manualPosition",
      updated_option.name,
      updated_option.option_id as "optionId",
      updated_option.revision
    from updated_option cross join updated_definition
  `);
  const row = rowsFromResult<UpdatedOptionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.updateSelectOption.stale_missing_or_name_conflict',
      message: 'The Select option changed, is unavailable, or conflicts with another option name.',
    });
  }
  const { definitionRevision, ...option } = row;
  return { definitionRevision, option };
};

export const updateSelectOptionActionRegistration: ActionRegistration<
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse
> = {
  descriptor: {
    actionKey: updateSelectOptionActionKey,
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
    transportRequestSchema: updateSelectOptionActionPayloadSchema,
    transportResponseSchema: updateSelectOptionActionResponseSchema,
  },
  handler,
};
