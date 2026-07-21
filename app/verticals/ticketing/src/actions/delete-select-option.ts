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
  deleteSelectOptionActionKey,
  deleteSelectOptionActionPayloadSchema,
  deleteSelectOptionActionResponseSchema,
} from '../../shared/actions/delete-select-option.ts';
import type {
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse,
} from '../../shared/actions/delete-select-option.ts';

interface LockedOptionRow {
  readonly definitionRevision: number;
  readonly optionRevision: number;
}

interface ImpactCountRow {
  readonly impactCount: number;
}

const evidence = (
  input: DeleteSelectOptionActionPayload,
  response: DeleteSelectOptionActionResponse,
) => ({
  changedComponents: ['optionCatalog', 'selectValues'],
  collectionId: input.collectionId,
  datatype: 'select',
  impactCount: response.impactCount,
  operation: 'option_deleted',
  optionId: response.deletedOptionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definitionRevision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.deletedOptionId,
  targetResourceType: 'select_option',
} satisfies ActionAuditEventDescriptor<
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.selectOption.deleted',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.deletedOptionId,
  subjectResourceType: 'select_option',
} satisfies ActionDomainEventDescriptor<
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse
>;

const handler: ActionHandler<
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse
> = async (input, services) => {
  if (!input.confirmed) {
    throw rejectAction({
      code: 'ticketing.deleteSelectOption.confirmation_required',
      message: 'Select Option deletion must be explicitly confirmed.',
    });
  }

  const lockedResult = await services.tx.execute(sql`
    select
      definition.revision as "definitionRevision",
      option.revision as "optionRevision"
    from ticketing.select_options as option
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = option.property_definition_id
      and definition.tenant_id = option.tenant_id
      and definition.datatype = 'select'
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    where option.option_id = ${input.optionId}
      and option.property_definition_id = ${input.propertyDefinitionId}
      and option.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition, option
  `);
  const locked = rowsFromResult<LockedOptionRow>(lockedResult).at(0);
  if (
    locked === undefined ||
    locked.definitionRevision !== input.expectedDefinitionRevision ||
    locked.optionRevision !== input.expectedOptionRevision
  ) {
    throw rejectAction({
      code: 'ticketing.deleteSelectOption.stale_or_missing',
      message: 'The Select Option changed elsewhere or is no longer available.',
    });
  }

  const impactResult = await services.tx.execute(sql`
    select count(task.task_id)::integer as "impactCount"
    from ticketing.task_select_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    where value.property_definition_id = ${input.propertyDefinitionId}
      and value.option_id = ${input.optionId}
      and value.tenant_id = ${services.context.tenantId}
  `);
  const impactCount = rowsFromResult<ImpactCountRow>(impactResult).at(0)?.impactCount ?? 0;
  if (impactCount !== input.expectedImpactCount) {
    throw rejectAction({
      code: 'ticketing.deleteSelectOption.stale_impact',
      message:
        'The number of affected retained Tasks changed. Review the impact and confirm again.',
    });
  }

  await services.tx.execute(sql`
    update ticketing.task_select_values
    set option_id = null,
        revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and option_id = ${input.optionId}
      and tenant_id = ${services.context.tenantId}
  `);
  const deletedResult = await services.tx.execute(sql`
    delete from ticketing.select_options
    where option_id = ${input.optionId}
      and property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedOptionRevision}
      and tenant_id = ${services.context.tenantId}
    returning option_id as "deletedOptionId"
  `);
  if (rowsFromResult(deletedResult).length !== 1) {
    throw rejectAction({
      code: 'ticketing.deleteSelectOption.stale_or_missing',
      message: 'The Select Option changed elsewhere or is no longer available.',
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
      code: 'ticketing.deleteSelectOption.stale_or_missing',
      message: 'The Select Option changed elsewhere or is no longer available.',
    });
  }

  return {
    definitionRevision,
    deletedOptionId: input.optionId,
    impactCount,
    propertyDefinitionId: input.propertyDefinitionId,
  };
};

export const deleteSelectOptionActionRegistration: ActionRegistration<
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse
> = {
  descriptor: {
    actionKey: deleteSelectOptionActionKey,
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
    transportRequestSchema: deleteSelectOptionActionPayloadSchema,
    transportResponseSchema: deleteSelectOptionActionResponseSchema,
  },
  handler,
};
