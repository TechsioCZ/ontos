// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  createTaskCollectionActionKey,
  createTaskCollectionActionPayloadSchema,
  createTaskCollectionActionResponseSchema,
} from '../../shared/actions/create-task-collection.ts';
import type {
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse,
} from '../../shared/actions/create-task-collection.ts';
import { taskCollectionCreationFromRow } from '../task-collection-aggregate.ts';
import type { TaskCollectionCreationRow } from '../task-collection-aggregate.ts';

const createTaskCollectionDomainEvent = {
  eventType: 'ticketing.taskCollection.created',
  payload: (_input, response) => ({
    collectionId: response.collection.collectionId,
    schemaId: response.schema.schemaId,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.collection.collectionId,
  subjectResourceType: 'task_collection',
} satisfies ActionDomainEventDescriptor<
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse
>;

const createTaskCollectionActionHandler: ActionHandler<
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse
> = async (_input, services) => {
  const creationResult = await services.tx.execute(sql`
    with created_collection as (
      insert into ticketing.task_collections (locale, tenant_id)
      select tenant.default_locale, tenant.tenant_id
      from core.tenants as tenant
      where tenant.tenant_id = ${services.context.tenantId}
      returning collection_id, created_at
    ),
    created_schema as (
      insert into ticketing.task_schemas (collection_id, tenant_id)
      select collection_id, ${services.context.tenantId}
      from created_collection
      returning collection_id, schema_id
    ),
    created_title_definition as (
      insert into ticketing.task_property_definitions (
        datatype,
        mandatory,
        name,
        schema_id,
        tenant_id
      )
      select 'title', false, 'Title', schema_id, ${services.context.tenantId}
      from created_schema
      returning datatype, mandatory, name, property_definition_id, schema_id
    )
    select
      created_collection.collection_id as "collectionId",
      to_char(
        created_collection.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "collectionCreatedAt",
      created_schema.schema_id as "schemaId",
      created_title_definition.datatype as "datatype",
      created_title_definition.mandatory as "mandatory",
      created_title_definition.name as "name",
      created_title_definition.property_definition_id as "propertyDefinitionId"
    from created_collection
    inner join created_schema using (collection_id)
    cross join created_title_definition
  `);
  const created = rowsFromResult<TaskCollectionCreationRow>(creationResult).at(0);

  if (created === undefined || created.datatype !== 'title') {
    throw rejectAction({
      code: 'ticketing.createTaskCollection.aggregate_not_created',
      message: 'Task Collection and its schema could not be created.',
    });
  }

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: createTaskCollectionActionKey,
      collectionId: created.collectionId,
      schemaId: created.schemaId,
    },
    topic: 'ticketing.taskCollection.created',
  });

  return taskCollectionCreationFromRow(created);
};

export const createTaskCollectionActionRegistration: ActionRegistration<
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse
> = {
  descriptor: {
    actionKey: createTaskCollectionActionKey,
    auditProfile: 'standard',
    domainEvent: createTaskCollectionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createTaskCollectionActionPayloadSchema,
    transportResponseSchema: createTaskCollectionActionResponseSchema,
  },
  handler: createTaskCollectionActionHandler,
};
