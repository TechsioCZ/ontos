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
  createEmailPropertyDefinitionActionKey,
  createEmailPropertyDefinitionActionPayloadSchema,
  createEmailPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-email-property-definition.ts';
import type {
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse,
} from '../../shared/actions/create-email-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface EmailPropertyDefinitionRow {
  readonly datatype: 'email';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const emailPropertyDefinitionEvidence = (
  input: CreateEmailPropertyDefinitionActionPayload,
  response: CreateEmailPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: response.definition.datatype,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const createEmailPropertyDefinitionAuditEvent = {
  evidence: emailPropertyDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse
>;

const createEmailPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: emailPropertyDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse
>;

const createEmailPropertyDefinitionActionHandler: ActionHandler<
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createEmailPropertyDefinition.name_required',
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
      'email',
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
  const definition = rowsFromResult<EmailPropertyDefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createEmailPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }

  return { definition };
};

export const createEmailPropertyDefinitionActionRegistration: ActionRegistration<
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createEmailPropertyDefinitionActionKey,
    auditEvent: createEmailPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createEmailPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createEmailPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createEmailPropertyDefinitionActionResponseSchema,
  },
  handler: createEmailPropertyDefinitionActionHandler,
};
