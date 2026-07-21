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
import { createTaskAggregate } from '../create-task-aggregate.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import { taskCreationFromRow } from '../task-collection-aggregate.ts';

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
  const createdAt = services.clock.now().toISOString();
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const sourceResult = await services.tx.execute(sql`
    select task.task_id as "taskId"
    from ticketing.tasks as task
    inner join ticketing.task_id_sequences as sequence
      on sequence.collection_id = task.collection_id
      and sequence.tenant_id = task.tenant_id
    where task.task_id = ${input.sourceTaskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
  `);
  const source = rowsFromResult<{ readonly taskId: string }>(sourceResult).at(0);
  if (source === undefined) {
    throw rejectAction({
      code: 'ticketing.duplicateTask.id_inactive_or_source_not_found',
      message: 'The source Task or its active ID namespace is not available.',
    });
  }

  const created = await createTaskAggregate({
    collectionId: input.collectionId,
    createdAt,
    principalId: services.context.principalId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  if (created === undefined) {
    throw rejectAction({
      code: 'ticketing.duplicateTask.collection_not_found',
      message: 'The Task Collection is no longer available.',
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
