// @effect-diagnostics asyncFunction:off
import { createPersonDirectory, rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  updatePersonPropertyValueActionKey,
  updatePersonPropertyValueActionPayloadSchema,
  updatePersonPropertyValueActionResponseSchema,
} from '../../shared/actions/update-person-property-value.ts';
import type {
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse,
} from '../../shared/actions/update-person-property-value.ts';

interface CurrentPersonValueRow {
  readonly cardinality: 'one' | 'unlimited';
  readonly mandatory: boolean;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskRevision: number;
}

interface AssignmentRow {
  readonly principalId: string;
}

interface UpdatedPersonValueRow {
  readonly revision: number;
  readonly taskRevision: number;
}

const personValueEvidence = (
  input: UpdatePersonPropertyValueActionPayload,
  response: UpdatePersonPropertyValueActionResponse,
) => ({
  changedComponents: ['personValue'],
  collectionId: input.collectionId,
  datatype: 'person',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updatePersonPropertyValueAuditEvent = {
  evidence: personValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse
>;

const updatePersonPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: personValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse
>;

const updatePersonPropertyValueActionHandler: ActionHandler<
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select
      configuration.cardinality,
      definition.mandatory,
      value.property_definition_id as "propertyDefinitionId",
      value.revision,
      task.revision as "taskRevision"
    from ticketing.task_person_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'person'
    inner join ticketing.task_person_property_configurations as configuration
      on configuration.property_definition_id = definition.property_definition_id
      and configuration.tenant_id = definition.tenant_id
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where value.task_id = ${input.taskId}
      and value.property_definition_id = ${input.propertyDefinitionId}
      and value.revision = ${input.expectedRevision}
      and value.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
      and schema.collection_id = ${input.collectionId}
    for update of value, task, definition
  `);
  const current = rowsFromResult<CurrentPersonValueRow>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updatePersonPropertyValue.stale_or_missing',
      message: 'The Person value changed elsewhere or is no longer available.',
    });
  }

  const assignmentResult = await services.tx.execute(sql`
    select principal_id as "principalId"
    from ticketing.task_person_assignments
    where task_id = ${input.taskId}
      and property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
    order by principal_id
  `);
  const currentPrincipalIds = rowsFromResult<AssignmentRow>(assignmentResult).map(
    ({ principalId }) => principalId,
  );
  const desiredPrincipalIds = [...new Set(input.principalIds)].toSorted();

  if (current.cardinality === 'one' && desiredPrincipalIds.length > 1) {
    throw rejectAction({
      code: 'ticketing.updatePersonPropertyValue.cardinality_exceeded',
      message: 'This Person Task Property accepts at most one Principal.',
    });
  }
  if (current.mandatory && desiredPrincipalIds.length === 0) {
    throw rejectAction({
      code: 'ticketing.updatePersonPropertyValue.mandatory_empty',
      message: 'A Mandatory Person Task Property cannot be Empty when the Task is edited.',
    });
  }

  const currentIds = new Set(currentPrincipalIds);
  const newlyAssignedIds = desiredPrincipalIds.filter(
    (principalId) => !currentIds.has(principalId),
  );
  const eligibleIds = await createPersonDirectory({
    db: services.tx,
    tenantId: services.context.tenantId,
  }).eligiblePrincipalIds(newlyAssignedIds);
  if (eligibleIds.size !== newlyAssignedIds.length) {
    throw rejectAction({
      code: 'ticketing.updatePersonPropertyValue.principal_ineligible',
      message: 'Every newly assigned Principal must be an active tenant member or guest.',
    });
  }

  if (
    currentPrincipalIds.length === desiredPrincipalIds.length &&
    currentPrincipalIds.every((principalId, index) => principalId === desiredPrincipalIds[index])
  ) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        principalIds: currentPrincipalIds,
        propertyDefinitionId: current.propertyDefinitionId,
        revision: current.revision,
      },
    };
  }

  await services.tx.execute(sql`
    delete from ticketing.task_person_assignments
    where task_id = ${input.taskId}
      and property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  if (desiredPrincipalIds.length > 0) {
    await services.tx.execute(sql`
      insert into ticketing.task_person_assignments (
        principal_id,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        value::uuid,
        ${input.propertyDefinitionId},
        ${input.taskId},
        ${services.context.tenantId}
      from jsonb_array_elements_text(${JSON.stringify(desiredPrincipalIds)}::jsonb)
    `);
  }

  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with updated_value as (
      update ticketing.task_person_values as value
      set revision = value.revision + 1
      where value.task_id = ${input.taskId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.revision = ${input.expectedRevision}
        and value.tenant_id = ${services.context.tenantId}
      returning value.revision, value.task_id
    ),
    updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = ${changedAt}::timestamptz,
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
        'person_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      updated_value.revision,
      updated_task.revision as "taskRevision"
    from updated_value
    inner join updated_task using (task_id)
    inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<UpdatedPersonValueRow>(result).at(0);
  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updatePersonPropertyValue.stale_or_missing',
      message: 'The Person value changed elsewhere or is no longer available.',
    });
  }

  return {
    taskRevision: updated.taskRevision,
    value: {
      principalIds: desiredPrincipalIds,
      propertyDefinitionId: input.propertyDefinitionId,
      revision: updated.revision,
    },
  };
};

export const updatePersonPropertyValueActionRegistration: ActionRegistration<
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updatePersonPropertyValueActionKey,
    auditEvent: updatePersonPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updatePersonPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updatePersonPropertyValueActionPayloadSchema,
    transportResponseSchema: updatePersonPropertyValueActionResponseSchema,
  },
  handler: updatePersonPropertyValueActionHandler,
};
