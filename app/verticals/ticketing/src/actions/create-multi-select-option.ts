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
  createMultiSelectOptionActionKey,
  createMultiSelectOptionActionPayloadSchema,
  createMultiSelectOptionActionResponseSchema,
} from '../../shared/actions/create-multi-select-option.ts';
import type {
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse,
} from '../../shared/actions/create-multi-select-option.ts';
import type { MultiSelectOption } from '../../shared/task-property-definition.ts';
import { prepareMultiSelectOptionName } from '../multi-select-option-name.ts';

interface CreatedOptionRow extends MultiSelectOption {
  readonly definitionRevision: number;
}

const evidence = (
  input: CreateMultiSelectOptionActionPayload,
  response: CreateMultiSelectOptionActionResponse,
) => ({
  changedComponents: ['optionCatalog'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'option_created',
  optionId: response.option.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.option.optionId,
  targetResourceType: 'multi_select_option',
} satisfies ActionAuditEventDescriptor<
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.multiSelectOption.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.option.optionId,
  subjectResourceType: 'multi_select_option',
} satisfies ActionDomainEventDescriptor<
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse
>;

const handler: ActionHandler<
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareMultiSelectOptionName(
    input.name,
    'createMultiSelectOption',
  );
  const result = await services.tx.execute(sql`
    with locked_definition as (
      select definition.property_definition_id
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.revision = ${input.expectedDefinitionRevision}
        and definition.datatype = 'multi_select'
        and definition.tenant_id = ${services.context.tenantId}
        and schema.collection_id = ${input.collectionId}
      for update of definition
    ), inserted_option as (
      insert into ticketing.multi_select_options (
        catalog_position, color, name, normalized_name, property_definition_id, tenant_id
      )
      select
        coalesce((select max(option.catalog_position) + 1 from ticketing.multi_select_options as option where option.property_definition_id = ${input.propertyDefinitionId}), 0),
        ${input.color},
        ${displayName},
        ${normalizedName},
        locked_definition.property_definition_id,
        ${services.context.tenantId}
      from locked_definition
      on conflict do nothing
      returning catalog_position, color, name, option_id, revision, updated_at
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from inserted_option
      where definition.property_definition_id = ${input.propertyDefinitionId}
      returning definition.revision
    )
    select
      inserted_option.catalog_position as "catalogPosition",
      inserted_option.color,
      updated_definition.revision as "definitionRevision",
      inserted_option.name,
      inserted_option.option_id as "optionId",
      inserted_option.revision,
      to_char(
        inserted_option.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt"
    from inserted_option cross join updated_definition
  `);
  const row = rowsFromResult<CreatedOptionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectOption.stale_missing_or_name_conflict',
      message:
        'The Multi-select definition changed, is unavailable, or already has that option name.',
    });
  }
  const { definitionRevision, ...option } = row;
  return { definitionRevision, option };
};

export const createMultiSelectOptionActionRegistration: ActionRegistration<
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse
> = {
  descriptor: {
    actionKey: createMultiSelectOptionActionKey,
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
    transportRequestSchema: createMultiSelectOptionActionPayloadSchema,
    transportResponseSchema: createMultiSelectOptionActionResponseSchema,
  },
  handler,
};
