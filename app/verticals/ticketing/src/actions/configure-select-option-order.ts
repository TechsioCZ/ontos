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
  configureSelectOptionOrderActionKey,
  configureSelectOptionOrderActionPayloadSchema,
  configureSelectOptionOrderActionResponseSchema,
} from '../../shared/actions/configure-select-option-order.ts';
import type {
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse,
} from '../../shared/actions/configure-select-option-order.ts';
import type {
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
} from '../../shared/task-property-definition.ts';

type DefinitionRow = Omit<SelectPropertyDefinition, 'options'>;
type OptionRow = SelectOption;

const displayedOptions = (
  options: readonly SelectOption[],
  mode: SelectOptionOrderMode,
  locale: string,
): SelectOption[] => {
  if (mode === 'manual') {
    return options.toSorted(
      (left, right) =>
        left.manualPosition - right.manualPosition || left.optionId.localeCompare(right.optionId),
    );
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'variant', usage: 'sort' });
  const direction = mode === 'reverse_alphabetical' ? -1 : 1;
  return options.toSorted(
    (left, right) =>
      direction * collator.compare(left.name.normalize('NFC'), right.name.normalize('NFC')) ||
      left.optionId.localeCompare(right.optionId),
  );
};

const evidence = (
  input: ConfigureSelectOptionOrderActionPayload,
  response: ConfigureSelectOptionOrderActionResponse,
) => ({
  changedComponents: ['optionOrder'],
  collectionId: input.collectionId,
  datatype: 'select',
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
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse
>;
const domainEvent = {
  eventType: 'ticketing.selectOptionOrder.configured',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse
>;

const handler: ActionHandler<
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse
> = async (input, services) => {
  const definitionResult = await services.tx.execute(sql`
    select
      definition.datatype,
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.select_option_order_mode as "optionOrderMode",
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'select'
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    for update of definition
  `);
  const definition = rowsFromResult<DefinitionRow>(definitionResult).at(0);
  if (definition === undefined || definition.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.configureSelectOptionOrder.stale_or_missing',
      message: 'The Select option order changed elsewhere or is no longer available.',
    });
  }
  const optionResult = await services.tx.execute(sql`
    select color, manual_position as "manualPosition", name, option_id as "optionId", revision
    from ticketing.select_options
    where property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  const options = rowsFromResult<OptionRow>(optionResult);
  let ordered = displayedOptions(options, definition.optionOrderMode, input.viewerLocale);
  if (input.optionOrderMode === 'manual' && input.manualOptionIds !== undefined) {
    const uniqueIds = new Set(input.manualOptionIds);
    if (
      uniqueIds.size !== options.length ||
      options.some(({ optionId }) => !uniqueIds.has(optionId))
    ) {
      throw rejectAction({
        code: 'ticketing.configureSelectOptionOrder.invalid_manual_order',
        message: 'Manual order must contain every Select option exactly once.',
      });
    }
    const byId = new Map(options.map((option) => [option.optionId, option]));
    ordered = input.manualOptionIds.map((optionId) => {
      const option = byId.get(optionId);

      if (option === undefined) {
        throw new Error('Validated Select option is missing.');
      }

      return option;
    });
  }
  if (definition.optionOrderMode === input.optionOrderMode && input.manualOptionIds === undefined) {
    services.markNoOp();
    return { definition: { ...definition, options: ordered } };
  }
  if (input.optionOrderMode === 'manual') {
    await services.tx.execute(sql`
      update ticketing.select_options
      set manual_position = manual_position + 1000000
      where property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
    `);
    for (const [manualPosition, option] of ordered.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Unique positions are persisted sequentially.
      await services.tx.execute(sql`
        update ticketing.select_options
        set manual_position = ${manualPosition}
        where option_id = ${option.optionId}
          and property_definition_id = ${input.propertyDefinitionId}
          and tenant_id = ${services.context.tenantId}
      `);
    }
    ordered = ordered.map((option, manualPosition) => ({ ...option, manualPosition }));
  }
  const updatedResult = await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set select_option_order_mode = ${input.optionOrderMode}, revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedRevision}
      and tenant_id = ${services.context.tenantId}
    returning revision
  `);
  const revision = rowsFromResult<{ readonly revision: number }>(updatedResult).at(0)?.revision;
  if (revision === undefined) {
    throw rejectAction({
      code: 'ticketing.configureSelectOptionOrder.stale_or_missing',
      message: 'The Select option order changed elsewhere or is no longer available.',
    });
  }
  return {
    definition: {
      ...definition,
      optionOrderMode: input.optionOrderMode,
      options: displayedOptions(ordered, input.optionOrderMode, input.viewerLocale),
      revision,
    },
  };
};

export const configureSelectOptionOrderActionRegistration: ActionRegistration<
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse
> = {
  descriptor: {
    actionKey: configureSelectOptionOrderActionKey,
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
    transportRequestSchema: configureSelectOptionOrderActionPayloadSchema,
    transportResponseSchema: configureSelectOptionOrderActionResponseSchema,
  },
  handler,
};
