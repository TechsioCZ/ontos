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
import type { TaskPropertyDefinition } from '../../shared/task-property-definition.ts';

const configuredDefinition = (definition: TaskPropertyDefinition): TaskPropertyDefinition => {
  if (definition.datatype === 'checkbox') {
    return {
      datatype: 'checkbox',
      hidden: definition.hidden,
      mandatory: definition.mandatory,
      name: definition.name,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: definition.revision,
    };
  }
  if (definition.datatype === 'number' || definition.datatype === 'select') {
    return definition;
  }
  if (definition.datatype === 'phone') {
    return {
      datatype: 'phone',
      hidden: definition.hidden,
      mandatory: definition.mandatory,
      name: definition.name,
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: definition.revision,
    };
  }
  return {
    datatype: 'text',
    hidden: definition.hidden,
    mandatory: definition.mandatory,
    name: definition.name,
    propertyDefinitionId: definition.propertyDefinitionId,
    revision: definition.revision,
  };
};

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
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      definition.datatype,
      definition.number_format as format,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    for update of definition
  `);
  const currentDefinition = rowsFromResult<TaskPropertyDefinition>(currentResult).at(0);
  if (currentDefinition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.stale_missing_or_name_conflict',
      message:
        'The Task Property Definition changed elsewhere, was removed, or the name is already in use.',
    });
  }
  if (
    currentDefinition.hidden === input.hidden &&
    currentDefinition.mandatory === input.mandatory &&
    currentDefinition.name === name
  ) {
    services.markNoOp();
    return {
      definition: configuredDefinition(currentDefinition),
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
      definition.datatype,
      definition.number_format as format,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
  `);
  const definition = rowsFromResult<TaskPropertyDefinition>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureTaskPropertyDefinition.stale_missing_or_name_conflict',
      message:
        'The Task Property Definition changed elsewhere, was removed, or the name is already in use.',
    });
  }

  return {
    definition: configuredDefinition(definition),
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
