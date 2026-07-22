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
  configureDateRangeTimeSupportActionKey,
  configureDateRangeTimeSupportActionPayloadSchema,
  configureDateRangeTimeSupportActionResponseSchema,
} from '../../shared/actions/configure-date-range-time-support.ts';
import type {
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse,
} from '../../shared/actions/configure-date-range-time-support.ts';

interface TargetRow {
  readonly datatype: 'date_range';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly timeEnabled: boolean;
}
interface CountRow {
  readonly affectedValueCount: number;
}

const evidence = (
  input: ConfigureDateRangeTimeSupportActionPayload,
  response: ConfigureDateRangeTimeSupportActionResponse,
) => ({
  affectedValueCount: response.affectedValueCount,
  changedComponents: [
    'configuration',
    ...(response.affectedValueCount > 0 ? ['propertyValues'] : []),
  ],
  collectionId: input.collectionId,
  datatype: 'date_range',
  operation: input.timeEnabled ? 'time_enabled' : 'time_disabled',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definition.revision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.configured',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse
>;

const handler: ActionHandler<
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse
> = async (input, services) => {
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !Number.isInteger(input.expectedAffectedValueCount) ||
    input.expectedAffectedValueCount < 0
  ) {
    throw rejectAction({
      code: 'ticketing.configureDateRangeTimeSupport.invalid_expectation',
      message: 'Expected revision and affected-value count must be non-negative integers.',
    });
  }
  const targetResult = await services.tx.execute(sql`
    select
      definition.datatype,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision,
      definition.date_range_time_enabled as "timeEnabled"
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'date_range'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition
  `);
  const target = rowsFromResult<TargetRow>(targetResult).at(0);
  if (target === undefined || target.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.configureDateRangeTimeSupport.stale_or_missing',
      message: 'The Date Range definition changed elsewhere or is no longer available.',
    });
  }
  if (target.timeEnabled === input.timeEnabled) {
    services.markNoOp();
    return { affectedValueCount: 0, definition: target };
  }

  const countResult = await services.tx.execute(sql`
    select count(*)::integer as "affectedValueCount"
    from ticketing.task_date_range_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id and task.tenant_id = value.tenant_id
    where value.property_definition_id = ${input.propertyDefinitionId}
      and value.tenant_id = ${services.context.tenantId}
      and value.start_time is not null and value.end_time is not null
  `);
  const affectedValueCount = rowsFromResult<CountRow>(countResult).at(0)?.affectedValueCount ?? 0;
  if (!input.timeEnabled) {
    if (!input.confirmed) {
      throw rejectAction({
        code: 'ticketing.configureDateRangeTimeSupport.confirmation_required',
        message: 'Disabling Date Range time support requires confirmation.',
        state: { affectedValueCount },
      });
    }
    if (input.expectedAffectedValueCount !== affectedValueCount) {
      throw rejectAction({
        code: 'ticketing.configureDateRangeTimeSupport.impact_changed',
        message: 'The number of Date Range values containing times changed.',
        state: { affectedValueCount },
      });
    }
    await services.tx.execute(sql`
      update ticketing.task_date_range_values
      set end_time = null, start_time = null, revision = revision + 1
      where property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
        and start_time is not null and end_time is not null
    `);
  }
  const updateResult = await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set date_range_time_enabled = ${input.timeEnabled}, revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedRevision}
      and tenant_id = ${services.context.tenantId}
    returning datatype, hidden, mandatory, name,
      property_definition_id as "propertyDefinitionId", revision,
      date_range_time_enabled as "timeEnabled"
  `);
  const definition = rowsFromResult<TargetRow>(updateResult).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configureDateRangeTimeSupport.stale_or_missing',
      message: 'The Date Range definition changed elsewhere or is no longer available.',
    });
  }
  return { affectedValueCount: input.timeEnabled ? 0 : affectedValueCount, definition };
};

export const configureDateRangeTimeSupportActionRegistration: ActionRegistration<
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse
> = {
  descriptor: {
    actionKey: configureDateRangeTimeSupportActionKey,
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
    transportRequestSchema: configureDateRangeTimeSupportActionPayloadSchema,
    transportResponseSchema: configureDateRangeTimeSupportActionResponseSchema,
  },
  handler,
};
