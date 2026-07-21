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
  configureIdPropertyPrefixActionKey,
  configureIdPropertyPrefixActionPayloadSchema,
  configureIdPropertyPrefixActionResponseSchema,
} from '../../shared/actions/configure-id-property-prefix.ts';
import type {
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse,
} from '../../shared/actions/configure-id-property-prefix.ts';
import type { IdPropertyDefinition } from '../../shared/task-property-definition.ts';

const configuredPrefixEvidence = (
  input: ConfigureIdPropertyPrefixActionPayload,
  response: ConfigureIdPropertyPrefixActionResponse,
) => ({
  changedComponents: ['definitionConfiguration'],
  collectionId: input.collectionId,
  datatype: 'id',
  operation: 'configured',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const configureIdPropertyPrefixAuditEvent = {
  evidence: configuredPrefixEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse
>;

const configureIdPropertyPrefixDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.configured',
  payload: configuredPrefixEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse
>;

const configureIdPropertyPrefixActionHandler: ActionHandler<
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse
> = async (input, services) => {
  const prefix = input.prefix.trim();
  const currentResult = await services.tx.execute(sql`
    select
      definition.datatype,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.prefix,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.datatype = 'id'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    for update of definition
  `);
  const current = rowsFromResult<IdPropertyDefinition>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.configureIdPropertyPrefix.stale_or_missing',
      message: 'The ID Task Property Definition changed elsewhere or is no longer available.',
    });
  }
  if (current.prefix === prefix) {
    services.markNoOp();
    return { definition: current };
  }

  const result = await services.tx.execute(sql`
    update ticketing.task_property_definitions as definition
    set prefix = ${prefix}, revision = definition.revision + 1
    from ticketing.task_schemas as schema
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.datatype = 'id'
      and definition.schema_id = schema.schema_id
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    returning
      definition.datatype,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.prefix,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
  `);
  const definition = rowsFromResult<IdPropertyDefinition>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureIdPropertyPrefix.stale_or_missing',
      message: 'The ID Task Property Definition changed elsewhere or is no longer available.',
    });
  }
  return { definition };
};

export const configureIdPropertyPrefixActionRegistration: ActionRegistration<
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse
> = {
  descriptor: {
    actionKey: configureIdPropertyPrefixActionKey,
    auditEvent: configureIdPropertyPrefixAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: configureIdPropertyPrefixDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: configureIdPropertyPrefixActionPayloadSchema,
    transportResponseSchema: configureIdPropertyPrefixActionResponseSchema,
  },
  handler: configureIdPropertyPrefixActionHandler,
};
