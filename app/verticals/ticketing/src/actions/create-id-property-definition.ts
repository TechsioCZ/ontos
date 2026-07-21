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
  createIdPropertyDefinitionActionKey,
  createIdPropertyDefinitionActionPayloadSchema,
  createIdPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-id-property-definition.ts';
import type {
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse,
} from '../../shared/actions/create-id-property-definition.ts';
import type { IdPropertyDefinition } from '../../shared/task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

const idPropertyDefinitionEvidence = (
  input: CreateIdPropertyDefinitionActionPayload,
  response: CreateIdPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'idAssignments'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createIdPropertyDefinitionAuditEvent = {
  evidence: idPropertyDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse
>;

const createIdPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: idPropertyDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse
>;

const createIdPropertyDefinitionActionHandler: ActionHandler<
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  const prefix = input.prefix.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createIdPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }

  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const result = await services.tx.execute(sql`
    with selected_schema as (
      select schema.schema_id
      from ticketing.task_schemas as schema
      where schema.collection_id = ${input.collectionId}
        and schema.tenant_id = ${services.context.tenantId}
    ),
    inserted_definition as (
      insert into ticketing.task_property_definitions (
        datatype,
        mandatory,
        name,
        prefix,
        schema_id,
        tenant_id
      )
      select
        'id',
        ${input.mandatory},
        ${name},
        ${prefix},
        schema_id,
        ${services.context.tenantId}
      from selected_schema
      on conflict do nothing
      returning datatype, hidden, mandatory, name, prefix, property_definition_id, revision
    ),
    initialized_assignments as (
      insert into ticketing.task_id_assignments (
        number,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        row_number() over (order by task.created_at, task.creation_ordinal)::bigint,
        inserted_definition.property_definition_id,
        task.task_id,
        ${services.context.tenantId}
      from inserted_definition
      inner join ticketing.tasks as task
        on task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning number
    ),
    initialized_sequence as (
      insert into ticketing.task_id_sequences (
        collection_id,
        next_number,
        property_definition_id,
        tenant_id
      )
      select
        ${input.collectionId},
        coalesce((select max(number) + 1 from initialized_assignments), 1),
        inserted_definition.property_definition_id,
        ${services.context.tenantId}
      from inserted_definition
      returning property_definition_id
    )
    select
      inserted_definition.datatype,
      inserted_definition.hidden,
      inserted_definition.mandatory,
      inserted_definition.name,
      inserted_definition.prefix,
      inserted_definition.property_definition_id as "propertyDefinitionId",
      inserted_definition.revision
    from inserted_definition
    inner join initialized_sequence using (property_definition_id)
  `);
  const definition = rowsFromResult<IdPropertyDefinition>(result).at(0);

  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createIdPropertyDefinition.not_created',
      message:
        'The Task Collection was not found, the property name is already in use, or an ID definition is already active.',
    });
  }

  return { definition };
};

export const createIdPropertyDefinitionActionRegistration: ActionRegistration<
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createIdPropertyDefinitionActionKey,
    auditEvent: createIdPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createIdPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createIdPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createIdPropertyDefinitionActionResponseSchema,
  },
  handler: createIdPropertyDefinitionActionHandler,
};
