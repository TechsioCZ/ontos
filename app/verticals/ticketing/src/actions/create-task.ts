// @effect-diagnostics asyncFunction:off
import { rejectAction } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import {
  createTaskActionKey,
  createTaskActionPayloadSchema,
  createTaskActionResponseSchema,
} from '../../shared/actions/create-task.ts';
import type {
  CreateTaskActionPayload,
  CreateTaskActionResponse,
} from '../../shared/actions/create-task.ts';
import { createTaskAggregate } from '../create-task-aggregate.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import { taskCreationFromRow } from '../task-collection-aggregate.ts';

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
  const createdAt = services.clock.now().toISOString();
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const created = await createTaskAggregate({
    collectionId: input.collectionId,
    createdAt,
    principalId: services.context.principalId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

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
