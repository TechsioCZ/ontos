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
  duplicateTaskPropertyDefinitionActionKey,
  duplicateTaskPropertyDefinitionActionPayloadSchema,
  duplicateTaskPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/duplicate-task-property-definition.ts';
import type {
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse,
} from '../../shared/actions/duplicate-task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface DuplicatedDefinitionRow {
  readonly datatype: 'checkbox';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const duplicatedDefinitionEvidence = (
  input: DuplicateTaskPropertyDefinitionActionPayload,
  response: DuplicateTaskPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'checkboxValues'],
  collectionId: input.collectionId,
  copiedValues: input.copyValues,
  datatype: response.definition.datatype,
  operation: 'duplicated',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
  sourcePropertyDefinitionId: input.propertyDefinitionId,
});

const duplicateTaskPropertyDefinitionAuditEvent = {
  evidence: duplicatedDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
>;

const duplicateTaskPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.duplicated',
  payload: duplicatedDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
>;

const duplicateTaskPropertyDefinitionActionHandler: ActionHandler<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
> = async (input, services) => {
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const result = await services.tx.execute(sql`
    with source_definition as (
      select definition.*
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.revision = ${input.expectedRevision}
        and definition.datatype = 'checkbox'
        and definition.tenant_id = ${services.context.tenantId}
        and schema.collection_id = ${input.collectionId}
    ),
    available_name as (
      select
        case
          when candidate.ordinal = 1 then source_definition.name || ' Copy'
          else source_definition.name || ' Copy ' || candidate.ordinal::text
        end as name
      from source_definition
      cross join lateral generate_series(1, (
        select count(*)::integer + 1
        from ticketing.task_property_definitions as sibling
        where sibling.schema_id = source_definition.schema_id
      )) as candidate(ordinal)
      where not exists (
        select 1
        from ticketing.task_property_definitions as sibling
        where sibling.schema_id = source_definition.schema_id
          and lower(sibling.name) = lower(
            case
              when candidate.ordinal = 1 then source_definition.name || ' Copy'
              else source_definition.name || ' Copy ' || candidate.ordinal::text
            end
          )
      )
      order by candidate.ordinal
      limit 1
    ),
    inserted_definition as (
      insert into ticketing.task_property_definitions (
        datatype,
        hidden,
        mandatory,
        name,
        schema_id,
        tenant_id
      )
      select
        source_definition.datatype,
        source_definition.hidden,
        source_definition.mandatory,
        available_name.name,
        source_definition.schema_id,
        source_definition.tenant_id
      from source_definition
      cross join available_name
      returning datatype, hidden, mandatory, name, property_definition_id, revision
    ),
    copied_values as (
      insert into ticketing.task_checkbox_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        inserted_definition.property_definition_id,
        source_value.task_id,
        source_value.tenant_id,
        case when ${input.copyValues} then source_value.value else false end
      from inserted_definition
      inner join source_definition on true
      inner join ticketing.task_checkbox_values as source_value
        on source_value.property_definition_id = source_definition.property_definition_id
        and source_value.tenant_id = source_definition.tenant_id
      returning task_id
    )
    select
      inserted_definition.datatype,
      inserted_definition.hidden,
      inserted_definition.mandatory,
      inserted_definition.name,
      inserted_definition.property_definition_id as "propertyDefinitionId",
      inserted_definition.revision
    from inserted_definition
  `);
  const definition = rowsFromResult<DuplicatedDefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.duplicateTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }

  return { definition };
};

export const duplicateTaskPropertyDefinitionActionRegistration: ActionRegistration<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: duplicateTaskPropertyDefinitionActionKey,
    auditEvent: duplicateTaskPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: duplicateTaskPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: duplicateTaskPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: duplicateTaskPropertyDefinitionActionResponseSchema,
  },
  handler: duplicateTaskPropertyDefinitionActionHandler,
};
