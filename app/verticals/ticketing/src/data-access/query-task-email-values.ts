// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskEmailValuesPayloadSchema,
  queryTaskEmailValuesResponseSchema,
} from '../../shared/email-query.ts';
import type {
  QueryTaskEmailValuesPayload,
  QueryTaskEmailValuesResponse,
} from '../../shared/email-query.ts';

interface EmailQueryRow {
  readonly normalizedValue: string | null;
  readonly taskId: string;
  readonly value: string | null;
}

const compareNormalizedValues = (
  left: EmailQueryRow,
  right: EmailQueryRow,
  direction: 'ascending' | 'descending',
) => {
  if (left.normalizedValue === null) {
    return right.normalizedValue === null ? left.taskId.localeCompare(right.taskId) : 1;
  }
  if (right.normalizedValue === null) {
    return -1;
  }
  const compared = left.normalizedValue.localeCompare(right.normalizedValue, 'en', {
    sensitivity: 'variant',
  });
  if (compared === 0) {
    return left.taskId.localeCompare(right.taskId);
  }
  return direction === 'ascending' ? compared : -compared;
};

export const queryTaskEmailValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskEmailValuesPayload,
  QueryTaskEmailValuesResponse
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
    dataAccessKey: 'ticketing.taskEmailValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskEmailValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: queryTaskEmailValuesPayloadSchema,
    transportResponseSchema: queryTaskEmailValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select
        value.normalized_value as "normalizedValue",
        task.task_id as "taskId",
        value.value
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      inner join ticketing.tasks as task
        on task.collection_id = schema.collection_id
        and task.tenant_id = schema.tenant_id
      left join ticketing.task_email_values as value
        on value.task_id = task.task_id
        and value.property_definition_id = definition.property_definition_id
        and value.tenant_id = task.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'email'
        and definition.tenant_id = ${context.tenantId}
        and schema.collection_id = ${input.collectionId}
      order by task.task_id
    `);
    const rows = rowsFromResult<EmailQueryRow>(result);
    const operand = input.query.toLowerCase();
    let selected = rows;

    switch (input.operation) {
      case 'contains':
      case 'search': {
        selected = rows.filter(
          ({ normalizedValue }) => normalizedValue?.includes(operand) === true,
        );
        break;
      }
      case 'is': {
        selected = rows.filter(({ normalizedValue }) => normalizedValue === operand);
        break;
      }
      case 'is_not': {
        selected = rows.filter(({ normalizedValue }) => normalizedValue !== operand);
        break;
      }
      case 'does_not_contain': {
        selected = rows.filter(
          ({ normalizedValue }) => normalizedValue === null || !normalizedValue.includes(operand),
        );
        break;
      }
      case 'is_empty': {
        selected = rows.filter(({ normalizedValue }) => normalizedValue === null);
        break;
      }
      case 'is_not_empty': {
        selected = rows.filter(({ normalizedValue }) => normalizedValue !== null);
        break;
      }
      case 'sort_ascending': {
        selected = [...rows].toSorted((left, right) =>
          compareNormalizedValues(left, right, 'ascending'),
        );
        break;
      }
      case 'sort_descending': {
        selected = [...rows].toSorted((left, right) =>
          compareNormalizedValues(left, right, 'descending'),
        );
        break;
      }
      case 'group': {
        break;
      }
      default: {
        throw new Error(`Unsupported Email query operation: ${input.operation satisfies never}`);
      }
    }

    if (input.operation !== 'group') {
      return { groups: [], taskIds: selected.map(({ taskId }) => taskId) };
    }

    const grouped = new Map<
      string | null,
      { key: string | null; label: string | null; taskIds: string[] }
    >();
    for (const row of rows) {
      const current = grouped.get(row.normalizedValue) ?? {
        key: row.normalizedValue,
        label: row.value,
        taskIds: [],
      };
      current.taskIds.push(row.taskId);
      grouped.set(row.normalizedValue, current);
    }
    const groups = [...grouped.values()].toSorted((left, right) => {
      if (left.key === null) {
        return right.key === null ? 0 : 1;
      }
      if (right.key === null) {
        return -1;
      }
      return left.key.localeCompare(right.key, 'en', { sensitivity: 'variant' });
    });
    return { groups, taskIds: rows.map(({ taskId }) => taskId) };
  },
};
