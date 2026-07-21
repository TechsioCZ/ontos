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
  updateUrlPropertyValueActionKey,
  updateUrlPropertyValueActionPayloadSchema,
  updateUrlPropertyValueActionResponseSchema,
} from '../../shared/actions/update-url-property-value.ts';
import type {
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse,
} from '../../shared/actions/update-url-property-value.ts';
import { InvalidUrlPropertyValueError, validateUrlPropertyValue } from '../url-property.ts';

interface UrlValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
  readonly value: string | null;
}

interface CurrentUrlValueRow extends UrlValueRow {
  readonly mandatory: boolean;
}

const urlPropertyValueEvidence = (
  input: UpdateUrlPropertyValueActionPayload,
  response: UpdateUrlPropertyValueActionResponse,
) => ({
  changedComponents: ['urlValue'],
  collectionId: input.collectionId,
  datatype: 'url',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateUrlPropertyValueAuditEvent = {
  evidence: urlPropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse
>;

const updateUrlPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: urlPropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse
>;

const updateUrlPropertyValueActionHandler: ActionHandler<
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse
> = async (input, services) => {
  let value: string | null;
  try {
    value = validateUrlPropertyValue(input.value);
  } catch (error) {
    if (error instanceof InvalidUrlPropertyValueError) {
      throw rejectAction({ code: error.code, message: error.message });
    }
    throw error;
  }

  const currentResult = await services.tx.execute(sql`
    select
      value.property_definition_id as "propertyDefinitionId",
      definition.mandatory,
      value.revision,
      task.revision as "taskRevision",
      value.value
    from ticketing.task_url_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'url'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where value.task_id = ${input.taskId}
      and value.property_definition_id = ${input.propertyDefinitionId}
      and value.revision = ${input.expectedRevision}
      and value.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
      and schema.collection_id = ${input.collectionId}
    for update of value, task
  `);
  const current = rowsFromResult<CurrentUrlValueRow>(currentResult).at(0);

  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updateUrlPropertyValue.stale_or_missing',
      message: 'The URL value changed elsewhere or is no longer available.',
    });
  }

  if (current.mandatory && value === null) {
    throw rejectAction({
      code: 'ticketing.updateUrlPropertyValue.mandatory_empty',
      message: 'A Mandatory URL cannot be Empty.',
    });
  }

  if (current.value === value) {
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
      update ticketing.task_url_values as value_row
      set
        revision = value_row.revision + 1,
        value = ${value}
      where value_row.task_id = ${input.taskId}
        and value_row.property_definition_id = ${input.propertyDefinitionId}
        and value_row.revision = ${input.expectedRevision}
        and value_row.tenant_id = ${services.context.tenantId}
      returning
        value_row.property_definition_id,
        value_row.revision,
        value_row.task_id,
        value_row.value
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
        'url_value_changed',
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
  const updated = rowsFromResult<UrlValueRow>(result).at(0);

  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateUrlPropertyValue.stale_or_missing',
      message: 'The URL value changed elsewhere or is no longer available.',
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

export const updateUrlPropertyValueActionRegistration: ActionRegistration<
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateUrlPropertyValueActionKey,
    auditEvent: updateUrlPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateUrlPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateUrlPropertyValueActionPayloadSchema,
    transportResponseSchema: updateUrlPropertyValueActionResponseSchema,
  },
  handler: updateUrlPropertyValueActionHandler,
};
