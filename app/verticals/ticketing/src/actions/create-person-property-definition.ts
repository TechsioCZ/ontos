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
  createPersonPropertyDefinitionActionKey,
  createPersonPropertyDefinitionActionPayloadSchema,
  createPersonPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-person-property-definition.ts';
import type {
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse,
} from '../../shared/actions/create-person-property-definition.ts';
import type { PersonPropertyDefinition } from '../../shared/task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

const personDefinitionEvidence = (
  input: CreatePersonPropertyDefinitionActionPayload,
  response: CreatePersonPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: 'person',
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createPersonPropertyDefinitionAuditEvent = {
  evidence: personDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse
>;

const createPersonPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: personDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse
>;

const createPersonPropertyDefinitionActionHandler: ActionHandler<
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createPersonPropertyDefinition.name_required',
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
        schema_id,
        tenant_id
      )
      select
        'person',
        ${input.mandatory},
        ${name},
        schema_id,
        ${services.context.tenantId}
      from selected_schema
      on conflict do nothing
      returning hidden, mandatory, name, property_definition_id, revision
    ),
    inserted_configuration as (
      insert into ticketing.task_person_property_configurations (
        cardinality,
        property_definition_id,
        tenant_id
      )
      select
        'unlimited',
        property_definition_id,
        ${services.context.tenantId}
      from inserted_definition
      returning cardinality, property_definition_id
    ),
    initialized_values as (
      insert into ticketing.task_person_values (
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        inserted_definition.property_definition_id,
        task.task_id,
        ${services.context.tenantId}
      from inserted_definition
      inner join ticketing.tasks as task
        on task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning task_id
    )
    select
      inserted_configuration.cardinality,
      'person' as datatype,
      inserted_definition.hidden,
      inserted_definition.mandatory,
      inserted_definition.name,
      inserted_definition.property_definition_id as "propertyDefinitionId",
      inserted_definition.revision
    from inserted_definition
    inner join inserted_configuration using (property_definition_id)
  `);
  const definition = rowsFromResult<PersonPropertyDefinition>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createPersonPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createPersonPropertyDefinitionActionRegistration: ActionRegistration<
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createPersonPropertyDefinitionActionKey,
    auditEvent: createPersonPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createPersonPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createPersonPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createPersonPropertyDefinitionActionResponseSchema,
  },
  handler: createPersonPropertyDefinitionActionHandler,
};
