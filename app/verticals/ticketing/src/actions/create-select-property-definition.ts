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
  createSelectPropertyDefinitionActionKey,
  createSelectPropertyDefinitionActionPayloadSchema,
  createSelectPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-select-property-definition.ts';
import type {
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse,
} from '../../shared/actions/create-select-property-definition.ts';
import type { SelectPropertyDefinition } from '../../shared/task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';

type SelectDefinitionRow = Omit<SelectPropertyDefinition, 'options' | 'optionOrderMode'> & {
  readonly optionOrderMode: SelectPropertyDefinition['optionOrderMode'];
};

const evidence = (
  input: CreateSelectPropertyDefinitionActionPayload,
  response: CreateSelectPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition'],
  collectionId: input.collectionId,
  datatype: 'select',
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
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse
>;

const handler: ActionHandler<
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createSelectPropertyDefinition.name_required',
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
      datatype, mandatory, name, schema_id, select_option_order_mode, tenant_id
    )
    select 'select', ${input.mandatory}, ${name}, schema.schema_id, 'manual', ${services.context.tenantId}
    from ticketing.task_schemas as schema
    where schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    on conflict do nothing
    returning
      datatype,
      hidden,
      mandatory,
      name,
      select_option_order_mode as "optionOrderMode",
      property_definition_id as "propertyDefinitionId",
      revision
  `);
  const row = rowsFromResult<SelectDefinitionRow>(result).at(0);
  if (row === undefined) {
    throw rejectAction({
      code: 'ticketing.createSelectPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }
  return { definition: { ...row, options: [] } };
};

export const createSelectPropertyDefinitionActionRegistration: ActionRegistration<
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createSelectPropertyDefinitionActionKey,
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
    transportRequestSchema: createSelectPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createSelectPropertyDefinitionActionResponseSchema,
  },
  handler,
};
