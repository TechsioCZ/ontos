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
  createPhonePropertyDefinitionActionKey,
  createPhonePropertyDefinitionActionPayloadSchema,
  createPhonePropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-phone-property-definition.ts';
import type {
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse,
} from '../../shared/actions/create-phone-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface PhonePropertyDefinitionRow {
  readonly datatype: 'phone';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const phonePropertyDefinitionEvidence = (
  input: CreatePhonePropertyDefinitionActionPayload,
  response: CreatePhonePropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createPhonePropertyDefinitionAuditEvent = {
  evidence: phonePropertyDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse
>;

const createPhonePropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: phonePropertyDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse
>;

const createPhonePropertyDefinitionActionHandler: ActionHandler<
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createPhonePropertyDefinition.name_required',
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
      schema_id,
      tenant_id
    )
    select
      'phone',
      ${input.mandatory},
      ${name},
      schema.schema_id,
      ${services.context.tenantId}
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
  const definition = rowsFromResult<PhonePropertyDefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createPhonePropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createPhonePropertyDefinitionActionRegistration: ActionRegistration<
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createPhonePropertyDefinitionActionKey,
    auditEvent: createPhonePropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createPhonePropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createPhonePropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createPhonePropertyDefinitionActionResponseSchema,
  },
  handler: createPhonePropertyDefinitionActionHandler,
};
