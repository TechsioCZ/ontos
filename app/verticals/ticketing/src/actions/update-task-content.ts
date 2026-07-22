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
  updateTaskContentActionKey,
  updateTaskContentActionPayloadSchema,
  updateTaskContentActionResponseSchema,
} from '../../shared/actions/update-task-content.ts';
import type {
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse,
} from '../../shared/actions/update-task-content.ts';
import { rejectTaskEditWithEmptyMandatoryProperty } from '../task-mandatory-validation.ts';

interface CurrentTaskContentRow {
  readonly canvas: UpdateTaskContentActionResponse['canvas'];
  readonly sameCanvas: boolean;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
}

type PersistedTaskContentResponse = Omit<UpdateTaskContentActionResponse, 'changedComponents'>;

const taskContentEvidence = (
  input: UpdateTaskContentActionPayload,
  response: UpdateTaskContentActionResponse,
) => ({
  changedComponents: response.changedComponents,
  collectionId: input.collectionId,
  operation: 'content_changed',
  taskId: response.taskId,
  taskRevision: response.taskRevision,
});

const updateTaskContentAuditEvent = {
  evidence: taskContentEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse
>;

const updateTaskContentDomainEvent = {
  eventType: 'ticketing.task.contentChanged',
  payload: taskContentEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse
>;

const updateTaskContentActionHandler: ActionHandler<
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse
> = async (input, services) => {
  const serializedCanvas = JSON.stringify(input.canvas);
  const currentResult = await services.tx.execute(sql`
    select
      task.canvas,
      task.canvas = ${serializedCanvas}::jsonb as "sameCanvas",
      task.task_id as "taskId",
      task.revision as "taskRevision",
      task.title
    from ticketing.tasks as task
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
    for update of task
  `);
  const current = rowsFromResult<CurrentTaskContentRow>(currentResult).at(0);
  if (current === undefined || current.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateTaskContent.stale_or_missing',
      message: 'The Task changed elsewhere or is no longer available.',
    });
  }

  await rejectTaskEditWithEmptyMandatoryProperty({
    collectionId: input.collectionId,
    db: services.tx,
    taskId: input.taskId,
    tenantId: services.context.tenantId,
  });

  const changedComponents: UpdateTaskContentActionResponse['changedComponents'] = [
    ...(current.title === input.title ? [] : (['title'] as const)),
    ...(current.sameCanvas ? [] : (['canvas'] as const)),
  ];
  if (changedComponents.length === 0) {
    services.markNoOp();
    return {
      canvas: current.canvas,
      changedComponents,
      taskId: current.taskId,
      taskRevision: current.taskRevision,
      title: current.title,
    };
  }

  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        canvas = ${serializedCanvas}::jsonb,
        last_edited_at = ${changedAt}::timestamptz,
        last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
        revision = task.revision + 1,
        title = ${input.title}
      where task.task_id = ${input.taskId}
        and task.revision = ${input.expectedRevision}
        and task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning task.canvas, task.last_edited_at, task.revision, task.task_id, task.title
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
        updated_task.last_edited_at,
        ${services.effectiveEditorPrincipalId},
        'content_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      updated_task.canvas,
      updated_task.task_id as "taskId",
      updated_task.revision as "taskRevision",
      updated_task.title
    from updated_task
    inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<PersistedTaskContentResponse>(result).at(0);
  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateTaskContent.stale_or_missing',
      message: 'The Task changed elsewhere or is no longer available.',
    });
  }
  return { ...updated, changedComponents };
};

export const updateTaskContentActionRegistration: ActionRegistration<
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse
> = {
  descriptor: {
    actionKey: updateTaskContentActionKey,
    auditEvent: updateTaskContentAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateTaskContentDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateTaskContentActionPayloadSchema,
    transportResponseSchema: updateTaskContentActionResponseSchema,
  },
  handler: updateTaskContentActionHandler,
};
