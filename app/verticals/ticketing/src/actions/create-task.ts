// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  createTaskActionKey,
  createTaskActionPayloadSchema,
  createTaskActionResponseSchema,
} from '../../shared/actions/create-task.ts';
import type {
  CreateTaskActionPayload,
  CreateTaskActionResponse,
} from '../../shared/actions/create-task.ts';
import { taskCreationFromRow } from '../task-collection-aggregate.ts';
import type { TaskCreationRow } from '../task-collection-aggregate.ts';

const createTaskDomainEvent = {
  eventType: 'ticketing.task.created',
  payload: (_input, response) => ({
    collectionId: response.task.collectionId,
    revision: response.task.revision,
    taskId: response.task.taskId,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.task.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<CreateTaskActionPayload, CreateTaskActionResponse>;

const createTaskActionHandler: ActionHandler<
  CreateTaskActionPayload,
  CreateTaskActionResponse
> = async (input, services) => {
  const creationResult = await services.tx.execute(sql`
    with created_task as (
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
      from ticketing.task_collections
      where collection_id = ${input.collectionId}
        and tenant_id = ${services.context.tenantId}
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
      created_task.collection_id as "collectionId",
      to_char(
        created_task.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "createdAt",
      created_task.created_by_principal_id as "createdByPrincipalId",
      to_char(
        created_task.last_edited_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "lastEditedAt",
      created_task.last_edited_by_principal_id as "lastEditedByPrincipalId",
      created_task.revision as "revision",
      created_task.task_id as "taskId",
      created_task.title as "title"
    from created_task
    inner join created_revision using (task_id)
  `);
  const created = rowsFromResult<TaskCreationRow>(creationResult).at(0);

  if (created === undefined) {
    throw rejectAction({
      code: 'ticketing.createTask.collection_not_found',
      message: 'The Task Collection does not exist in the operation tenant.',
    });
  }

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: createTaskActionKey,
      collectionId: created.collectionId,
      revision: created.revision,
      taskId: created.taskId,
    },
    topic: 'ticketing.task.created',
  });

  return taskCreationFromRow(created);
};

export const createTaskActionRegistration: ActionRegistration<
  CreateTaskActionPayload,
  CreateTaskActionResponse
> = {
  descriptor: {
    actionKey: createTaskActionKey,
    auditProfile: 'standard',
    domainEvent: createTaskDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createTaskActionPayloadSchema,
    transportResponseSchema: createTaskActionResponseSchema,
  },
  handler: createTaskActionHandler,
};
