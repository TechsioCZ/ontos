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
  createSelectOptionActionKey,
  createSelectOptionActionPayloadSchema,
  createSelectOptionActionResponseSchema,
} from '../../shared/actions/create-select-option.ts';
import type {
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse,
} from '../../shared/actions/create-select-option.ts';
import type { SelectOption } from '../../shared/task-property-definition.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

interface CreatedOptionRow extends SelectOption {
  readonly definitionRevision: number;
}

const evidence = (
  input: CreateSelectOptionActionPayload,
  response: CreateSelectOptionActionResponse,
) => ({
  changedComponents: ['optionCatalog'],
  collectionId: input.collectionId,
  datatype: 'select',
  operation: 'option_created',
  optionId: response.option.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.option.optionId,
  targetResourceType: 'select_option',
} satisfies ActionAuditEventDescriptor<
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.selectOption.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.option.optionId,
  subjectResourceType: 'select_option',
} satisfies ActionDomainEventDescriptor<
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse
>;

const handler: ActionHandler<
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (displayName.length === 0) {
    throw rejectAction({
      code: 'ticketing.createSelectOption.name_required',
      message: 'An option name is required.',
    });
  }
  const result = await services.tx.execute(sql`
    with locked_definition as (
      select definition.property_definition_id
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.revision = ${input.expectedDefinitionRevision}
        and definition.datatype = 'select'
        and definition.tenant_id = ${services.context.tenantId}
        and schema.collection_id = ${input.collectionId}
      for update of definition
    ), inserted_option as (
      insert into ticketing.select_options (
        color, manual_position, name, normalized_name, property_definition_id, tenant_id
      )
      select
        ${input.color},
        coalesce((select max(option.manual_position) + 1 from ticketing.select_options as option where option.property_definition_id = ${input.propertyDefinitionId}), 0),
        ${displayName},
        ${normalizedName},
        locked_definition.property_definition_id,
        ${services.context.tenantId}
      from locked_definition
      on conflict do nothing
      returning color, manual_position, name, option_id, revision
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from inserted_option
      where definition.property_definition_id = ${input.propertyDefinitionId}
      returning definition.revision
    )
    select
      inserted_option.color,
      updated_definition.revision as "definitionRevision",
      inserted_option.manual_position as "manualPosition",
      inserted_option.name,
      inserted_option.option_id as "optionId",
      inserted_option.revision
    from inserted_option cross join updated_definition
  `);
  const row = rowsFromResult<CreatedOptionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.createSelectOption.stale_missing_or_name_conflict',
      message: 'The Select definition changed, is unavailable, or already has that option name.',
    });
  }
  const { definitionRevision, ...option } = row;
  return { definitionRevision, option };
};

export const createSelectOptionActionRegistration: ActionRegistration<
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse
> = {
  descriptor: {
    actionKey: createSelectOptionActionKey,
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
    transportRequestSchema: createSelectOptionActionPayloadSchema,
    transportResponseSchema: createSelectOptionActionResponseSchema,
  },
  handler,
};
