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
  createNumberPropertyDefinitionActionKey,
  createNumberPropertyDefinitionActionPayloadSchema,
  createNumberPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-number-property-definition.ts';
import type {
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse,
} from '../../shared/actions/create-number-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

const numberPropertyDefinitionEvidence = (
  input: CreateNumberPropertyDefinitionActionPayload,
  response: CreateNumberPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: 'number',
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createNumberPropertyDefinitionAuditEvent = {
  evidence: numberPropertyDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse
>;

const createNumberPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: numberPropertyDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse
>;

const createNumberPropertyDefinitionActionHandler: ActionHandler<
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createNumberPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }

  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  const result = await services.tx.execute(sql`
    insert into ticketing.task_property_definitions (
      datatype,
      mandatory,
      name,
      number_format,
      schema_id,
      tenant_id
    )
    select
      'number',
      ${input.mandatory},
      ${name},
      'number',
      schema.schema_id,
      ${services.context.tenantId}
    from ticketing.task_schemas as schema
    where schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    on conflict do nothing
    returning
      datatype,
      number_format as format,
      hidden,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision
  `);
  const definition =
    rowsFromResult<CreateNumberPropertyDefinitionActionResponse['definition']>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createNumberPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createNumberPropertyDefinitionActionRegistration: ActionRegistration<
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createNumberPropertyDefinitionActionKey,
    auditEvent: createNumberPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createNumberPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createNumberPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createNumberPropertyDefinitionActionResponseSchema,
  },
  handler: createNumberPropertyDefinitionActionHandler,
};
