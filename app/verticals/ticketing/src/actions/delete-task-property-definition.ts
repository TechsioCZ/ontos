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
  deleteTaskPropertyDefinitionActionKey,
  deleteTaskPropertyDefinitionActionPayloadSchema,
  deleteTaskPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/delete-task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import type {
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse,
} from '../../shared/actions/delete-task-property-definition.ts';

interface DeletionConfirmationRow {
  readonly impactCount: number;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const deletedDefinitionEvidence = (
  input: DeleteTaskPropertyDefinitionActionPayload,
  response: DeleteTaskPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'checkboxValues'],
  collectionId: input.collectionId,
  datatype: 'checkbox',
  impactCount: response.impactCount,
  operation: 'deleted',
  propertyDefinitionId: response.deletedPropertyDefinitionId,
  revision: input.expectedRevision,
});

const deleteTaskPropertyDefinitionAuditEvent = {
  evidence: deletedDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.deletedPropertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse
>;

const deleteTaskPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.deleted',
  payload: deletedDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.deletedPropertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse
>;

const deleteTaskPropertyDefinitionActionHandler: ActionHandler<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse
> = async (input, services) => {
  if (input.confirmed !== true) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.confirmation_required',
      message: 'Task Property deletion must be explicitly confirmed.',
    });
  }

  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const confirmationResult = await services.tx.execute(sql`
    with selected_definition as materialized (
      select definition.property_definition_id, definition.revision, definition.tenant_id
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'checkbox'
        and definition.tenant_id = ${services.context.tenantId}
        and schema.collection_id = ${input.collectionId}
      for update of definition
    )
    select
      count(value.task_id)::integer as "impactCount",
      selected_definition.property_definition_id as "propertyDefinitionId",
      selected_definition.revision
    from selected_definition
    left join ticketing.task_checkbox_values as value
      on value.property_definition_id = selected_definition.property_definition_id
      and value.tenant_id = selected_definition.tenant_id
    left join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    group by selected_definition.property_definition_id, selected_definition.revision
  `);
  const confirmation = rowsFromResult<DeletionConfirmationRow>(confirmationResult).at(0);
  if (confirmation === undefined || confirmation.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }
  if (confirmation.impactCount !== input.expectedImpactCount) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_impact',
      message:
        'The number of affected retained Tasks changed. Review the impact and confirm again.',
    });
  }

  const deletionResult = await services.tx.execute(sql`
    with deleted_values as (
      delete from ticketing.task_checkbox_values
      where property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
      returning task_id
    )
    delete from ticketing.task_property_definitions as definition
    using ticketing.task_schemas as schema
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.revision = ${input.expectedRevision}
      and definition.schema_id = schema.schema_id
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
      and schema.tenant_id = ${services.context.tenantId}
    returning definition.property_definition_id as "propertyDefinitionId"
  `);
  if (rowsFromResult<{ readonly propertyDefinitionId: string }>(deletionResult).length !== 1) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }

  return {
    deletedPropertyDefinitionId: input.propertyDefinitionId,
    impactCount: confirmation.impactCount,
  };
};

export const deleteTaskPropertyDefinitionActionRegistration: ActionRegistration<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: deleteTaskPropertyDefinitionActionKey,
    auditEvent: deleteTaskPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: deleteTaskPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: deleteTaskPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: deleteTaskPropertyDefinitionActionResponseSchema,
  },
  handler: deleteTaskPropertyDefinitionActionHandler,
};
