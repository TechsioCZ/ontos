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
  deleteStatusOptionActionKey,
  deleteStatusOptionActionPayloadSchema,
  deleteStatusOptionActionResponseSchema,
} from '../../shared/actions/delete-status-option.ts';
import type {
  DeleteStatusOptionActionPayload,
  DeleteStatusOptionActionResponse,
} from '../../shared/actions/delete-status-option.ts';
import { getStatusOptionDeletionImpactState } from '../status-option-deletion-impact.ts';

interface LockedOptionRow {
  readonly defaultOptionId: string;
  readonly definitionRevision: number;
  readonly optionRevision: number;
}

const evidence = (
  input: DeleteStatusOptionActionPayload,
  response: DeleteStatusOptionActionResponse,
) => ({
  changedComponents: ['optionCatalog', 'statusValues'],
  collectionId: input.collectionId,
  datatype: 'status',
  impactCount: response.impactCount,
  operation: 'option_deleted',
  optionId: response.deletedOptionId,
  propertyDefinitionId: input.propertyDefinitionId,
  replacementOptionId: response.replacementOptionId,
  revision: response.definitionRevision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.deletedOptionId,
  targetResourceType: 'status_option',
} satisfies ActionAuditEventDescriptor<
  DeleteStatusOptionActionPayload,
  DeleteStatusOptionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.statusOption.deleted',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.deletedOptionId,
  subjectResourceType: 'status_option',
} satisfies ActionDomainEventDescriptor<
  DeleteStatusOptionActionPayload,
  DeleteStatusOptionActionResponse
>;

const handler: ActionHandler<
  DeleteStatusOptionActionPayload,
  DeleteStatusOptionActionResponse
> = async (input, services) => {
  if (!input.confirmed) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.confirmation_required',
      message: 'Status Option deletion must be explicitly confirmed.',
    });
  }

  const lockedResult = await services.tx.execute(sql`
    select
      configuration.default_option_id as "defaultOptionId",
      definition.revision as "definitionRevision",
      option.revision as "optionRevision"
    from ticketing.status_options as option
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = option.property_definition_id
      and definition.tenant_id = option.tenant_id
      and definition.datatype = 'status'
    inner join ticketing.status_property_configurations as configuration
      on configuration.property_definition_id = definition.property_definition_id
      and configuration.tenant_id = definition.tenant_id
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where option.option_id = ${input.optionId}
      and option.property_definition_id = ${input.propertyDefinitionId}
      and option.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition, option, configuration
  `);
  const locked = rowsFromResult<LockedOptionRow>(lockedResult).at(0);
  if (
    locked === undefined ||
    locked.definitionRevision !== input.expectedDefinitionRevision ||
    locked.optionRevision !== input.expectedOptionRevision
  ) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.stale_or_missing',
      message: 'The Status Option changed elsewhere or is no longer available.',
    });
  }
  if (locked.defaultOptionId === input.optionId) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.default_protected',
      message: 'Choose another Default before deleting the current Default Status Option.',
    });
  }

  const impact = await getStatusOptionDeletionImpactState({
    db: services.tx,
    lockAffectedValues: true,
    optionId: input.optionId,
    propertyDefinitionId: input.propertyDefinitionId,
    tenantId: services.context.tenantId,
  });
  if (
    impact.impactCount !== input.expectedImpactCount ||
    impact.impactToken !== input.expectedImpactToken
  ) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.stale_impact',
      message:
        'The number of affected retained Tasks changed. Review the impact and confirm again.',
    });
  }

  await services.tx.execute(sql`
    update ticketing.task_status_values
    set option_id = ${locked.defaultOptionId},
        revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and option_id = ${input.optionId}
      and tenant_id = ${services.context.tenantId}
  `);
  const deletedResult = await services.tx.execute(sql`
    delete from ticketing.status_options
    where option_id = ${input.optionId}
      and property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedOptionRevision}
      and tenant_id = ${services.context.tenantId}
    returning option_id as "deletedOptionId"
  `);
  if (rowsFromResult(deletedResult).length !== 1) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.stale_or_missing',
      message: 'The Status Option changed elsewhere or is no longer available.',
    });
  }
  const definitionResult = await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedDefinitionRevision}
      and tenant_id = ${services.context.tenantId}
    returning revision as "definitionRevision"
  `);
  const definitionRevision = rowsFromResult<{ readonly definitionRevision: number }>(
    definitionResult,
  ).at(0)?.definitionRevision;
  if (definitionRevision === undefined) {
    throw rejectAction({
      code: 'ticketing.deleteStatusOption.stale_or_missing',
      message: 'The Status Option changed elsewhere or is no longer available.',
    });
  }

  return {
    definitionRevision,
    deletedOptionId: input.optionId,
    impactCount: impact.impactCount,
    propertyDefinitionId: input.propertyDefinitionId,
    replacementOptionId: locked.defaultOptionId,
  };
};

export const deleteStatusOptionActionRegistration: ActionRegistration<
  DeleteStatusOptionActionPayload,
  DeleteStatusOptionActionResponse
> = {
  descriptor: {
    actionKey: deleteStatusOptionActionKey,
    auditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: deleteStatusOptionActionPayloadSchema,
    transportResponseSchema: deleteStatusOptionActionResponseSchema,
  },
  handler,
};
