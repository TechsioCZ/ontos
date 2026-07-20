// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  createCheckboxPropertyDefinitionActionKey,
  createCheckboxPropertyDefinitionActionPayloadSchema,
  createCheckboxPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/create-checkbox-property-definition.ts';
import type {
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse,
} from '../../shared/actions/create-checkbox-property-definition.ts';

interface CheckboxPropertyDefinitionRow {
  readonly datatype: 'checkbox';
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

const createCheckboxPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.created',
  payload: (_input, response) => ({
    changedComponents: ['definition'],
    datatype: response.definition.datatype,
    operation: 'created',
    propertyDefinitionId: response.definition.propertyDefinitionId,
    revision: response.definition.revision,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse
>;

const createCheckboxPropertyDefinitionActionHandler: ActionHandler<
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse
> = async (input, services) => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw rejectAction({
      code: 'ticketing.createCheckboxPropertyDefinition.name_required',
      message: 'A Task Property Definition name is required.',
    });
  }

  const result = await services.tx.execute(sql`
    with selected_schema as (
      select schema.schema_id
      from ticketing.task_schemas as schema
      where schema.collection_id = ${input.collectionId}
        and schema.tenant_id = ${services.context.tenantId}
    ),
    inserted_definition as (
      insert into ticketing.task_property_definitions (
        datatype,
        mandatory,
        name,
        schema_id,
        tenant_id
      )
      select
        'checkbox',
        ${input.mandatory},
        ${name},
        schema_id,
        ${services.context.tenantId}
      from selected_schema
      on conflict do nothing
      returning datatype, mandatory, name, property_definition_id, revision
    ),
    initialized_values as (
      insert into ticketing.task_checkbox_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        inserted_definition.property_definition_id,
        task.task_id,
        ${services.context.tenantId},
        false
      from inserted_definition
      inner join ticketing.tasks as task
        on task.collection_id = ${input.collectionId}
        and task.tenant_id = ${services.context.tenantId}
      returning task_id
    )
    select
      datatype,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision
    from inserted_definition
  `);
  const definition = rowsFromResult<CheckboxPropertyDefinitionRow>(result).at(0);

  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.createCheckboxPropertyDefinition.not_created',
      message: 'The Task Collection was not found or the property name is already in use.',
    });
  }

  return { definition };
};

export const createCheckboxPropertyDefinitionActionRegistration: ActionRegistration<
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: createCheckboxPropertyDefinitionActionKey,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: createCheckboxPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createCheckboxPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: createCheckboxPropertyDefinitionActionResponseSchema,
  },
  handler: createCheckboxPropertyDefinitionActionHandler,
};
