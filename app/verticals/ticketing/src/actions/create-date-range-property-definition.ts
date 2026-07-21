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
  createDateRangePropertyDefinitionActionKey,
  createDateRangePropertyDefinitionActionPayloadSchema,
  createDateRangePropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-date-range-property-definition.ts';
import type {
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse,
} from '../../shared/actions/create-date-range-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

interface DefinitionRow {
  readonly datatype: 'date_range';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly timeEnabled: boolean;
}

const evidence = (
  input: CreateDateRangePropertyDefinitionActionPayload,
  response: CreateDateRangePropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: 'date_range',
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
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse
>;

const handler: ActionHandler<
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createDateRangePropertyDefinition.name_required',
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
      date_range_time_enabled,
      mandatory,
      name,
      schema_id,
      tenant_id
    )
    select
      'date_range',
      false,
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
      revision,
      date_range_time_enabled as "timeEnabled"
  `);
  const definition = rowsFromResult<DefinitionRow>(result).at(0);
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createDateRangePropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition };
};

export const createDateRangePropertyDefinitionActionRegistration: ActionRegistration<
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createDateRangePropertyDefinitionActionKey,
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
    transportRequestSchema: createDateRangePropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createDateRangePropertyDefinitionActionResponseSchema,
  },
  handler,
};
