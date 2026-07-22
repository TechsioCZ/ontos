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
  updateDateRangePropertyValueActionKey,
  updateDateRangePropertyValueActionPayloadSchema,
  updateDateRangePropertyValueActionResponseSchema,
} from '../../shared/actions/update-date-range-property-value.ts';
import type {
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse,
} from '../../shared/actions/update-date-range-property-value.ts';
import { validateDateRangeValue } from '../../shared/date-range-value.ts';
import type { DateRangeValue } from '../../shared/date-range-value.ts';
import { dateRangeValueFromNullableFields } from '../date-range-value-projection.ts';

interface TargetRow {
  readonly currentRevision: number | null;
  readonly endDate: string | null;
  readonly endTime: string | null;
  readonly propertyDefinitionId: string;
  readonly startDate: string | null;
  readonly startTime: string | null;
  readonly taskRevision: number;
  readonly timeEnabled: boolean;
}
interface PersistedRow {
  readonly endDate: string | null;
  readonly endTime: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly startDate: string | null;
  readonly startTime: string | null;
}
interface UpdatedTaskRow {
  readonly changedAt: string;
  readonly taskRevision: number;
}

const sameValue = (left: DateRangeValue | null, right: DateRangeValue | null): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const evidence = (
  input: UpdateDateRangePropertyValueActionPayload,
  response: UpdateDateRangePropertyValueActionResponse,
) => ({
  changedComponents: ['dateRangeValue'],
  collectionId: input.collectionId,
  datatype: 'date_range',
  operation: input.value === null ? 'cleared' : 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value?.revision ?? input.expectedRevision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse
>;

// oxlint-disable eslint/complexity -- The transactional handler keeps validation, optimistic concurrency, persistence, and Task revision recording atomic.
const handler: ActionHandler<
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse
> = async (input, services) => {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw rejectAction({
      code: 'ticketing.updateDateRangePropertyValue.invalid_revision',
      message: 'The Date Range value revision must be a non-negative integer.',
    });
  }
  const currentResult = await services.tx.execute(sql`
    select
      value.end_date::text as "endDate",
      to_char(value.end_time, 'HH24:MI') as "endTime",
      value.revision as "currentRevision",
      value.start_date::text as "startDate",
      to_char(value.start_time, 'HH24:MI') as "startTime",
      definition.property_definition_id as "propertyDefinitionId",
      task.revision as "taskRevision",
      definition.date_range_time_enabled as "timeEnabled"
    from ticketing.tasks as task
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.tenant_id = task.tenant_id
      and definition.datatype = 'date_range'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    left join ticketing.task_date_range_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
    for update of task, definition
  `);
  const current = rowsFromResult<TargetRow>(currentResult).at(0);
  const currentRevision = current?.currentRevision ?? 0;
  if (current === undefined || currentRevision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateDateRangePropertyValue.stale_or_missing',
      message: 'The Date Range value changed elsewhere or is no longer available.',
    });
  }
  if (input.value !== null) {
    const validationCode = validateDateRangeValue(input.value, current.timeEnabled);
    if (validationCode !== null) {
      throw rejectAction({
        code: `ticketing.updateDateRangePropertyValue.${validationCode}`,
        message: `The Date Range value is invalid: ${validationCode}.`,
        state: { validationCode },
      });
    }
  }
  if (sameValue(dateRangeValueFromNullableFields(current), input.value)) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value:
        current.currentRevision === null
          ? null
          : {
              propertyDefinitionId: current.propertyDefinitionId,
              revision: currentRevision,
              value: dateRangeValueFromNullableFields(current),
            },
    };
  }

  const result =
    current.currentRevision === null
      ? await services.tx.execute(sql`
          insert into ticketing.task_date_range_values (
            end_date, end_time, property_definition_id, start_date, start_time, task_id, tenant_id
          ) values (
            ${input.value?.endDate ?? null}::date,
            ${input.value?.endTime ?? null}::time,
            ${input.propertyDefinitionId},
            ${input.value?.startDate ?? null}::date,
            ${input.value?.startTime ?? null}::time,
            ${input.taskId},
            ${services.context.tenantId}
          )
          returning end_date::text as "endDate", to_char(end_time, 'HH24:MI') as "endTime",
            property_definition_id as "propertyDefinitionId", revision,
            start_date::text as "startDate", to_char(start_time, 'HH24:MI') as "startTime"
        `)
      : await services.tx.execute(sql`
          update ticketing.task_date_range_values
          set end_date = ${input.value?.endDate ?? null}::date,
            end_time = ${input.value?.endTime ?? null}::time,
            revision = revision + 1,
            start_date = ${input.value?.startDate ?? null}::date,
            start_time = ${input.value?.startTime ?? null}::time
          where task_id = ${input.taskId}
            and property_definition_id = ${input.propertyDefinitionId}
            and revision = ${input.expectedRevision}
            and tenant_id = ${services.context.tenantId}
          returning end_date::text as "endDate", to_char(end_time, 'HH24:MI') as "endTime",
            property_definition_id as "propertyDefinitionId", revision,
            start_date::text as "startDate", to_char(start_time, 'HH24:MI') as "startTime"
        `);
  const persisted = rowsFromResult<PersistedRow>(result).at(0);
  if (persisted === undefined) {
    throw rejectAction({
      code: 'ticketing.updateDateRangePropertyValue.stale_or_missing',
      message: 'The Date Range value changed elsewhere or is no longer available.',
    });
  }
  const taskResult = await services.tx.execute(sql`
    update ticketing.tasks
    set last_edited_at = statement_timestamp(),
      last_edited_by_principal_id = ${services.context.principalId},
      revision = revision + 1
    where task_id = ${input.taskId} and tenant_id = ${services.context.tenantId}
    returning last_edited_at as "changedAt", revision as "taskRevision"
  `);
  const updatedTask = rowsFromResult<UpdatedTaskRow>(taskResult).at(0);
  if (updatedTask === undefined) {
    throw rejectAction({
      code: 'ticketing.updateDateRangePropertyValue.stale_or_missing',
      message: 'The Date Range value changed elsewhere or is no longer available.',
    });
  }
  await services.tx.execute(sql`
    insert into ticketing.task_revisions (
      changed_at, changed_by_principal_id, reason, revision, task_id, tenant_id
    ) values (
      ${updatedTask.changedAt}, ${services.context.principalId}, 'date_range_value_changed',
      ${updatedTask.taskRevision}, ${input.taskId}, ${services.context.tenantId}
    )
  `);
  return {
    taskRevision: updatedTask.taskRevision,
    value: {
      propertyDefinitionId: persisted.propertyDefinitionId,
      revision: persisted.revision,
      value: dateRangeValueFromNullableFields(persisted),
    },
  };
};
// oxlint-enable eslint/complexity

export const updateDateRangePropertyValueActionRegistration: ActionRegistration<
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateDateRangePropertyValueActionKey,
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
    transportRequestSchema: updateDateRangePropertyValueActionPayloadSchema,
    transportResponseSchema: updateDateRangePropertyValueActionResponseSchema,
  },
  handler,
};
