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
  updatePhonePropertyValueActionKey,
  updatePhonePropertyValueActionPayloadSchema,
  updatePhonePropertyValueActionResponseSchema,
} from '../../shared/actions/update-phone-property-value.ts';
import type {
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse,
} from '../../shared/actions/update-phone-property-value.ts';
import { validatePhoneValue } from '../../shared/phone-value.ts';

interface CurrentPhoneTargetRow {
  readonly propertyDefinitionId: string;
  readonly revision: number | null;
  readonly taskRevision: number;
  readonly value: string | null;
}

interface UpdatedPhoneValueRow {
  readonly propertyDefinitionId: string | null;
  readonly revision: number | null;
  readonly taskRevision: number;
  readonly value: string | null;
}

const phonePropertyValueEvidence = (
  input: UpdatePhonePropertyValueActionPayload,
  response: UpdatePhonePropertyValueActionResponse,
) => ({
  changedComponents: ['phoneValue'],
  collectionId: input.collectionId,
  datatype: 'phone',
  operation: response.value === null ? 'cleared' : 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value?.revision ?? null,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updatePhonePropertyValueAuditEvent = {
  evidence: phonePropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse
>;

const updatePhonePropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: phonePropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse
>;

const staleOrMissing = () =>
  rejectAction({
    code: 'ticketing.updatePhonePropertyValue.stale_or_missing',
    message: 'The Phone value changed elsewhere or is no longer available.',
  });

const updatePhonePropertyValueActionHandler: ActionHandler<
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse
> = async (input, services) => {
  const validated = validatePhoneValue(input.value);
  if (!validated.ok) {
    throw rejectAction({
      code: `ticketing.updatePhonePropertyValue.${validated.failure}`,
      message: 'Phone must be at most 256 code points and contain one control-free line.',
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      definition.property_definition_id as "propertyDefinitionId",
      value.revision,
      task.revision as "taskRevision",
      value.value
    from ticketing.tasks as task
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.schema_id = schema.schema_id
      and definition.tenant_id = schema.tenant_id
      and definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'phone'
    left join ticketing.task_phone_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
    for update of task, definition
  `);
  const current = rowsFromResult<CurrentPhoneTargetRow>(currentResult).at(0);
  if (current === undefined || (current.revision ?? 0) !== input.expectedRevision) {
    throw staleOrMissing();
  }

  if (current.value === validated.value) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value:
        current.revision === null || current.value === null
          ? null
          : {
              propertyDefinitionId: current.propertyDefinitionId,
              revision: current.revision,
              value: current.value,
            },
    };
  }

  const mutatePhoneValue = () => {
    if (validated.value === null) {
      return services.tx.execute(sql`
          delete from ticketing.task_phone_values
          where task_id = ${input.taskId}
            and property_definition_id = ${input.propertyDefinitionId}
            and revision = ${input.expectedRevision}
            and tenant_id = ${services.context.tenantId}
          returning null::uuid as "propertyDefinitionId", null::integer as revision, null::text as value
        `);
    }
    if (current.revision === null) {
      return services.tx.execute(sql`
            insert into ticketing.task_phone_values (
              property_definition_id,
              revision,
              task_id,
              tenant_id,
              value
            ) values (
              ${input.propertyDefinitionId},
              ${current.taskRevision + 1},
              ${input.taskId},
              ${services.context.tenantId},
              ${validated.value}
            )
            returning property_definition_id as "propertyDefinitionId", revision, value
          `);
    }
    return services.tx.execute(sql`
            update ticketing.task_phone_values
            set revision = revision + 1, value = ${validated.value}
            where task_id = ${input.taskId}
              and property_definition_id = ${input.propertyDefinitionId}
              and revision = ${input.expectedRevision}
              and tenant_id = ${services.context.tenantId}
            returning property_definition_id as "propertyDefinitionId", revision, value
          `);
  };
  const mutationResult = await mutatePhoneValue();
  const mutation = rowsFromResult<{
    readonly propertyDefinitionId: string | null;
    readonly revision: number | null;
    readonly value: string | null;
  }>(mutationResult).at(0);
  if (mutation === undefined) {
    throw staleOrMissing();
  }

  const taskResult = await services.tx.execute(sql`
    with updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = statement_timestamp(),
        last_edited_by_principal_id = ${services.context.principalId},
        revision = task.revision + 1
      where task.task_id = ${input.taskId}
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
        'phone_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select updated_task.revision as "taskRevision"
    from updated_task
    inner join created_revision using (task_id)
  `);
  const task = rowsFromResult<{ readonly taskRevision: number }>(taskResult).at(0);
  if (task === undefined) {
    throw staleOrMissing();
  }

  const updated: UpdatedPhoneValueRow = { ...mutation, taskRevision: task.taskRevision };
  return {
    taskRevision: updated.taskRevision,
    value:
      updated.propertyDefinitionId === null || updated.revision === null || updated.value === null
        ? null
        : {
            propertyDefinitionId: updated.propertyDefinitionId,
            revision: updated.revision,
            value: updated.value,
          },
  };
};

export const updatePhonePropertyValueActionRegistration: ActionRegistration<
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updatePhonePropertyValueActionKey,
    auditEvent: updatePhonePropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updatePhonePropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updatePhonePropertyValueActionPayloadSchema,
    transportResponseSchema: updatePhonePropertyValueActionResponseSchema,
  },
  handler: updatePhonePropertyValueActionHandler,
};
