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
  updateStatusOptionActionKey,
  updateStatusOptionActionPayloadSchema,
  updateStatusOptionActionResponseSchema,
} from '../../shared/actions/update-status-option.ts';
import type {
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse,
} from '../../shared/actions/update-status-option.ts';
import type { StatusGroupKey, StatusOption } from '../../shared/task-property-definition.ts';
import { prepareSelectOptionName } from '../select-option-name.ts';

type StoredOptionRow = StatusOption;

const evidence = (
  input: UpdateStatusOptionActionPayload,
  response: UpdateStatusOptionActionResponse,
) => ({
  changedComponents: ['statusOptionPresentation', 'statusOptionOrder'],
  collectionId: input.collectionId,
  datatype: 'status',
  operation: 'option_updated',
  optionId: input.optionId,
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.option.revision,
});

const auditEvent = {
  evidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.optionId,
  targetResourceType: 'status_option',
} satisfies ActionAuditEventDescriptor<
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.statusOption.updated',
  payload: evidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.optionId,
  subjectResourceType: 'status_option',
} satisfies ActionDomainEventDescriptor<
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse
>;

const handler: ActionHandler<
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse
> = async (input, services) => {
  const { displayName, normalizedName } = prepareSelectOptionName(input.name);
  if (
    displayName.length === 0 ||
    input.color.length === 0 ||
    !Number.isInteger(input.position) ||
    input.position < 0
  ) {
    throw rejectAction({
      code: 'ticketing.updateStatusOption.invalid',
      message: 'A valid Status Option name, color, group, and position are required.',
    });
  }
  const optionResult = await services.tx.execute(sql`
    select
      option.color,
      option.group_key as "group",
      option.name,
      option.option_id as "optionId",
      option.position,
      option.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    inner join ticketing.status_options as option
      on option.property_definition_id = definition.property_definition_id
      and option.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${input.propertyDefinitionId}
      and definition.datatype = 'status'
      and definition.revision = ${input.expectedDefinitionRevision}
      and definition.tenant_id = ${services.context.tenantId}
      and schema.collection_id = ${input.collectionId}
    order by option.group_key, option.position, option.option_id
    for update of definition, option
  `);
  const options = rowsFromResult<StoredOptionRow>(optionResult);
  const current = options.find(({ optionId }) => optionId === input.optionId);
  if (current === undefined || current.revision !== input.expectedOptionRevision) {
    throw rejectAction({
      code: 'ticketing.updateStatusOption.stale_or_missing',
      message: 'The Status Option or definition changed or is unavailable.',
    });
  }
  const targetSiblings = options.filter(
    ({ group, optionId }) => group === input.group && optionId !== input.optionId,
  );
  if (input.position > targetSiblings.length) {
    throw rejectAction({
      code: 'ticketing.updateStatusOption.position_out_of_range',
      message: 'The Status Option position is outside its target group.',
    });
  }
  const reordered = new Map<
    string,
    { readonly group: StatusGroupKey; readonly position: number }
  >();
  for (const group of ['todo', 'in_progress', 'complete'] as const) {
    const groupOptions = options
      .filter(
        ({ group: candidateGroup, optionId }) =>
          candidateGroup === group && optionId !== input.optionId,
      )
      .toSorted(
        (left, right) =>
          left.position - right.position || left.optionId.localeCompare(right.optionId),
      );
    if (group === input.group) {
      groupOptions.splice(input.position, 0, current);
    }
    for (const [position, { optionId }] of groupOptions.entries()) {
      reordered.set(optionId, { group, position });
    }
  }
  await services.tx.execute(sql`
    update ticketing.status_options
    set position = position + 1000000
    where property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  for (const option of options) {
    const order = reordered.get(option.optionId);
    if (order === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Each row participates in one atomic, revision-locked reorder.
    await services.tx.execute(sql`
      update ticketing.status_options
      set
        color = case when option_id = ${input.optionId} then ${input.color} else color end,
        group_key = ${order.group},
        name = case when option_id = ${input.optionId} then ${displayName} else name end,
        normalized_name = case when option_id = ${input.optionId} then ${normalizedName} else normalized_name end,
        position = ${order.position},
        revision = case when option_id = ${input.optionId} then revision + 1 else revision end
      where option_id = ${option.optionId}
        and property_definition_id = ${input.propertyDefinitionId}
        and tenant_id = ${services.context.tenantId}
        and not exists (
          select 1 from ticketing.status_options as sibling
          where sibling.property_definition_id = ${input.propertyDefinitionId}
            and sibling.option_id <> ${input.optionId}
            and sibling.normalized_name = ${normalizedName}
        )
    `);
  }
  const definitionResult = await services.tx.execute(sql`
    update ticketing.task_property_definitions
    set revision = revision + 1
    where property_definition_id = ${input.propertyDefinitionId}
      and revision = ${input.expectedDefinitionRevision}
      and tenant_id = ${services.context.tenantId}
    returning revision
  `);
  if (rowsFromResult(definitionResult).length !== 1) {
    throw rejectAction({
      code: 'ticketing.updateStatusOption.stale_or_name_conflict',
      message: 'The Status Option could not be updated.',
    });
  }
  const updatedResult = await services.tx.execute(sql`
    select
      color,
      group_key as "group",
      name,
      option_id as "optionId",
      position,
      revision
    from ticketing.status_options
    where option_id = ${input.optionId}
      and property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);
  const option = rowsFromResult<StatusOption>(updatedResult).at(0);
  if (option === undefined || option.revision !== input.expectedOptionRevision + 1) {
    throw rejectAction({
      code: 'ticketing.updateStatusOption.name_conflict',
      message: 'The Status Option name is already in use.',
    });
  }
  return { definitionRevision: input.expectedDefinitionRevision + 1, option };
};

export const updateStatusOptionActionRegistration: ActionRegistration<
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse
> = {
  descriptor: {
    actionKey: updateStatusOptionActionKey,
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
    transportRequestSchema: updateStatusOptionActionPayloadSchema,
    transportResponseSchema: updateStatusOptionActionResponseSchema,
  },
  handler,
};
