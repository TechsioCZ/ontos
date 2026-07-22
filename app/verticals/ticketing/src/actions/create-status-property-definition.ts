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
  createStatusPropertyDefinitionActionKey,
  createStatusPropertyDefinitionActionPayloadSchema,
  createStatusPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-status-property-definition.ts';
import type {
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse,
} from '../../shared/actions/create-status-property-definition.ts';
import type { StatusOption } from '../../shared/task-property-definition.ts';
import { statusDefinitionFromParts, statusGroupLabel } from '../status-property.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface CreatedDefinitionRow {
  readonly collectionLocale: string;
  readonly defaultOptionId: string;
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

type CreatedOptionRow = StatusOption;

const evidence = (
  input: CreateStatusPropertyDefinitionActionPayload,
  response: CreateStatusPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'statusOptions', 'statusDefault'],
  collectionId: input.collectionId,
  datatype: 'status',
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse
>;

const handler: ActionHandler<
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createStatusPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }
  if (Object.values(input.initialColors).some((color) => color.length === 0)) {
    throw rejectAction({
      code: 'ticketing.createStatusPropertyDefinition.initial_color_required',
      message: 'The application must provide a color for every initial Status Option.',
    });
  }
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  const result = await services.tx.execute(sql`
    with created_definition as (
      insert into ticketing.task_property_definitions (
        datatype, mandatory, name, schema_id, tenant_id
      )
      select 'status', ${input.mandatory}, ${name}, schema.schema_id, ${services.context.tenantId}
      from ticketing.task_schemas as schema
      where schema.collection_id = ${input.collectionId}
        and schema.tenant_id = ${services.context.tenantId}
      on conflict do nothing
      returning hidden, mandatory, name, property_definition_id, revision, schema_id
    ), created_options as (
      insert into ticketing.status_options (
        color, group_key, name, normalized_name, position, property_definition_id, tenant_id
      )
      select initial.color, initial.group_key, initial.name, initial.normalized_name,
             initial.position, created_definition.property_definition_id, ${services.context.tenantId}
      from created_definition
      cross join (values
        (${input.initialColors.todo}, 'todo', 'Not started', 'not started', 0),
        (${input.initialColors.inProgress}, 'in_progress', 'In progress', 'in progress', 0),
        (${input.initialColors.complete}, 'complete', 'Done', 'done', 0)
      ) as initial(color, group_key, name, normalized_name, position)
      returning color, group_key, name, option_id, position, property_definition_id, revision
    ), created_configuration as (
      insert into ticketing.status_property_configurations (
        default_option_id, property_definition_id, tenant_id
      )
      select option_id, property_definition_id, ${services.context.tenantId}
      from created_options
      where group_key = 'todo'
      returning default_option_id, property_definition_id
    )
    select
      collection.locale as "collectionLocale",
      created_configuration.default_option_id as "defaultOptionId",
      created_definition.hidden,
      created_definition.mandatory,
      created_definition.name,
      created_definition.property_definition_id as "propertyDefinitionId",
      created_definition.revision
    from created_definition
    inner join created_configuration using (property_definition_id)
    inner join ticketing.task_schemas as schema on schema.schema_id = created_definition.schema_id
    inner join ticketing.task_collections as collection
      on collection.collection_id = schema.collection_id
      and collection.tenant_id = ${services.context.tenantId}
  `);
  const definition = rowsFromResult<CreatedDefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createStatusPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  const optionResult = await services.tx.execute(sql`
    select
      color,
      group_key as "group",
      name,
      option_id as "optionId",
      position,
      revision
    from ticketing.status_options
    where property_definition_id = ${definition.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
    order by group_key, position, option_id
  `);
  return {
    definition: statusDefinitionFromParts({
      ...definition,
      groupLabel: (group) => statusGroupLabel(group, definition.collectionLocale),
      options: rowsFromResult<CreatedOptionRow>(optionResult),
    }),
  };
};

export const createStatusPropertyDefinitionActionRegistration: ActionRegistration<
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createStatusPropertyDefinitionActionKey,
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
    transportRequestSchema: createStatusPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createStatusPropertyDefinitionActionResponseSchema,
  },
  handler,
};
