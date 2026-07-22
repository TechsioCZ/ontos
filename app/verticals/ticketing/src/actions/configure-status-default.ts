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
  configureStatusDefaultActionKey,
  configureStatusDefaultActionPayloadSchema,
  configureStatusDefaultActionResponseSchema,
} from '../../shared/actions/configure-status-default.ts';
import type {
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse,
} from '../../shared/actions/configure-status-default.ts';
import { getStatusDefinition } from '../status-property.ts';

interface CurrentDefaultRow {
  readonly defaultOptionId: string;
}

const evidence = (
  input: ConfigureStatusDefaultActionPayload,
  response: ConfigureStatusDefaultActionResponse,
) => ({
  changedComponents: ['statusDefault'],
  collectionId: input.collectionId,
  datatype: 'status',
  operation: 'default_changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definition.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.statusDefault.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse
>;

const handler: ActionHandler<
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select configuration.default_option_id as "defaultOptionId"
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    inner join ticketing.status_property_configurations as configuration
      on configuration.property_definition_id = definition.property_definition_id
      and configuration.tenant_id = definition.tenant_id
    inner join ticketing.status_options as option
      on option.option_id = ${input.optionId}
      and option.property_definition_id = definition.property_definition_id
      and option.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'status'
      and definition.revision = ${input.expectedDefinitionRevision}
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition, configuration
  `);
  const current = rowsFromResult<CurrentDefaultRow>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.configureStatusDefault.stale_missing_or_option_invalid',
      message: 'The Status definition changed or the selected Default is unavailable.',
    });
  }
  if (current.defaultOptionId === input.optionId) {
    const definition = await getStatusDefinition({
      collectionId: input.collectionId,
      db: services.tx,
      propertyDefinitionId: input.propertyDefinitionId,
      tenantId: services.context.tenantId,
    });
    if (definition === undefined) {
      throw rejectAction({
        code: 'ticketing.configureStatusDefault.missing',
        message: 'The Status definition is unavailable.',
      });
    }
    services.markNoOp();
    return { definition };
  }
  await services.tx.execute(sql`
    update ticketing.status_property_configurations
    set default_option_id = ${input.optionId}
    where property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedDefinitionRevision}
      and tenant_id = ${services.context.tenantId}
  `);
  const definition = await getStatusDefinition({
    collectionId: input.collectionId,
    db: services.tx,
    propertyDefinitionId: input.propertyDefinitionId,
    tenantId: services.context.tenantId,
  });
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureStatusDefault.stale_or_missing',
      message: 'The Status definition changed or is unavailable.',
    });
  }
  return { definition };
};

export const configureStatusDefaultActionRegistration: ActionRegistration<
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse
> = {
  descriptor: {
    actionKey: configureStatusDefaultActionKey,
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
    transportRequestSchema: configureStatusDefaultActionPayloadSchema,
    transportResponseSchema: configureStatusDefaultActionResponseSchema,
  },
  handler,
};
