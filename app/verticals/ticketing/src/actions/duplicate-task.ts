// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  duplicateTaskActionKey,
  duplicateTaskActionPayloadSchema,
  duplicateTaskActionResponseSchema,
} from '../../shared/actions/duplicate-task.ts';
import type {
  DuplicateTaskActionPayload,
  DuplicateTaskActionResponse,
} from '../../shared/actions/duplicate-task.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import { taskCreationFromRow } from '../task-collection-aggregate.ts';
import type { TaskCreationRow } from '../task-collection-aggregate.ts';

const duplicateTaskDomainEvent = {
  eventType: 'ticketing.task.duplicated',
  payload: (input, response) => ({
    collectionId: response.task.collectionId,
    revision: response.task.revision,
    sourceTaskId: input.sourceTaskId,
    taskId: response.task.taskId,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.task.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<DuplicateTaskActionPayload, DuplicateTaskActionResponse>;

const duplicateTaskActionHandler: ActionHandler<
  DuplicateTaskActionPayload,
  DuplicateTaskActionResponse
> = async (input, services) => {
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const result = await services.tx.execute(sql`
    with source_task as (
      select task.collection_id, task.task_id, task.title
      from ticketing.tasks as task
      where task.task_id = ${input.sourceTaskId}
        and task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
    ),
    created_task as (
      insert into ticketing.tasks (
        collection_id,
        created_by_principal_id,
        last_edited_by_principal_id,
        tenant_id,
        title
      )
      select
        source_task.collection_id,
        ${services.context.principalId},
        ${services.context.principalId},
        ${services.context.tenantId},
        source_task.title
      from source_task
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
    ),
    allocated_id as (
      update ticketing.task_id_sequences as sequence
      set next_number = sequence.next_number + 1
      from created_task
      where sequence.collection_id = created_task.collection_id
        and sequence.tenant_id = ${services.context.tenantId}
      returning
        sequence.next_number - 1 as number,
        sequence.property_definition_id
    ),
    initialized_id_assignment as (
      insert into ticketing.task_id_assignments (
        number,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        allocated_id.number,
        allocated_id.property_definition_id,
        created_task.task_id,
        ${services.context.tenantId}
      from created_task
      inner join allocated_id on true
      returning task_id
    ),
    copied_checkbox_values as (
      insert into ticketing.task_checkbox_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        source_value.property_definition_id,
        created_task.task_id,
        ${services.context.tenantId},
        source_value.value
      from source_task
      inner join created_task on true
      inner join ticketing.task_checkbox_values as source_value
        on source_value.task_id = source_task.task_id
        and source_value.tenant_id = ${services.context.tenantId}
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
  const created = rowsFromResult<TaskCreationRow>(result).at(0);
  if (created === undefined) {
    throw rejectAction({
      code: 'ticketing.duplicateTask.source_not_found',
      message: 'The source Task does not exist in this Task Collection.',
    });
  }

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: duplicateTaskActionKey,
      collectionId: created.collectionId,
      sourceTaskId: input.sourceTaskId,
      taskId: created.taskId,
    },
    topic: 'ticketing.task.duplicated',
  });
  return taskCreationFromRow(created);
};

export const duplicateTaskActionRegistration: ActionRegistration<
  DuplicateTaskActionPayload,
  DuplicateTaskActionResponse
> = {
  descriptor: {
    actionKey: duplicateTaskActionKey,
    auditProfile: 'standard',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: duplicateTaskDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: duplicateTaskActionPayloadSchema,
    transportResponseSchema: duplicateTaskActionResponseSchema,
  },
  handler: duplicateTaskActionHandler,
};
