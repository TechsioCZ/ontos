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
  transitionTaskRetentionActionKey,
  transitionTaskRetentionActionPayloadSchema,
  transitionTaskRetentionActionResponseSchema,
} from '../../shared/actions/transition-task-retention.ts';
import type {
  TaskRetentionState,
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse,
} from '../../shared/actions/transition-task-retention.ts';

interface CurrentTaskRetentionRow {
  readonly retentionState: 'active' | 'archived' | 'soft_deleted';
  readonly taskId: string;
  readonly taskRevision: number;
}

type TransitionedTaskRetentionRow = CurrentTaskRetentionRow;

const publicRetentionState = (
  retentionState: CurrentTaskRetentionRow['retentionState'],
): TaskRetentionState => (retentionState === 'soft_deleted' ? 'softDeleted' : retentionState);

const taskRetentionEvidence = (
  input: TransitionTaskRetentionActionPayload,
  response: TransitionTaskRetentionActionResponse,
) => ({
  changedComponents: ['retentionState'],
  collectionId: input.collectionId,
  operation: input.transition,
  resultingRetentionState: response.retentionState,
  taskId: 'hardDeletedTaskId' in response ? response.hardDeletedTaskId : response.taskId,
  ...('taskRevision' in response ? { taskRevision: response.taskRevision } : {}),
});

const transitionTaskRetentionAuditEvent = {
  evidence: taskRetentionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse
>;

const transitionTaskRetentionDomainEvent = {
  eventType: 'ticketing.taskRetention.transitioned',
  payload: taskRetentionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse
>;

const transitionTaskRetentionActionHandler: ActionHandler<
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select
      task.retention_state as "retentionState",
      task.task_id as "taskId",
      task.revision as "taskRevision"
    from ticketing.tasks as task
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
    for update of task
  `);
  const current = rowsFromResult<CurrentTaskRetentionRow>(currentResult).at(0);
  if (current === undefined || current.taskRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.transitionTaskRetention.stale_or_missing',
      message: 'The Task changed elsewhere or is no longer available.',
    });
  }

  if (input.transition === 'hardDelete') {
    const hardDeletionResult = await services.tx.execute(sql`
      with deleted_number_values as (
        delete from ticketing.task_number_values
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_text_values as (
        delete from ticketing.task_text_values
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_checkbox_values as (
        delete from ticketing.task_checkbox_values
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_person_assignments as (
        delete from ticketing.task_person_assignments
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_person_values as (
        delete from ticketing.task_person_values
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_date_values as (
        delete from ticketing.task_date_values
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      ),
      deleted_revisions as (
        delete from ticketing.task_revisions
        where task_id = ${input.taskId}
          and tenant_id = ${services.context.tenantId}
        returning task_id
      )
      delete from ticketing.tasks as task
      where task.task_id = ${input.taskId}
        and task.revision = ${input.expectedRevision}
        and task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning task.task_id as "hardDeletedTaskId"
    `);
    const hardDeleted = rowsFromResult<{ readonly hardDeletedTaskId: string }>(
      hardDeletionResult,
    ).at(0);
    if (hardDeleted === undefined) {
      throw rejectAction({
        code: 'ticketing.transitionTaskRetention.stale_or_missing',
        message: 'The Task changed elsewhere or is no longer available.',
      });
    }
    return {
      hardDeletedTaskId: hardDeleted.hardDeletedTaskId,
      retentionState: 'hardDeleted',
    };
  }

  let desiredState: CurrentTaskRetentionRow['retentionState'];
  let reason: 'archived' | 'restored' | 'soft_deleted';
  let updatesLastEdit: boolean;
  switch (input.transition) {
    case 'archive': {
      desiredState = 'archived';
      reason = 'archived';
      updatesLastEdit = true;
      break;
    }
    case 'restore': {
      desiredState = 'active';
      reason = 'restored';
      updatesLastEdit = true;
      break;
    }
    case 'softDelete': {
      desiredState = 'soft_deleted';
      reason = 'soft_deleted';
      updatesLastEdit = false;
      break;
    }
    default: {
      throw new Error('Unsupported Task retention transition.');
    }
  }
  if (current.retentionState === desiredState) {
    services.markNoOp();
    return {
      retentionState: publicRetentionState(current.retentionState),
      taskId: current.taskId,
      taskRevision: current.taskRevision,
    };
  }
  if (current.retentionState === 'soft_deleted' && input.transition === 'archive') {
    throw rejectAction({
      code: 'ticketing.transitionTaskRetention.invalid_transition',
      message: 'A soft-deleted Task cannot be archived before it is restored.',
    });
  }

  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = case
          when ${updatesLastEdit} then ${changedAt}::timestamptz
          else task.last_edited_at
        end,
        last_edited_by_principal_id = case
          when ${updatesLastEdit} then ${services.context.principalId}
          else task.last_edited_by_principal_id
        end,
        retention_state = ${desiredState},
        revision = task.revision + 1
      where task.task_id = ${input.taskId}
        and task.revision = ${input.expectedRevision}
        and task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning
        ${changedAt}::timestamptz as changed_at,
        task.retention_state,
        task.revision,
        task.task_id
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
        updated_task.changed_at,
        ${services.context.principalId},
        ${reason},
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      updated_task.retention_state as "retentionState",
      updated_task.task_id as "taskId",
      updated_task.revision as "taskRevision"
    from updated_task
    inner join created_revision using (task_id)
  `);
  const transitioned = rowsFromResult<TransitionedTaskRetentionRow>(result).at(0);
  if (transitioned === undefined) {
    throw rejectAction({
      code: 'ticketing.transitionTaskRetention.stale_or_missing',
      message: 'The Task changed elsewhere or is no longer available.',
    });
  }

  return {
    retentionState: publicRetentionState(transitioned.retentionState),
    taskId: transitioned.taskId,
    taskRevision: transitioned.taskRevision,
  };
};

export const transitionTaskRetentionActionRegistration: ActionRegistration<
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse
> = {
  descriptor: {
    actionKey: transitionTaskRetentionActionKey,
    auditEvent: transitionTaskRetentionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: transitionTaskRetentionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: transitionTaskRetentionActionPayloadSchema,
    transportResponseSchema: transitionTaskRetentionActionResponseSchema,
  },
  handler: transitionTaskRetentionActionHandler,
};
