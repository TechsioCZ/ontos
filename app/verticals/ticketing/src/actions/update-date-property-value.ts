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
  updateDatePropertyValueActionKey,
  updateDatePropertyValueActionPayloadSchema,
  updateDatePropertyValueActionResponseSchema,
} from '../../shared/actions/update-date-property-value.ts';
import { isCanonicalCalendarDate } from '../../shared/date-value.ts';
import type {
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse,
} from '../../shared/actions/update-date-property-value.ts';

interface CurrentDateTargetRow {
  readonly currentRevision: number | null;
  readonly currentValue: string | null;
  readonly propertyDefinitionId: string;
  readonly taskRevision: number;
}

interface PersistedDateValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly value: string | null;
}

interface UpdatedTaskRow {
  readonly changedAt: string;
  readonly taskRevision: number;
}

const datePropertyValueEvidence = (
  input: UpdateDatePropertyValueActionPayload,
  response: UpdateDatePropertyValueActionResponse,
) => ({
  changedComponents: ['dateValue'],
  collectionId: input.collectionId,
  datatype: 'date',
  operation: input.value === null ? 'cleared' : 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value?.revision ?? input.expectedRevision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateDatePropertyValueAuditEvent = {
  evidence: datePropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse
>;

const updateDatePropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: datePropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse
>;

const updateDatePropertyValueActionHandler: ActionHandler<
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse
> = async (input, services) => {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw rejectAction({
      code: 'ticketing.updateDatePropertyValue.invalid_revision',
      message: 'The Date value revision must be a non-negative integer.',
    });
  }
  if (input.value !== null && !isCanonicalCalendarDate(input.value)) {
    throw rejectAction({
      code: 'ticketing.updateDatePropertyValue.invalid_date',
      message: 'The Date value must be a real calendar date in YYYY-MM-DD format.',
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      value.revision as "currentRevision",
      value.value::text as "currentValue",
      definition.property_definition_id as "propertyDefinitionId",
      task.revision as "taskRevision"
    from ticketing.tasks as task
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.tenant_id = task.tenant_id
      and definition.datatype = 'date'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    left join ticketing.task_date_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
    for update of task, definition
  `);
  const current = rowsFromResult<CurrentDateTargetRow>(currentResult).at(0);
  const currentRevision = current?.currentRevision ?? 0;

  if (current === undefined || currentRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateDatePropertyValue.stale_or_missing',
      message: 'The Date value changed elsewhere or is no longer available.',
    });
  }

  if (current.currentValue === input.value) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value:
        current.currentRevision === null
          ? null
          : {
              propertyDefinitionId: current.propertyDefinitionId,
              revision: currentRevision,
              value: current.currentValue,
            },
    };
  }

  let persistedValue: PersistedDateValueRow | null;
  if (input.value === null) {
    const result = await services.tx.execute(sql`
      update ticketing.task_date_values
      set
        revision = revision + 1,
        value = null
      where task_id = ${input.taskId}
        and property_definition_id = ${input.propertyDefinitionId}
        and revision = ${input.expectedRevision}
        and tenant_id = ${services.context.tenantId}
      returning
        property_definition_id as "propertyDefinitionId",
        revision,
        value::text as value
    `);
    if (rowsFromResult<PersistedDateValueRow>(result).length !== 1) {
      throw rejectAction({
        code: 'ticketing.updateDatePropertyValue.stale_or_missing',
        message: 'The Date value changed elsewhere or is no longer available.',
      });
    }
    persistedValue = rowsFromResult<PersistedDateValueRow>(result).at(0) ?? null;
  } else if (currentRevision === 0) {
    const result = await services.tx.execute(sql`
      insert into ticketing.task_date_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      values (
        ${input.propertyDefinitionId},
        ${input.taskId},
        ${services.context.tenantId},
        ${input.value}::date
      )
      returning
        property_definition_id as "propertyDefinitionId",
        revision,
        value::text as value
    `);
    persistedValue = rowsFromResult<PersistedDateValueRow>(result).at(0) ?? null;
  } else {
    const result = await services.tx.execute(sql`
      update ticketing.task_date_values
      set
        revision = revision + 1,
        value = ${input.value}::date
      where task_id = ${input.taskId}
        and property_definition_id = ${input.propertyDefinitionId}
        and revision = ${input.expectedRevision}
        and tenant_id = ${services.context.tenantId}
      returning
        property_definition_id as "propertyDefinitionId",
        revision,
        value::text as value
    `);
    persistedValue = rowsFromResult<PersistedDateValueRow>(result).at(0) ?? null;
  }

  if (persistedValue === null) {
    throw rejectAction({
      code: 'ticketing.updateDatePropertyValue.stale_or_missing',
      message: 'The Date value changed elsewhere or is no longer available.',
    });
  }

  const taskResult = await services.tx.execute(sql`
    update ticketing.tasks
    set
      last_edited_at = statement_timestamp(),
      last_edited_by_principal_id = ${services.context.principalId},
      revision = revision + 1
    where task_id = ${input.taskId}
      and tenant_id = ${services.context.tenantId}
    returning
      last_edited_at as "changedAt",
      revision as "taskRevision"
  `);
  const updatedTask = rowsFromResult<UpdatedTaskRow>(taskResult).at(0);
  if (updatedTask === undefined) {
    throw rejectAction({
      code: 'ticketing.updateDatePropertyValue.stale_or_missing',
      message: 'The Date value changed elsewhere or is no longer available.',
    });
  }

  await services.tx.execute(sql`
    insert into ticketing.task_revisions (
      changed_at,
      changed_by_principal_id,
      reason,
      revision,
      task_id,
      tenant_id
    )
    values (
      ${updatedTask.changedAt},
      ${services.context.principalId},
      'date_value_changed',
      ${updatedTask.taskRevision},
      ${input.taskId},
      ${services.context.tenantId}
    )
  `);

  return {
    taskRevision: updatedTask.taskRevision,
    value: persistedValue,
  };
};

export const updateDatePropertyValueActionRegistration: ActionRegistration<
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateDatePropertyValueActionKey,
    auditEvent: updateDatePropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateDatePropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateDatePropertyValueActionPayloadSchema,
    transportResponseSchema: updateDatePropertyValueActionResponseSchema,
  },
  handler: updateDatePropertyValueActionHandler,
};
