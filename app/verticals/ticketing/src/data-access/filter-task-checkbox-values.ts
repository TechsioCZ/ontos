// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  filterTaskCheckboxValuesPayloadSchema,
  filterTaskCheckboxValuesResponseSchema,
} from '../../shared/checkbox-filter.ts';
import type {
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse,
} from '../../shared/checkbox-filter.ts';

export const filterTaskCheckboxValuesDataAccessRegistration: DataAccessRegistration<
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse
> = {
  descriptor: {
    accessKind: 'list',
    auditProfile: 'standard',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskCheckboxValues.filter',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskCheckboxValues.filter.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: filterTaskCheckboxValuesPayloadSchema,
    transportResponseSchema: filterTaskCheckboxValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select task.task_id as "taskId"
      from ticketing.task_checkbox_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'checkbox'
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where value.property_definition_id = ${input.propertyDefinitionId}
        and value.value = ${input.value}
        and value.tenant_id = ${context.tenantId}
        and task.collection_id = ${input.collectionId}
        and schema.collection_id = ${input.collectionId}
      order by task.created_at, task.task_id
    `);

    return {
      taskIds: [...rowsFromResult<{ readonly taskId: string }>(result)].map(({ taskId }) => taskId),
    };
  },
};
