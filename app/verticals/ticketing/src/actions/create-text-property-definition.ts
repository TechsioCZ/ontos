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
  createTextPropertyDefinitionActionKey,
  createTextPropertyDefinitionActionPayloadSchema,
  createTextPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-text-property-definition.ts';
import type {
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse,
} from '../../shared/actions/create-text-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface TextPropertyDefinitionRow {
  readonly datatype: 'text';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const textPropertyDefinitionEvidence = (
  input: CreateTextPropertyDefinitionActionPayload,
  response: CreateTextPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createTextPropertyDefinitionAuditEvent = {
  evidence: textPropertyDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse
>;

const createTextPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: textPropertyDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse
>;

const createTextPropertyDefinitionActionHandler: ActionHandler<
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createTextPropertyDefinition.name_required',
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
        'text',
        ${input.mandatory},
        ${name},
        schema_id,
        ${services.context.tenantId}
      from selected_schema
      on conflict do nothing
      returning datatype, hidden, mandatory, name, property_definition_id, revision
    ),
    initialized_values as (
      insert into ticketing.task_text_values (
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
      datatype,
      hidden,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision
    from inserted_definition
  `);
  const definition = rowsFromResult<TextPropertyDefinitionRow>(result).at(0);

  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createTextPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }

  return { definition };
};

export const createTextPropertyDefinitionActionRegistration: ActionRegistration<
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createTextPropertyDefinitionActionKey,
    auditEvent: createTextPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createTextPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createTextPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createTextPropertyDefinitionActionResponseSchema,
  },
  handler: createTextPropertyDefinitionActionHandler,
};
