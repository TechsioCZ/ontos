// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskNumberValuesPayloadSchema,
  queryTaskNumberValuesResponseSchema,
} from '../../shared/number-query.ts';
import type {
  QueryTaskNumberValuesPayload,
  QueryTaskNumberValuesResponse,
} from '../../shared/number-query.ts';
import { canonicalizeNumberValue } from '../../shared/number-value.ts';

interface NumberQueryRow {
  readonly taskId: string;
  readonly value: string | null;
}

const canonicalDecimalSql = sql`
  case
    when value.value is null then null
    when value.value = 0 then '0'
    else regexp_replace(regexp_replace(value.value::text, '0+$', ''), '\\.$', '')
  end
`;

const numericFilterPredicate = (input: QueryTaskNumberValuesPayload) => {
  if (input.operator === 'is_empty') {
    return sql`value.value is null`;
  }
  if (input.operator === 'is_not_empty') {
    return sql`value.value is not null`;
  }
  const canonicalValue = input.value && canonicalizeNumberValue(input.value);
  if (canonicalValue === undefined) {
    throw new Error('A valid canonical decimal is required for this Number filter.');
  }
  switch (input.operator) {
    case 'equal': {
      return sql`value.value = ${canonicalValue}::numeric`;
    }
    case 'not_equal': {
      return sql`value.value is not null and value.value <> ${canonicalValue}::numeric`;
    }
    case 'greater_than': {
      return sql`value.value > ${canonicalValue}::numeric`;
    }
    case 'less_than': {
      return sql`value.value < ${canonicalValue}::numeric`;
    }
    case 'greater_than_or_equal': {
      return sql`value.value >= ${canonicalValue}::numeric`;
    }
    case 'less_than_or_equal': {
      return sql`value.value <= ${canonicalValue}::numeric`;
    }
    default: {
      throw new Error('A supported Number filter operator is required.');
    }
  }
};

const queryPredicate = (input: QueryTaskNumberValuesPayload) => {
  if (input.kind === 'filter') {
    return numericFilterPredicate(input);
  }
  if (input.kind === 'search') {
    return sql`value.value is not null and position(${input.search ?? ''} in ${canonicalDecimalSql}) > 0`;
  }
  return sql`true`;
};

const queryOrdering = (input: QueryTaskNumberValuesPayload) => {
  if (input.kind === 'sort' && input.direction === 'descending') {
    return sql`value.value desc nulls last, task.created_at, task.task_id`;
  }
  if (input.kind === 'sort' || input.kind === 'group') {
    return sql`value.value asc nulls last, task.created_at, task.task_id`;
  }
  return sql`task.created_at, task.task_id`;
};

export const queryTaskNumberValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskNumberValuesPayload,
  QueryTaskNumberValuesResponse
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
    dataAccessKey: 'ticketing.taskNumberValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskNumberValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: queryTaskNumberValuesPayloadSchema,
    transportResponseSchema: queryTaskNumberValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const predicate = queryPredicate(input);
    const ordering = queryOrdering(input);
    const result = await db.execute(sql`
      select
        task.task_id as "taskId",
        ${canonicalDecimalSql} as value
      from ticketing.tasks as task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = task.collection_id
        and schema.tenant_id = task.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'number'
        and definition.tenant_id = task.tenant_id
      left join ticketing.task_number_values as value
        on value.task_id = task.task_id
        and value.property_definition_id = definition.property_definition_id
        and value.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
        and ${predicate}
      order by ${ordering}
    `);
    const items = rowsFromResult<NumberQueryRow>(result).map((row) => ({
      taskId: row.taskId,
      value: row.value === null ? null : (canonicalizeNumberValue(row.value) ?? row.value),
    }));
    if (input.kind !== 'group') {
      return { groups: [], items };
    }

    const groups = new Map<string | null, string[]>();
    for (const item of items) {
      const taskIds = groups.get(item.value) ?? [];
      taskIds.push(item.taskId);
      groups.set(item.value, taskIds);
    }
    return {
      groups: [...groups].map(([value, taskIds]) => ({ taskIds, value })),
      items: [],
    };
  },
};
