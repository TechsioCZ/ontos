// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  groupTaskDateValuesPayloadSchema,
  groupTaskDateValuesResponseSchema,
} from '../../shared/date-grouping.ts';
import type {
  GroupTaskDateValuesPayload,
  GroupTaskDateValuesResponse,
} from '../../shared/date-grouping.ts';

interface GroupingRow {
  readonly taskId: string;
  readonly value: string | null;
}

export const groupTaskDateValuesDataAccessRegistration: DataAccessRegistration<
  GroupTaskDateValuesPayload,
  GroupTaskDateValuesResponse
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
    dataAccessKey: 'ticketing.taskDateValues.group',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskDateValues.group.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: groupTaskDateValuesPayloadSchema,
    transportResponseSchema: groupTaskDateValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select
        task.task_id as "taskId",
        value.value::text as value
      from ticketing.tasks as task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = task.collection_id
        and schema.tenant_id = task.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = schema.tenant_id
        and definition.datatype = 'date'
      left join ticketing.task_date_values as value
        on value.task_id = task.task_id
        and value.property_definition_id = definition.property_definition_id
        and value.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
        and definition.property_definition_id = ${input.propertyDefinitionId}
      order by value.value nulls last, task.created_at, task.task_id
    `);
    const groups = new Map<string | null, string[]>();
    for (const { taskId, value } of rowsFromResult<GroupingRow>(result)) {
      const taskIds = groups.get(value) ?? [];
      taskIds.push(taskId);
      groups.set(value, taskIds);
    }

    return {
      groups: [...groups].map(([value, taskIds]) => ({ taskIds, value })),
    };
  },
};
