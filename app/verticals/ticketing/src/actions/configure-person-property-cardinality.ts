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
  configurePersonPropertyCardinalityActionKey,
  configurePersonPropertyCardinalityActionPayloadSchema,
  configurePersonPropertyCardinalityActionResponseSchema,
} from '../../shared/actions/configure-person-property-cardinality.ts';
import type {
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse,
} from '../../shared/actions/configure-person-property-cardinality.ts';
import type { PersonPropertyDefinition } from '../../shared/task-property-definition.ts';

type CardinalityTargetRow = PersonPropertyDefinition;

interface ViolatingTaskCountRow {
  readonly violatingTaskCount: number;
}

const cardinalityEvidence = (
  input: ConfigurePersonPropertyCardinalityActionPayload,
  response: ConfigurePersonPropertyCardinalityActionResponse,
) => ({
  changedComponents: ['personCardinality'],
  collectionId: input.collectionId,
  datatype: 'person',
  operation: 'configured',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definition.revision,
});

const configurePersonPropertyCardinalityAuditEvent = {
  evidence: cardinalityEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse
>;

const configurePersonPropertyCardinalityDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.configured',
  payload: cardinalityEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse
>;

const configurePersonPropertyCardinalityActionHandler: ActionHandler<
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse
> = async (input, services) => {
  const targetResult = await services.tx.execute(sql`
    select
      configuration.cardinality,
      definition.datatype,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_person_property_configurations as configuration
      on configuration.property_definition_id = definition.property_definition_id
      and configuration.tenant_id = definition.tenant_id
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.datatype = 'person'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition, configuration
  `);
  const current = rowsFromResult<CardinalityTargetRow>(targetResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.configurePersonPropertyCardinality.stale_or_missing',
      message: 'The Person Task Property changed elsewhere or is no longer available.',
    });
  }
  if (current.cardinality === input.cardinality) {
    services.markNoOp();
    return { definition: current };
  }

  if (input.cardinality === 'one') {
    const countResult = await services.tx.execute(sql`
      select count(*)::integer as "violatingTaskCount"
      from (
        select assignment.task_id
        from ticketing.task_person_assignments as assignment
        inner join ticketing.tasks as task
          on task.task_id = assignment.task_id
          and task.tenant_id = assignment.tenant_id
        where assignment.property_definition_id = ${input.propertyDefinitionId}
          and assignment.tenant_id = ${services.context.tenantId}
          and task.collection_id = ${input.collectionId}
        group by assignment.task_id
        having count(*) > 1
      ) as violation
    `);
    const violatingTaskCount =
      rowsFromResult<ViolatingTaskCountRow>(countResult).at(0)?.violatingTaskCount ?? 0;
    if (violatingTaskCount > 0) {
      throw rejectAction({
        code: 'ticketing.configurePersonPropertyCardinality.assignments_violate_limit',
        message: `${violatingTaskCount} retained Task${violatingTaskCount === 1 ? '' : 's'} have multiple Person assignments.`,
        state: { violatingTaskCount },
      });
    }
  }

  const updatedResult = await services.tx.execute(sql`
    with updated_configuration as (
      update ticketing.task_person_property_configurations
      set cardinality = ${input.cardinality}
      where property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
      returning cardinality, property_definition_id
    ),
    updated_definition as (
      update ticketing.task_property_definitions as definition
      set revision = definition.revision + 1
      from updated_configuration
      where definition.property_definition_id = updated_configuration.property_definition_id
        and definition.revision = ${input.expectedRevision}
        and definition.tenant_id = ${services.context.tenantId}
      returning
        definition.datatype,
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.property_definition_id,
        definition.revision
    )
    select
      updated_configuration.cardinality,
      updated_definition.datatype,
      updated_definition.hidden,
      updated_definition.mandatory,
      updated_definition.name,
      updated_definition.property_definition_id as "propertyDefinitionId",
      updated_definition.revision
    from updated_definition
    inner join updated_configuration using (property_definition_id)
  `);
  const definition = rowsFromResult<PersonPropertyDefinition>(updatedResult).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.configurePersonPropertyCardinality.stale_or_missing',
      message: 'The Person Task Property changed elsewhere or is no longer available.',
    });
  }
  return { definition };
};

export const configurePersonPropertyCardinalityActionRegistration: ActionRegistration<
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse
> = {
  descriptor: {
    actionKey: configurePersonPropertyCardinalityActionKey,
    auditEvent: configurePersonPropertyCardinalityAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: configurePersonPropertyCardinalityDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: configurePersonPropertyCardinalityActionPayloadSchema,
    transportResponseSchema: configurePersonPropertyCardinalityActionResponseSchema,
  },
  handler: configurePersonPropertyCardinalityActionHandler,
};
