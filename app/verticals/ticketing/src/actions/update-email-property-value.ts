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
  updateEmailPropertyValueActionKey,
  updateEmailPropertyValueActionPayloadSchema,
  updateEmailPropertyValueActionResponseSchema,
} from '../../shared/actions/update-email-property-value.ts';
import type {
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse,
} from '../../shared/actions/update-email-property-value.ts';
import { parseEmailValue } from '../../shared/email-value.ts';

interface CurrentEmailValueRow {
  readonly mandatory: boolean;
  readonly propertyDefinitionId: string;
  readonly taskRevision: number;
  readonly value: string | null;
  readonly valueRevision: number | null;
}

interface UpdatedEmailValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
  readonly value: string | null;
}

const emailPropertyValueEvidence = (
  input: UpdateEmailPropertyValueActionPayload,
  response: UpdateEmailPropertyValueActionResponse,
) => ({
  changedComponents: ['emailValue'],
  collectionId: input.collectionId,
  datatype: 'email',
  operation: response.value.value === null ? 'cleared' : 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateEmailPropertyValueAuditEvent = {
  evidence: emailPropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse
>;

const updateEmailPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: emailPropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse
>;

const updateEmailPropertyValueActionHandler: ActionHandler<
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse
> = async (input, services) => {
  const parsed = parseEmailValue(input.value);
  if (parsed._tag === 'Invalid') {
    throw rejectAction({
      code: 'ticketing.updateEmailPropertyValue.invalid_email',
      message: parsed.message,
    });
  }

  const currentResult = await services.tx.execute(sql`
    select
      definition.mandatory,
      definition.property_definition_id as "propertyDefinitionId",
      task.revision as "taskRevision",
      value.value,
      value.revision as "valueRevision"
    from ticketing.tasks as task
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.schema_id = schema.schema_id
      and definition.tenant_id = schema.tenant_id
      and definition.datatype = 'email'
    left join ticketing.task_email_values as value
      on value.task_id = task.task_id
      and value.property_definition_id = definition.property_definition_id
      and value.tenant_id = task.tenant_id
    where task.task_id = ${input.taskId}
      and task.collection_id = ${input.collectionId}
      and task.tenant_id = ${services.context.tenantId}
      and definition.property_definition_id = ${input.propertyDefinitionId}
    for update of task, definition
  `);
  const current = rowsFromResult<CurrentEmailValueRow>(currentResult).at(0);
  if (current === undefined || (current.valueRevision ?? 0) !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.updateEmailPropertyValue.stale_or_missing',
      message: 'The Email value changed elsewhere or is no longer available.',
    });
  }
  if (parsed._tag === 'Empty' && current.mandatory) {
    throw rejectAction({
      code: 'ticketing.updateEmailPropertyValue.mandatory',
      message: 'This Mandatory Email must contain one valid email address.',
    });
  }

  const nextValue = parsed._tag === 'Valid' ? parsed.value : null;
  if (current.value === nextValue) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        propertyDefinitionId: current.propertyDefinitionId,
        revision: current.valueRevision ?? 0,
        value: current.value,
      },
    };
  }

  if (parsed._tag === 'Valid') {
    const result = await services.tx.execute(sql`
      with changed_value as (
        insert into ticketing.task_email_values (
          normalized_value,
          property_definition_id,
          task_id,
          tenant_id,
          value
        ) values (
          ${parsed.normalizedValue},
          ${input.propertyDefinitionId},
          ${input.taskId},
          ${services.context.tenantId},
          ${parsed.value}
        )
        on conflict (task_id, property_definition_id) do update
        set
          normalized_value = excluded.normalized_value,
          revision = task_email_values.revision + 1,
          value = excluded.value
        returning property_definition_id, revision, task_id, value
      ),
      updated_task as (
        update ticketing.tasks as task
        set
          last_edited_at = statement_timestamp(),
          last_edited_by_principal_id = ${services.context.principalId},
          revision = task.revision + 1
        from changed_value
        where task.task_id = changed_value.task_id
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
          'email_value_changed',
          updated_task.revision,
          updated_task.task_id,
          ${services.context.tenantId}
        from updated_task
        returning task_id
      )
      select
        changed_value.property_definition_id as "propertyDefinitionId",
        changed_value.revision,
        updated_task.revision as "taskRevision",
        changed_value.value
      from changed_value
      inner join updated_task using (task_id)
      inner join created_revision using (task_id)
    `);
    const updated = rowsFromResult<UpdatedEmailValueRow>(result).at(0);
    if (updated === undefined) {
      throw rejectAction({
        code: 'ticketing.updateEmailPropertyValue.stale_or_missing',
        message: 'The Email value changed elsewhere or is no longer available.',
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
  }

  const result = await services.tx.execute(sql`
    with changed_value as (
      update ticketing.task_email_values
      set
        normalized_value = null,
        revision = revision + 1,
        value = null
      where task_id = ${input.taskId}
        and property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
      returning property_definition_id, revision, task_id, value
    ),
    updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = statement_timestamp(),
        last_edited_by_principal_id = ${services.context.principalId},
        revision = task.revision + 1
      from changed_value
      where task.task_id = changed_value.task_id
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
        'email_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      changed_value.property_definition_id as "propertyDefinitionId",
      changed_value.revision,
      updated_task.revision as "taskRevision",
      changed_value.value
    from changed_value
    inner join updated_task using (task_id)
    inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<UpdatedEmailValueRow>(result).at(0);
  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateEmailPropertyValue.stale_or_missing',
      message: 'The Email value changed elsewhere or is no longer available.',
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

export const updateEmailPropertyValueActionRegistration: ActionRegistration<
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateEmailPropertyValueActionKey,
    auditEvent: updateEmailPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateEmailPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateEmailPropertyValueActionPayloadSchema,
    transportResponseSchema: updateEmailPropertyValueActionResponseSchema,
  },
  handler: updateEmailPropertyValueActionHandler,
};
