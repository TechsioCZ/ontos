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
  createStatusOptionActionKey,
  createStatusOptionActionPayloadSchema,
  createStatusOptionActionResponseSchema,
} from '../../shared/actions/create-status-option.ts';
import type {
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse,
} from '../../shared/actions/create-status-option.ts';
import type { StatusOption } from '../../shared/task-property-definition.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

interface CreatedOptionRow extends StatusOption {
  readonly definitionRevision: number;
}

const evidence = (
  input: CreateStatusOptionActionPayload,
  response: CreateStatusOptionActionResponse,
) => ({
  changedComponents: ['statusOptions'],
  collectionId: input.collectionId,
  datatype: 'status',
  operation: 'option_created',
  optionId: response.option.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.option.optionId,
  targetResourceType: 'status_option',
} satisfies ActionAuditEventDescriptor<
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.statusOption.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.option.optionId,
  subjectResourceType: 'status_option',
} satisfies ActionDomainEventDescriptor<
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse
>;

const handler: ActionHandler<
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (displayName.length === 0 || input.color.length === 0) {
    throw rejectAction({
      code: 'ticketing.createStatusOption.name_and_color_required',
      message: 'A Status Option name and application-provided color are required.',
    });
  }
  const result = await services.tx.execute(sql`
    with locked_definition as (
      select definition.property_definition_id
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'status'
        and definition.revision = ${input.expectedDefinitionRevision}
        and definition.tenant_id = ${services.context.tenantId}
        and schema.collection_id = ${input.collectionId}
      for update of definition
    ), created_option as (
      insert into ticketing.status_options (
        color, group_key, name, normalized_name, position, property_definition_id, tenant_id
      )
      select
        ${input.color},
        ${input.group},
        ${displayName},
        ${normalizedName},
        coalesce(max(sibling.position) + 1, 0),
        locked_definition.property_definition_id,
        ${services.context.tenantId}
      from locked_definition
      left join ticketing.status_options as sibling
        on sibling.property_definition_id = locked_definition.property_definition_id
        and sibling.group_key = ${input.group}
        and sibling.tenant_id = ${services.context.tenantId}
      group by locked_definition.property_definition_id
      on conflict do nothing
      returning color, group_key, name, option_id, position, property_definition_id, revision
    ), updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from created_option
      where definition.property_definition_id = created_option.property_definition_id
      returning definition.revision
    )
    select
      created_option.color,
      updated_definition.revision as "definitionRevision",
      created_option.group_key as "group",
      created_option.name,
      created_option.option_id as "optionId",
      created_option.position,
      created_option.revision
    from created_option cross join updated_definition
  `);
  const row = rowsFromResult<CreatedOptionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.createStatusOption.stale_missing_or_name_conflict',
      message: 'The Status definition changed, is unavailable, or the option name is in use.',
    });
  }
  const { definitionRevision, ...option } = row;
  return { definitionRevision, option };
};

export const createStatusOptionActionRegistration: ActionRegistration<
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse
> = {
  descriptor: {
    actionKey: createStatusOptionActionKey,
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
    transportRequestSchema: createStatusOptionActionPayloadSchema,
    transportResponseSchema: createStatusOptionActionResponseSchema,
  },
  handler,
};
