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
  updateCheckboxPropertyValueActionKey,
  updateCheckboxPropertyValueActionPayloadSchema,
  updateCheckboxPropertyValueActionResponseSchema,
} from '../../shared/actions/update-checkbox-property-value.ts';
import { rejectTaskEditWithEmptyMandatoryProperty } from '../task-mandatory-validation.ts';
import type {
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse,
} from '../../shared/actions/update-checkbox-property-value.ts';

interface CurrentCheckboxValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
  readonly value: boolean;
}

type UpdatedCheckboxValueRow = CurrentCheckboxValueRow;

const checkboxPropertyValueEvidence = (
  input: UpdateCheckboxPropertyValueActionPayload,
  response: UpdateCheckboxPropertyValueActionResponse,
) => ({
  changedComponents: ['checkboxValue'],
  collectionId: input.collectionId,
  datatype: 'checkbox',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateCheckboxPropertyValueAuditEvent = {
  evidence: checkboxPropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse
>;

const updateCheckboxPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: checkboxPropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse
>;

const updateCheckboxPropertyValueActionHandler: ActionHandler<
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select
      value.property_definition_id as "propertyDefinitionId",
      value.revision,
      task.revision as "taskRevision",
      value.value
    from ticketing.task_checkbox_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'checkbox'
    where value.task_id = ${input.taskId}
      and value.property_definition_id = ${input.propertyDefinitionId}
      and value.revision = ${input.expectedRevision}
      and value.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
    for update of value, task
  `);
  const current = rowsFromResult<CurrentCheckboxValueRow>(currentResult).at(0);

  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updateCheckboxPropertyValue.stale_or_missing',
      message: 'The Checkbox value changed elsewhere or is no longer available.',
    });
  }

  await rejectTaskEditWithEmptyMandatoryProperty({
    collectionId: input.collectionId,
    db: services.tx,
    taskId: input.taskId,
    tenantId: services.context.tenantId,
  });

  if (current.value === input.value) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        propertyDefinitionId: current.propertyDefinitionId,
        revision: current.revision,
        value: current.value,
      },
    };
  }

  const result = await services.tx.execute(sql`
    with updated_value as (
      update ticketing.task_checkbox_values as value
      set
        revision = value.revision + 1,
        value = ${input.value}
      where value.task_id = ${input.taskId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.revision = ${input.expectedRevision}
        and value.tenant_id = ${services.context.tenantId}
      returning
        value.property_definition_id,
        value.revision,
        value.task_id,
        value.value
    ),
    updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = statement_timestamp(),
        last_edited_by_principal_id = ${services.context.principalId},
        revision = task.revision + 1
      from updated_value
      where task.task_id = updated_value.task_id
        and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
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
        ${services.context.principalId},
        'checkbox_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      updated_value.property_definition_id as "propertyDefinitionId",
      updated_value.revision,
      updated_task.revision as "taskRevision",
      updated_value.value
    from updated_value
    inner join updated_task using (task_id)
    inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<UpdatedCheckboxValueRow>(result).at(0);

  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateCheckboxPropertyValue.stale_or_missing',
      message: 'The Checkbox value changed elsewhere or is no longer available.',
    });
  }

  return {
    taskRevision: updated.taskRevision,
    value: {
      propertyDefinitionId: updated.propertyDefinitionId,
      revision: updated.revision,
      value: updated.value,
    },
  };
};

export const updateCheckboxPropertyValueActionRegistration: ActionRegistration<
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateCheckboxPropertyValueActionKey,
    auditEvent: updateCheckboxPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateCheckboxPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateCheckboxPropertyValueActionPayloadSchema,
    transportResponseSchema: updateCheckboxPropertyValueActionResponseSchema,
  },
  handler: updateCheckboxPropertyValueActionHandler,
};
