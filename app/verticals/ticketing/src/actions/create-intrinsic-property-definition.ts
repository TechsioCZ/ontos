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
  createIntrinsicPropertyDefinitionActionKey,
  createIntrinsicPropertyDefinitionActionPayloadSchema,
  createIntrinsicPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-intrinsic-property-definition.ts';
import type {
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse,
} from '../../shared/actions/create-intrinsic-property-definition.ts';
import type { IntrinsicPropertyDefinition } from '../../shared/task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

const createdDefinitionEvidence = (
  input: CreateIntrinsicPropertyDefinitionActionPayload,
  response: CreateIntrinsicPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  mandatory: response.definition.mandatory,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createIntrinsicPropertyDefinitionAuditEvent = {
  evidence: createdDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse
>;

const createIntrinsicPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: createdDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse
>;

const createIntrinsicPropertyDefinitionActionHandler: ActionHandler<
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createIntrinsicPropertyDefinition.name_required',
      message: 'The Task Property name must not be empty.',
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
      schema_id,
      tenant_id
    )
    select
      ${input.datatype},
      ${input.mandatory},
      ${name},
      schema.schema_id,
      schema.tenant_id
    from ticketing.task_schemas as schema
    where schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    on conflict do nothing
    returning
      datatype,
      hidden,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision
  `);
  const definition = rowsFromResult<IntrinsicPropertyDefinition>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createIntrinsicPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createIntrinsicPropertyDefinitionActionRegistration: ActionRegistration<
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createIntrinsicPropertyDefinitionActionKey,
    auditEvent: createIntrinsicPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createIntrinsicPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createIntrinsicPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createIntrinsicPropertyDefinitionActionResponseSchema,
  },
  handler: createIntrinsicPropertyDefinitionActionHandler,
};
