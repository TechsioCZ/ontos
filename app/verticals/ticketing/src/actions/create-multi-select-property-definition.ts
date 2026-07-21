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
  createMultiSelectPropertyDefinitionActionKey,
  createMultiSelectPropertyDefinitionActionPayloadSchema,
  createMultiSelectPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-multi-select-property-definition.ts';
import type {
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse,
} from '../../shared/actions/create-multi-select-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

const evidence = (
  input: CreateMultiSelectPropertyDefinitionActionPayload,
  response: CreateMultiSelectPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'valueEnvelopes'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse
>;

const handler: ActionHandler<
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  const result = await services.tx.execute(sql`
    with inserted_definition as (
      insert into ticketing.task_property_definitions (
        datatype, mandatory, name, schema_id, tenant_id
      )
      select 'multi_select', ${input.mandatory}, ${name}, schema.schema_id, ${services.context.tenantId}
      from ticketing.task_schemas as schema
      where schema.collection_id = ${input.collectionId}
        and schema.tenant_id = ${services.context.tenantId}
      on conflict do nothing
      returning
        datatype,
        hidden,
        mandatory,
        name,
        property_definition_id,
        revision,
        schema_id
    ), initialized_values as (
      insert into ticketing.task_multi_select_values (
        property_definition_id, task_id, tenant_id
      )
      select
        inserted_definition.property_definition_id,
        task.task_id,
        ${services.context.tenantId}
      from inserted_definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = inserted_definition.schema_id
      inner join ticketing.tasks as task
        on task.collection_id = schema.collection_id
        and task.tenant_id = ${services.context.tenantId}
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
  const definition =
    rowsFromResult<CreateMultiSelectPropertyDefinitionActionResponse['definition']>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createMultiSelectPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition: { ...definition, options: [] } };
};

export const createMultiSelectPropertyDefinitionActionRegistration: ActionRegistration<
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createMultiSelectPropertyDefinitionActionKey,
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
    transportRequestSchema: createMultiSelectPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createMultiSelectPropertyDefinitionActionResponseSchema,
  },
  handler,
};
