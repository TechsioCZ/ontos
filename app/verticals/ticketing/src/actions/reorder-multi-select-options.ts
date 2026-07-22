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
  reorderMultiSelectOptionsActionKey,
  reorderMultiSelectOptionsActionPayloadSchema,
  reorderMultiSelectOptionsActionResponseSchema,
} from '../../shared/actions/reorder-multi-select-options.ts';
import type {
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse,
} from '../../shared/actions/reorder-multi-select-options.ts';
import type {
  MultiSelectOption,
  MultiSelectPropertyDefinition,
} from '../../shared/task-property-definition.ts';

const evidence = (
  input: ReorderMultiSelectOptionsActionPayload,
  response: ReorderMultiSelectOptionsActionResponse,
) => ({
  changedComponents: ['optionOrder'],
  collectionId: input.collectionId,
  datatype: 'multi_select',
  operation: 'option_order_configured',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.definition.revision,
});
const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.multiSelectOptionOrder.configured',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse
>;

const handler: ActionHandler<
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse
> = async (input, services) => {
  const definitionResult = await services.tx.execute(sql`
    select datatype, hidden, mandatory, name, property_definition_id as "propertyDefinitionId", revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'multi_select'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition
  `);
  const definition =
    rowsFromResult<Omit<MultiSelectPropertyDefinition, 'options'>>(definitionResult).at(0);
  if (definition === undefined || definition.revision !== input.expectedDefinitionRevision) {
    throw rejectAction({
      code: 'ticketing.reorderMultiSelectOptions.stale_or_missing',
      message: 'The Multi-select catalog changed elsewhere or is no longer available.',
    });
  }
  const optionsResult = await services.tx.execute(sql`
    select
      catalog_position as "catalogPosition",
      color,
      name,
      option_id as "optionId",
      revision,
      to_char(
        updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "updatedAt"
    from ticketing.multi_select_options
    where property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
    order by catalog_position, option_id
  `);
  const options = rowsFromResult<MultiSelectOption>(optionsResult);
  const uniqueIds = new Set(input.optionIds);
  if (
    uniqueIds.size !== options.length ||
    input.optionIds.length !== options.length ||
    options.some(({ optionId }) => !uniqueIds.has(optionId))
  ) {
    throw rejectAction({
      code: 'ticketing.reorderMultiSelectOptions.invalid_order',
      message: 'Catalog order must contain every Multi-select option exactly once.',
    });
  }
  if (options.every(({ optionId }, index) => optionId === input.optionIds[index])) {
    services.markNoOp();
    return { definition: { ...definition, options } };
  }
  await services.tx.execute(sql`
    update ticketing.multi_select_options
    set catalog_position = catalog_position + 1000000
    where property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  const byId = new Map(options.map((option) => [option.optionId, option]));
  const reordered: MultiSelectOption[] = [];
  for (const [catalogPosition, optionId] of input.optionIds.entries()) {
    const option = byId.get(optionId);
    if (option === undefined) {
      throw new Error('Validated Multi-select option is missing.');
    }
    // oxlint-disable-next-line no-await-in-loop -- Unique catalog positions are persisted sequentially.
    const reorderedResult = await services.tx.execute(sql`
      update ticketing.multi_select_options
      set catalog_position = ${catalogPosition},
          revision = revision + 1,
          updated_at = statement_timestamp()
      where option_id = ${optionId}
        and property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
      returning
        revision,
        to_char(
          updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "updatedAt"
    `);
    const reorderedOption = rowsFromResult<{
      readonly revision: number;
      readonly updatedAt: string;
    }>(reorderedResult).at(0);
    if (reorderedOption === undefined) {
      throw new Error('Validated Multi-select option could not be reordered.');
    }
    reordered.push({ ...option, ...reorderedOption, catalogPosition });
  }
  const updatedResult = await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedDefinitionRevision}
      and tenant_id = ${services.context.tenantId}
    returning revision
  `);
  const revision = rowsFromResult<{ readonly revision: number }>(updatedResult).at(0)?.revision;
  if (revision === undefined) {
    throw rejectAction({
      code: 'ticketing.reorderMultiSelectOptions.stale_or_missing',
      message: 'The Multi-select catalog changed elsewhere or is no longer available.',
    });
  }
  return { definition: { ...definition, options: reordered, revision } };
};

export const reorderMultiSelectOptionsActionRegistration: ActionRegistration<
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse
> = {
  descriptor: {
    actionKey: reorderMultiSelectOptionsActionKey,
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
    transportRequestSchema: reorderMultiSelectOptionsActionPayloadSchema,
    transportResponseSchema: reorderMultiSelectOptionsActionResponseSchema,
  },
  handler,
};
