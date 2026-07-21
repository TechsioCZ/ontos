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
  createFilesMediaPropertyDefinitionActionKey,
  createFilesMediaPropertyDefinitionActionPayloadSchema,
  createFilesMediaPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-files-media-property-definition.ts';
import type {
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse,
} from '../../shared/actions/create-files-media-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface DefinitionRow {
  readonly datatype: 'files_media';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const evidence = (
  input: CreateFilesMediaPropertyDefinitionActionPayload,
  response: CreateFilesMediaPropertyDefinitionActionResponse,
) => ({
  collectionId: input.collectionId,
  datatype: 'files_media',
  mandatory: response.definition.mandatory,
  operation: 'created',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.collectionId,
  targetResourceType: 'task_collection',
} satisfies ActionAuditEventDescriptor<
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse
>;

const handler: ActionHandler<
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createFilesMediaPropertyDefinition.name_required',
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
      datatype, mandatory, name, schema_id, tenant_id
    )
    select
      'files_media', ${input.mandatory}, ${name}, schema.schema_id, ${services.context.tenantId}
    from ticketing.task_schemas as schema
    where schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    on conflict do nothing
    returning datatype, hidden, mandatory, name,
      property_definition_id as "propertyDefinitionId", revision
  `);
  const definition = rowsFromResult<DefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createFilesMediaPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createFilesMediaPropertyDefinitionActionRegistration: ActionRegistration<
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createFilesMediaPropertyDefinitionActionKey,
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
    transportRequestSchema: createFilesMediaPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createFilesMediaPropertyDefinitionActionResponseSchema,
  },
  handler,
};
