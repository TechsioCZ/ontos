// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  getSelectOptionDeletionImpactPayloadSchema,
  selectOptionDeletionImpactSchema,
} from '../../shared/select-option-deletion-impact.ts';
import type {
  GetSelectOptionDeletionImpactPayload,
  SelectOptionDeletionImpact,
} from '../../shared/select-option-deletion-impact.ts';

export const getSelectOptionDeletionImpactDataAccessRegistration: DataAccessRegistration<
  GetSelectOptionDeletionImpactPayload,
  SelectOptionDeletionImpact
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.selectOptionDeletionImpact.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.selectOptionDeletionImpact.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'select_option',
    transportRequestSchema: getSelectOptionDeletionImpactPayloadSchema,
    transportResponseSchema: selectOptionDeletionImpactSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select
        definition.revision as "definitionRevision",
        count(task.task_id)::integer as "impactCount",
        option.option_id as "optionId",
        option.revision as "optionRevision",
        option.property_definition_id as "propertyDefinitionId"
      from ticketing.select_options as option
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = option.property_definition_id
        and definition.tenant_id = option.tenant_id
        and definition.datatype = 'select'
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      left join ticketing.task_select_values as value
        on value.option_id = option.option_id
        and value.property_definition_id = option.property_definition_id
        and value.tenant_id = option.tenant_id
      left join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where option.option_id = ${input.optionId}
        and option.property_definition_id = ${input.propertyDefinitionId}
        and option.tenant_id = ${context.tenantId}
        and schema.collection_id = ${input.collectionId}
      group by definition.revision, option.option_id, option.revision, option.property_definition_id
    `);
    const impact = rowsFromResult<SelectOptionDeletionImpact>(result).at(0);
    if (impact === undefined) {
      throw new Error('Select Option was not found.');
    }
    return impact;
  },
};
