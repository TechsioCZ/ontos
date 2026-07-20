// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  createTicketActionKey,
  createTicketActionPayloadSchema,
  createTicketActionResponseSchema,
} from '../../shared/actions/create-ticket.ts';
import type {
  CreateTicketActionPayload,
  CreateTicketActionResponse,
} from '../../shared/actions/create-ticket.ts';
import { ticketingPolicies } from '../policies/index.ts';
import { taskCollectionAggregateFromRow } from '../task-collection-aggregate.ts';
import type { TaskCollectionAggregateRow } from '../task-collection-aggregate.ts';

const createTicketDomainEvent = {
  eventType: 'ticketing.taskCollection.created',
  payload: (_input, response) => ({
    collectionId: response.collection.collectionId,
    revision: response.task.revision,
    schemaId: response.schema.schemaId,
    taskId: response.task.taskId,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.collection.collectionId,
  subjectResourceType: 'task_collection',
} satisfies ActionDomainEventDescriptor<CreateTicketActionPayload, CreateTicketActionResponse>;

const createTicketActionHandler: ActionHandler<
  CreateTicketActionPayload,
  CreateTicketActionResponse
> = async (input, services) => {
  const creationResult = await services.tx.execute(sql`
    with created_collection as (
      insert into ticketing.task_collections (collection_id, tenant_id)
      values (${input.collectionId}, ${services.context.tenantId})
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
    ),
    created_task as (
      insert into ticketing.tasks (
        collection_id,
        created_by_principal_id,
        last_edited_by_principal_id,
        tenant_id
      )
      select
        collection_id,
        ${services.context.principalId},
        ${services.context.principalId},
        ${services.context.tenantId}
      from created_collection
      returning
        collection_id,
        created_at,
        created_by_principal_id,
        last_edited_at,
        last_edited_by_principal_id,
        revision,
        task_id,
        title
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at,
        changed_by_principal_id,
        reason,
        revision,
        task_id,
        tenant_id
      )
      select
        created_at,
        ${services.context.principalId},
        'created',
        revision,
        task_id,
        ${services.context.tenantId}
      from created_task
      returning task_id
    )
    select
      created_collection.collection_id as "collectionId",
      to_char(
        created_collection.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "collectionCreatedAt",
      created_schema.schema_id as "schemaId",
      created_title_definition.datatype as "datatype",
      created_title_definition.mandatory as "mandatory",
      created_title_definition.name as "name",
      created_title_definition.property_definition_id as "propertyDefinitionId",
      to_char(
        created_task.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "createdAt",
      created_task.created_by_principal_id as "createdByPrincipalId",
      to_char(
        created_task.last_edited_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as "lastEditedAt",
      created_task.last_edited_by_principal_id as "lastEditedByPrincipalId",
      created_task.revision as "revision",
      created_task.task_id as "taskId",
      created_task.title as "title"
    from created_collection
    inner join created_schema using (collection_id)
    cross join created_title_definition
    inner join created_task using (collection_id)
    inner join created_revision using (task_id)
  `);
  const created = rowsFromResult<TaskCollectionAggregateRow>(creationResult).at(0);

  if (created === undefined || created.datatype !== 'title') {
    throw rejectAction({
      code: 'ticketing.createTicket.aggregate_not_created',
      message: 'Task Collection and blank Task could not be created.',
    });
  }

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: createTicketActionKey,
      collectionId: created.collectionId,
      schemaId: created.schemaId,
      taskId: created.taskId,
    },
    topic: 'ticketing.taskCollection.created',
  });

  return taskCollectionAggregateFromRow(created);
};

export const createTicketActionRegistration: ActionRegistration<
  CreateTicketActionPayload,
  CreateTicketActionResponse
> = {
  descriptor: {
    actionKey: createTicketActionKey,
    auditProfile: 'standard',
    authorization: {
      permission: 'create',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createTicketDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createTicketActionPayloadSchema,
    transportResponseSchema: createTicketActionResponseSchema,
  },
  handler: createTicketActionHandler,
  policyChecks: [ticketingPolicies.createTicketActorValid],
};
