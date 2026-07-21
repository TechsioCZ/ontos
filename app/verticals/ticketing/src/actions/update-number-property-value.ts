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
  updateNumberPropertyValueActionKey,
  updateNumberPropertyValueActionPayloadSchema,
  updateNumberPropertyValueActionResponseSchema,
} from '../../shared/actions/update-number-property-value.ts';
import type {
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse,
} from '../../shared/actions/update-number-property-value.ts';
import { canonicalizeNumberValue } from '../../shared/number-value.ts';
import { rejectTaskEditWithEmptyMandatoryProperty } from '../task-mandatory-validation.ts';

interface CurrentNumberValueRow {
  readonly mandatory: boolean;
  readonly propertyDefinitionId: string;
  readonly revision: number | null;
  readonly taskRevision: number;
  readonly value: string | null;
}

interface UpdatedNumberValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
  readonly value: string | null;
}

const numberPropertyValueEvidence = (
  input: UpdateNumberPropertyValueActionPayload,
  response: UpdateNumberPropertyValueActionResponse,
) => ({
  changedComponents: ['numberValue'],
  collectionId: input.collectionId,
  datatype: 'number',
  operation: response.value.value === null ? 'cleared' : 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateNumberPropertyValueAuditEvent = {
  evidence: numberPropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse
>;

const updateNumberPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: numberPropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse
>;

const updateNumberPropertyValueActionHandler: ActionHandler<
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse
> = async (input, services) => {
  const canonicalValue = input.value === null ? null : canonicalizeNumberValue(input.value);
  if (canonicalValue === undefined) {
    throw rejectAction({
      code: 'ticketing.updateNumberPropertyValue.invalid_decimal',
      message: 'Number must be a plain decimal with at most 20 integer and 18 fractional digits.',
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      definition.mandatory,
      definition.property_definition_id as "propertyDefinitionId",
      value.revision,
      task.revision as "taskRevision",
      value.value::text as value
    from ticketing.tasks as task
    inner join ticketing.task_property_definitions as definition
      on definition.tenant_id = task.tenant_id
      and definition.datatype = 'number'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.collection_id = task.collection_id
      and schema.tenant_id = definition.tenant_id
    left join ticketing.task_number_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and definition.property_definition_id = ${input.propertyDefinitionId}
      and coalesce(value.revision, 0) = ${input.expectedRevision}
      and task.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
    for update of task, definition
  `);
  const current = rowsFromResult<CurrentNumberValueRow>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updateNumberPropertyValue.stale_or_missing',
      message: 'The Number value changed elsewhere or is no longer available.',
    });
  }
  if (current.mandatory && canonicalValue === null) {
    throw rejectAction({
      code: 'ticketing.updateNumberPropertyValue.mandatory_empty',
      message: 'Mandatory Number must contain a value.',
    });
  }
  await rejectTaskEditWithEmptyMandatoryProperty({
    collectionId: input.collectionId,
    db: services.tx,
    taskId: input.taskId,
    tenantId: services.context.tenantId,
  });
  const currentCanonical =
    current.value === null ? null : (canonicalizeNumberValue(current.value) ?? current.value);
  if (currentCanonical === canonicalValue) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        propertyDefinitionId: current.propertyDefinitionId,
        revision: current.revision ?? 0,
        value: currentCanonical,
      },
    };
  }

  const valueResult = await services.tx.execute(sql`
    insert into ticketing.task_number_values (
      property_definition_id,
      revision,
      task_id,
      tenant_id,
      value
    )
    values (
      ${input.propertyDefinitionId},
      ${input.expectedRevision + 1},
      ${input.taskId},
      ${services.context.tenantId},
      ${canonicalValue}::numeric
    )
    on conflict (task_id, property_definition_id) do update
    set
      revision = ticketing.task_number_values.revision + 1,
      value = excluded.value
    where ticketing.task_number_values.revision = ${input.expectedRevision}
    returning property_definition_id as "propertyDefinitionId", revision, value::text as value
  `);
  if (rowsFromResult(valueResult).length !== 1) {
    throw rejectAction({
      code: 'ticketing.updateNumberPropertyValue.stale_or_missing',
      message: 'The Number value changed elsewhere or is no longer available.',
    });
  }

  const result = await services.tx.execute(sql`
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
        'number_value_changed',
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
  const taskRevision = rowsFromResult<{ readonly taskRevision: number }>(result).at(
    0,
  )?.taskRevision;
  if (taskRevision === undefined) {
    throw rejectAction({
      code: 'ticketing.updateNumberPropertyValue.stale_or_missing',
      message: 'The Number value changed elsewhere or is no longer available.',
    });
  }
  const changedValue = rowsFromResult<UpdatedNumberValueRow>(valueResult).at(0);
  return {
    taskRevision,
    value: {
      propertyDefinitionId: changedValue?.propertyDefinitionId ?? input.propertyDefinitionId,
      revision: changedValue?.revision ?? input.expectedRevision + 1,
      value: canonicalValue,
    },
  };
};

export const updateNumberPropertyValueActionRegistration: ActionRegistration<
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateNumberPropertyValueActionKey,
    auditEvent: updateNumberPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateNumberPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateNumberPropertyValueActionPayloadSchema,
    transportResponseSchema: updateNumberPropertyValueActionResponseSchema,
  },
  handler: updateNumberPropertyValueActionHandler,
};
