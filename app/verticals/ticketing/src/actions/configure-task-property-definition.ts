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
  configureTaskPropertyDefinitionActionKey,
  configureTaskPropertyDefinitionActionPayloadSchema,
  configureTaskPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/configure-task-property-definition.ts';
import type {
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse,
} from '../../shared/actions/configure-task-property-definition.ts';
import type {
  SelectOption,
  SelectOptionOrderMode,
  TaskPropertyDefinition,
} from '../../shared/task-property-definition.ts';
import { orderSelectOptions } from '../select-option-order.ts';
import { getStatusDefinition } from '../status-property.ts';
import { taskPropertyDefinitionFromRow } from '../task-property-definition-projection.ts';
import type { TaskPropertyDefinitionRow } from '../task-property-definition-projection.ts';

interface SelectDefinitionRow {
  readonly collectionLocale: string;
  readonly datatype: 'select';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly optionOrderMode: SelectOptionOrderMode | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

interface StatusDefinitionRow {
  readonly collectionLocale: string;
  readonly datatype: 'status';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

type ConfigurableDefinitionRow =
  | SelectDefinitionRow
  | StatusDefinitionRow
  | TaskPropertyDefinitionRow;

const configuredDefinitionEvidence = (
  input: ConfigureTaskPropertyDefinitionActionPayload,
  response: ConfigureTaskPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definitionConfiguration'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  operation: 'configured',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const configureTaskPropertyDefinitionAuditEvent = {
  evidence: configuredDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse
>;

const configureTaskPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.configured',
  payload: configuredDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse
>;

const configureTaskPropertyDefinitionActionHandler: ActionHandler<
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse
> = async (input, services) => {
  const projectDefinition = async (
    row: ConfigurableDefinitionRow,
  ): Promise<TaskPropertyDefinition> => {
    if (row.datatype === 'status') {
      const definition = await getStatusDefinition({
        collectionId: input.collectionId,
        db: services.tx,
        locale: row.collectionLocale,
        propertyDefinitionId: row.propertyDefinitionId,
        tenantId: services.context.tenantId,
      });
      if (definition === undefined) {
        throw rejectAction({
          code: 'ticketing.configureTaskPropertyDefinition.status_configuration_missing',
          message: 'The Status configuration is unavailable.',
        });
      }
      return definition;
    }
    if (row.datatype !== 'select') {
      return taskPropertyDefinitionFromRow(row);
    }
    const optionResult = await services.tx.execute(sql`
      select
        option.color,
        option.manual_position as "manualPosition",
        option.name,
        option.option_id as "optionId",
        option.revision
      from ticketing.select_options as option
      where option.property_definition_id = ${row.propertyDefinitionId}
        and option.tenant_id = ${services.context.tenantId}
    `);
    const optionOrderMode = row.optionOrderMode ?? 'manual';
    return {
      datatype: row.datatype,
      hidden: row.hidden,
      mandatory: row.mandatory,
      name: row.name,
      optionOrderMode,
      options: orderSelectOptions(
        rowsFromResult<SelectOption>(optionResult),
        optionOrderMode,
        row.collectionLocale,
      ),
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    };
  };
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      collection.locale as "collectionLocale",
      person_configuration.cardinality,
      definition.datatype,
      definition.date_range_time_enabled as "timeEnabled",
      definition.number_format as format,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.prefix,
      definition.select_option_order_mode as "optionOrderMode",
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    inner join ticketing.task_collections as collection
      on collection.collection_id = schema.collection_id
      and collection.tenant_id = schema.tenant_id
    left join ticketing.task_person_property_configurations as person_configuration
      on person_configuration.property_definition_id = definition.property_definition_id
      and person_configuration.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    for update of definition
  `);
  const currentRow = rowsFromResult<ConfigurableDefinitionRow>(currentResult).at(0);
  if (currentRow === undefined) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.stale_missing_or_name_conflict',
      message:
        'The Task Property Definition changed elsewhere, was removed, or the name is already in use.',
    });
  }
  const currentDefinition = await projectDefinition(currentRow);
  if (
    currentDefinition.hidden === input.hidden &&
    currentDefinition.mandatory === input.mandatory &&
    currentDefinition.name === name
  ) {
    services.markNoOp();
    return {
      definition: currentDefinition,
    };
  }

  const result = await services.tx.execute(sql`
    update ticketing.task_property_definitions as definition
    set
      hidden = ${input.hidden},
      mandatory = ${input.mandatory},
      name = ${name},
      revision = definition.revision + 1
    from ticketing.task_schemas as schema
    inner join ticketing.task_collections as collection
      on collection.collection_id = schema.collection_id
      and collection.tenant_id = schema.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.schema_id = schema.schema_id
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
      and not exists (
        select 1
        from ticketing.task_property_definitions as sibling
        where sibling.schema_id = definition.schema_id
          and sibling.property_definition_id <> definition.property_definition_id
          and lower(sibling.name) = lower(${name})
      )
    returning
      collection.locale as "collectionLocale",
      (
        select person_configuration.cardinality
        from ticketing.task_person_property_configurations as person_configuration
        where person_configuration.property_definition_id = definition.property_definition_id
          and person_configuration.tenant_id = definition.tenant_id
      ) as cardinality,
      definition.datatype,
      definition.date_range_time_enabled as "timeEnabled",
      definition.number_format as format,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.prefix,
      definition.select_option_order_mode as "optionOrderMode",
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
  `);
  const definitionRow = rowsFromResult<ConfigurableDefinitionRow>(result).at(0);
  if (definitionRow === undefined) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.stale_missing_or_name_conflict',
      message:
        'The Task Property Definition changed elsewhere, was removed, or the name is already in use.',
    });
  }
  const definition = await projectDefinition(definitionRow);

  return {
    definition,
  };
};

export const configureTaskPropertyDefinitionActionRegistration: ActionRegistration<
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: configureTaskPropertyDefinitionActionKey,
    auditEvent: configureTaskPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: configureTaskPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: configureTaskPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: configureTaskPropertyDefinitionActionResponseSchema,
  },
  handler: configureTaskPropertyDefinitionActionHandler,
};
