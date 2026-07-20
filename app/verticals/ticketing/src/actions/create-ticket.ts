// @effect-diagnostics asyncFunction:off
import { allowPolicy, denyPolicy, rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
  PolicyCheck,
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

const validActorPolicyKey = 'ticketing.createTicket.actor.valid';

interface CreatedTaskCollectionRow {
  readonly collectionCreatedAt: string;
  readonly collectionId: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly datatype: 'title';
  readonly lastEditedAt: string;
  readonly lastEditedByPrincipalId: string;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly schemaId: string;
  readonly taskId: string;
  readonly title: string;
}

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
  const created = rowsFromResult<CreatedTaskCollectionRow>(creationResult).at(0);

  if (created === undefined || created.datatype !== 'title') {
    throw rejectAction({
      code: 'ticketing.createTicket.aggregate_not_created',
      message: 'Task Collection and blank Task could not be created.',
    });
  }

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      collectionId: created.collectionId,
      schemaId: created.schemaId,
      taskId: created.taskId,
    },
    topic: 'ticketing.taskCollection.created',
  });

  return {
    collection: {
      collectionId: created.collectionId,
      createdAt: created.collectionCreatedAt,
      schemaId: created.schemaId,
    },
    schema: {
      collectionId: created.collectionId,
      propertyDefinitions: [
        {
          datatype: created.datatype,
          mandatory: created.mandatory,
          name: created.name,
          propertyDefinitionId: created.propertyDefinitionId,
        },
      ],
      schemaId: created.schemaId,
    },
    task: {
      collectionId: created.collectionId,
      createdAt: created.createdAt,
      createdByPrincipalId: created.createdByPrincipalId,
      lastEditedAt: created.lastEditedAt,
      lastEditedByPrincipalId: created.lastEditedByPrincipalId,
      revision: created.revision,
      taskId: created.taskId,
      title: created.title,
    },
  };
};

const createTicketPolicyChecks: readonly PolicyCheck<CreateTicketActionPayload>[] = [
  async ({ db, operation }) => {
    const result = await db.execute(sql`
      select principal_id as "principalId"
      from core.principals
      where principal_id = ${operation.principalId}
        and tenant_id = ${operation.tenantId}
        and status = 'active'
      limit 1
    `);
    const actor = rowsFromResult<{ readonly principalId: string }>(result).at(0);

    return actor === undefined
      ? denyPolicy({
          code: 'ticketing.createTicket.actor_invalid',
          message: 'Task creation requires a valid Actor.',
          policyKey: validActorPolicyKey,
          reason: 'Trusted operation context did not resolve an active tenant Principal.',
          state: {},
        })
      : allowPolicy({
          policyKey: validActorPolicyKey,
          reason: 'Trusted operation context resolved an active tenant Principal.',
        });
  },
];

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
  policyChecks: createTicketPolicyChecks,
};
