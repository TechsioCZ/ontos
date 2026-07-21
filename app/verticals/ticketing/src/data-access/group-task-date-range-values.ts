// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  groupTaskDateRangeValuesPayloadSchema,
  groupTaskDateRangeValuesResponseSchema,
} from '../../shared/date-range-grouping.ts';
import type {
  GroupTaskDateRangeValuesPayload,
  GroupTaskDateRangeValuesResponse,
} from '../../shared/date-range-grouping.ts';
import type { DateRangeValue } from '../../shared/date-range-value.ts';

interface GroupingRow {
  readonly endDate: string | null;
  readonly endTime: string | null;
  readonly startDate: string | null;
  readonly startTime: string | null;
  readonly taskId: string;
}

export const groupTaskDateRangeValuesDataAccessRegistration: DataAccessRegistration<
  GroupTaskDateRangeValuesPayload,
  GroupTaskDateRangeValuesResponse
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
    dataAccessKey: 'ticketing.taskDateRangeValues.group',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskDateRangeValues.group.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: groupTaskDateRangeValuesPayloadSchema,
    transportResponseSchema: groupTaskDateRangeValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select value.end_date::text as "endDate", to_char(value.end_time, 'HH24:MI') as "endTime",
        value.start_date::text as "startDate", to_char(value.start_time, 'HH24:MI') as "startTime",
        task.task_id as "taskId"
      from ticketing.tasks as task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = task.collection_id and schema.tenant_id = task.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id and definition.tenant_id = schema.tenant_id
        and definition.datatype = 'date_range'
      left join ticketing.task_date_range_values as value
        on value.task_id = task.task_id
        and value.property_definition_id = definition.property_definition_id
        and value.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
        and definition.property_definition_id = ${input.propertyDefinitionId}
      order by value.start_date nulls last, value.end_date nulls last,
        value.start_time nulls first, value.end_time nulls first, task.created_at, task.task_id
    `);
    const groups = new Map<string, { taskIds: string[]; value: DateRangeValue | null }>();
    for (const row of rowsFromResult<GroupingRow>(result)) {
      const value =
        row.startDate === null || row.endDate === null
          ? null
          : {
              endDate: row.endDate,
              endTime: row.endTime,
              startDate: row.startDate,
              startTime: row.startTime,
            };
      const key = JSON.stringify(value);
      const group = groups.get(key) ?? { taskIds: [], value };
      group.taskIds.push(row.taskId);
      groups.set(key, group);
    }
    return { groups: [...groups.values()] };
  },
};
