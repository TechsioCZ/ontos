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
  configureNumberPropertyFormatActionKey,
  configureNumberPropertyFormatActionPayloadSchema,
  configureNumberPropertyFormatActionResponseSchema,
} from '../../shared/actions/configure-number-property-format.ts';
import type {
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse,
} from '../../shared/actions/configure-number-property-format.ts';

const numberFormatEvidence = (
  input: ConfigureNumberPropertyFormatActionPayload,
  response: ConfigureNumberPropertyFormatActionResponse,
) => ({
  changedComponents: ['definitionConfiguration'],
  collectionId: input.collectionId,
  datatype: 'number',
  operation: 'format_changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definition.revision,
});

const configureNumberPropertyFormatAuditEvent = {
  evidence: numberFormatEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse
>;

const configureNumberPropertyFormatDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.configured',
  payload: numberFormatEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse
>;

const configureNumberPropertyFormatActionHandler: ActionHandler<
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse
> = async (input, services) => {
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
      and definition.datatype = 'number'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition
  `);
  const current =
    rowsFromResult<ConfigureNumberPropertyFormatActionResponse['definition']>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.configureNumberPropertyFormat.stale_or_missing',
      message: 'The Number definition changed elsewhere or is no longer available.',
    });
  }
  if (current.format === input.format) {
    services.markNoOp();
    return { definition: current };
  }

  const result = await services.tx.execute(sql`
    update ticketing.task_property_definitions as definition
    set
      number_format = ${input.format},
      revision = definition.revision + 1
    from ticketing.task_schemas as schema
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.datatype = 'number'
      and definition.schema_id = schema.schema_id
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    returning
      definition.datatype,
      definition.number_format as format,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
  `);
  const definition =
    rowsFromResult<ConfigureNumberPropertyFormatActionResponse['definition']>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureNumberPropertyFormat.stale_or_missing',
      message: 'The Number definition changed elsewhere or is no longer available.',
    });
  }
  return { definition };
};

export const configureNumberPropertyFormatActionRegistration: ActionRegistration<
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse
> = {
  descriptor: {
    actionKey: configureNumberPropertyFormatActionKey,
    auditEvent: configureNumberPropertyFormatAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: configureNumberPropertyFormatDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: configureNumberPropertyFormatActionPayloadSchema,
    transportResponseSchema: configureNumberPropertyFormatActionResponseSchema,
  },
  handler: configureNumberPropertyFormatActionHandler,
};
