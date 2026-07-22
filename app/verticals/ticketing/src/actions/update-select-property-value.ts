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
  updateSelectPropertyValueActionKey,
  updateSelectPropertyValueActionPayloadSchema,
  updateSelectPropertyValueActionResponseSchema,
} from '../../shared/actions/update-select-property-value.ts';
import type {
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse,
} from '../../shared/actions/update-select-property-value.ts';
import { rejectTaskEditWithEmptyMandatoryProperty } from '../task-mandatory-validation.ts';

interface CurrentValueRow {
  readonly optionId: string | null;
  readonly revision: number | null;
  readonly taskRevision: number;
}
interface UpdatedValueRow {
  readonly optionId: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
}

const evidence = (
  input: UpdateSelectPropertyValueActionPayload,
  response: UpdateSelectPropertyValueActionResponse,
) => ({
  changedComponents: ['selectValue'],
  collectionId: input.collectionId,
  datatype: 'select',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse
>;

const handler: ActionHandler<
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select
      value.option_id as "optionId",
      value.revision,
      task.revision as "taskRevision"
    from ticketing.tasks as task
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.schema_id = schema.schema_id and definition.tenant_id = schema.tenant_id and definition.datatype = 'select'
    left join ticketing.task_select_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
      and definition.property_definition_id = ${input.propertyDefinitionId}
    for update of task, definition
  `);
  const current = rowsFromResult<CurrentValueRow>(currentResult).at(0);
  if (current === undefined || (current.revision ?? 0) !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateSelectPropertyValue.stale_or_missing',
      message: 'The Select value changed elsewhere or is no longer available.',
    });
  }
  if (input.optionId !== undefined) {
    const optionResult = await services.tx.execute(sql`
      select option.option_id
      from ticketing.select_options as option
      where option.option_id = ${input.optionId}
        and option.property_definition_id = ${input.propertyDefinitionId}
        and option.tenant_id = ${services.context.tenantId}
    `);
    if (rowsFromResult(optionResult).length !== 1) {
      throw rejectAction({
        code: 'ticketing.updateSelectPropertyValue.option_not_found',
        message: 'The selected option is not available for this Select property.',
      });
    }
  }
  await rejectTaskEditWithEmptyMandatoryProperty({
    collectionId: input.collectionId,
    db: services.tx,
    taskId: input.taskId,
    tenantId: services.context.tenantId,
  });
  if (current.optionId === (input.optionId ?? null)) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        ...(current.optionId === null ? {} : { optionId: current.optionId }),
        propertyDefinitionId: input.propertyDefinitionId,
        revision: current.revision ?? 0,
      },
    };
  }
  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with changed_value as (
      insert into ticketing.task_select_values (
        option_id, property_definition_id, revision, task_id, tenant_id
      ) values (
        ${input.optionId ?? null}, ${input.propertyDefinitionId}, 1, ${input.taskId}, ${services.context.tenantId}
      )
      on conflict (task_id, property_definition_id) do update
      set option_id = excluded.option_id,
          revision = task_select_values.revision + 1
      where task_select_values.revision = ${input.expectedRevision}
      returning option_id, property_definition_id, revision, task_id
    ), updated_task as (
      update ticketing.tasks as task
      set last_edited_at = ${changedAt}::timestamptz,
          last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
          revision = task.revision + 1
      from changed_value
      where task.task_id = changed_value.task_id and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ), created_revision as (
      insert into ticketing.task_revisions (
        changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
      )
      select updated_task.last_edited_at, ${services.effectiveEditorPrincipalId}, 'select_value_changed', updated_task.revision, updated_task.task_id, ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      changed_value.option_id as "optionId",
      changed_value.property_definition_id as "propertyDefinitionId",
      changed_value.revision,
      updated_task.revision as "taskRevision"
    from changed_value inner join updated_task using (task_id) inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<UpdatedValueRow>(result).at(0);
  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateSelectPropertyValue.stale_or_missing',
      message: 'The Select value changed elsewhere or is no longer available.',
    });
  }
  return {
    taskRevision: updated.taskRevision,
    value: {
      ...(updated.optionId === null ? {} : { optionId: updated.optionId }),
      propertyDefinitionId: updated.propertyDefinitionId,
      revision: updated.revision,
    },
  };
};

export const updateSelectPropertyValueActionRegistration: ActionRegistration<
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateSelectPropertyValueActionKey,
    auditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateSelectPropertyValueActionPayloadSchema,
    transportResponseSchema: updateSelectPropertyValueActionResponseSchema,
  },
  handler,
};
