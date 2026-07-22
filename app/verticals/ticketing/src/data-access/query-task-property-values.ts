// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskPropertyValuesPayloadSchema,
  queryTaskPropertyValuesResponseSchema,
} from '../../shared/task-property-query.ts';
import type {
  QueryTaskPropertyValuesPayload,
  QueryTaskPropertyValuesResponse,
  TaskPropertyQuery,
} from '../../shared/task-property-query.ts';
import { canonicalizeNumberValue } from '../../shared/number-value.ts';
import type { TextDocument } from '../../shared/text-property.ts';
import { resolveTextDocumentProjection } from '../core-reference-text-projection.ts';

interface NumberQueryRow {
  readonly taskId: string;
  readonly value: string | null;
}

interface TextQueryRow {
  readonly document: TextDocument | null;
  readonly locale: string;
  readonly readableText: string | null;
  readonly taskId: string;
}

interface TextCollation {
  readonly endsWith: (value: string, search: string) => boolean;
  readonly equals: (left: string, right: string) => boolean;
  readonly includes: (value: string, search: string) => boolean;
  readonly startsWith: (value: string, search: string) => boolean;
}

type NumberQueryOperation = Extract<
  TaskPropertyQuery,
  { readonly datatype: 'number' }
>['operation'];

const canonicalDecimalSql = sql`
  case
    when value.value is null then null
    when value.value = 0 then '0'
    else regexp_replace(regexp_replace(value.value::text, '0+$', ''), '\\.$', '')
  end
`;

const numericFilterPredicate = (
  operation: Extract<NumberQueryOperation, { readonly type: 'filter' }>,
) => {
  if (operation.operator === 'isEmpty') {
    return sql`value.value is null`;
  }
  if (operation.operator === 'isNotEmpty') {
    return sql`value.value is not null`;
  }
  if (!('value' in operation)) {
    throw new Error('A comparison value is required for this Number filter.');
  }
  const canonicalValue = canonicalizeNumberValue(operation.value);
  if (canonicalValue === undefined) {
    throw new Error('A valid canonical decimal is required for this Number filter.');
  }
  switch (operation.operator) {
    case 'equal': {
      return sql`value.value = ${canonicalValue}::numeric`;
    }
    case 'notEqual': {
      return sql`value.value is not null and value.value <> ${canonicalValue}::numeric`;
    }
    case 'greaterThan': {
      return sql`value.value > ${canonicalValue}::numeric`;
    }
    case 'lessThan': {
      return sql`value.value < ${canonicalValue}::numeric`;
    }
    case 'greaterThanOrEqual': {
      return sql`value.value >= ${canonicalValue}::numeric`;
    }
    case 'lessThanOrEqual': {
      return sql`value.value <= ${canonicalValue}::numeric`;
    }
    default: {
      throw new Error('A supported Number filter operator is required.');
    }
  }
};

const numberQueryPredicate = (operation: NumberQueryOperation) => {
  if (operation.type === 'filter') {
    return numericFilterPredicate(operation);
  }
  if (operation.type === 'search') {
    return sql`value.value is not null and position(${operation.query} in ${canonicalDecimalSql}) > 0`;
  }
  return sql`true`;
};

const numberQueryOrdering = (operation: NumberQueryOperation) => {
  if (operation.type === 'sort' && operation.direction === 'descending') {
    return sql`value.value desc nulls last, task.task_id`;
  }
  if (operation.type === 'sort' || operation.type === 'group') {
    return sql`value.value asc nulls last, task.task_id`;
  }
  return sql`task.task_id`;
};

const normalizeText = (value: string) => [...value.normalize('NFC')];

const textCollation = (locale: string): TextCollation => {
  const collator = new Intl.Collator(locale, { sensitivity: 'accent', usage: 'search' });
  const equals = (left: string, right: string) => collator.compare(left, right) === 0;
  const findBoundaryMatch = (value: string, search: string, boundary: 'any' | 'end' | 'start') => {
    const valueCharacters = normalizeText(value);
    const searchCharacters = normalizeText(search);
    if (searchCharacters.length === 0) {
      return true;
    }
    const firstStart = boundary === 'end' ? valueCharacters.length - searchCharacters.length : 0;
    const lastStart = boundary === 'start' ? 0 : valueCharacters.length - searchCharacters.length;
    for (let start = Math.max(0, firstStart); start <= lastStart; start += 1) {
      if (equals(valueCharacters.slice(start, start + searchCharacters.length).join(''), search)) {
        return true;
      }
    }
    return false;
  };
  return {
    endsWith: (value, search) => findBoundaryMatch(value, search, 'end'),
    equals,
    includes: (value, search) => findBoundaryMatch(value, search, 'any'),
    startsWith: (value, search) => findBoundaryMatch(value, search, 'start'),
  };
};

const matchesTextFilter = (
  readableText: string | null,
  operation: Extract<
    Extract<TaskPropertyQuery, { readonly datatype: 'text' }>['operation'],
    { readonly type: 'filter' }
  >,
  collation: TextCollation,
): boolean => {
  if (operation.operator === 'isEmpty') {
    return readableText === null;
  }
  if (operation.operator === 'isNotEmpty') {
    return readableText !== null;
  }
  if (readableText === null) {
    return operation.operator === 'doesNotContain' || operation.operator === 'doesNotEqual';
  }
  if (!('value' in operation)) {
    return false;
  }

  switch (operation.operator) {
    case 'contains': {
      return collation.includes(readableText, operation.value);
    }
    case 'doesNotContain': {
      return !collation.includes(readableText, operation.value);
    }
    case 'equals': {
      return collation.equals(readableText, operation.value);
    }
    case 'doesNotEqual': {
      return !collation.equals(readableText, operation.value);
    }
    case 'startsWith': {
      return collation.startsWith(readableText, operation.value);
    }
    case 'endsWith': {
      return collation.endsWith(readableText, operation.value);
    }
    default: {
      return false;
    }
  }
};

const sortTextRows = (
  rows: readonly TextQueryRow[],
  locale: string,
  direction: 'ascending' | 'descending',
): TextQueryRow[] => {
  const collator = new Intl.Collator(locale, { sensitivity: 'accent', usage: 'sort' });
  return [...rows].toSorted((left, right) => {
    if (left.readableText === null || right.readableText === null) {
      if (left.readableText === right.readableText) {
        return left.taskId.localeCompare(right.taskId);
      }
      return left.readableText === null ? 1 : -1;
    }
    const comparison = collator.compare(left.readableText, right.readableText);
    if (comparison === 0) {
      return left.taskId.localeCompare(right.taskId);
    }
    return direction === 'ascending' ? comparison : -comparison;
  });
};

const groupTextRows = (rows: readonly TextQueryRow[], locale: string) => {
  const equalityCollator = new Intl.Collator(locale, {
    sensitivity: 'accent',
    usage: 'search',
  });
  const groups: { heading: string | null; taskIds: string[] }[] = [];
  for (const row of [...rows].toSorted((left, right) => left.taskId.localeCompare(right.taskId))) {
    const existing = groups.find(({ heading }) =>
      heading === null || row.readableText === null
        ? heading === row.readableText
        : equalityCollator.compare(heading, row.readableText) === 0,
    );
    if (existing === undefined) {
      groups.push({ heading: row.readableText, taskIds: [row.taskId] });
    } else {
      existing.taskIds.push(row.taskId);
    }
  }

  const sortCollator = new Intl.Collator(locale, { sensitivity: 'accent', usage: 'sort' });
  return groups.toSorted((left, right) => {
    if (left.heading === null || right.heading === null) {
      if (left.heading === right.heading) {
        return 0;
      }
      return left.heading === null ? 1 : -1;
    }
    return sortCollator.compare(left.heading, right.heading);
  });
};

export const queryTaskPropertyValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskPropertyValuesPayload,
  QueryTaskPropertyValuesResponse
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPropertyValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPropertyValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: queryTaskPropertyValuesPayloadSchema,
    transportResponseSchema: queryTaskPropertyValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    if (input.query.datatype === 'number') {
      const { operation } = input.query;
      const predicate = numberQueryPredicate(operation);
      const ordering = numberQueryOrdering(operation);
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
      const rows = rowsFromResult<NumberQueryRow>(result).map((row) => ({
        taskId: row.taskId,
        value: row.value === null ? null : (canonicalizeNumberValue(row.value) ?? row.value),
      }));
      if (operation.type !== 'group') {
        return { taskIds: rows.map(({ taskId }) => taskId) };
      }
      const groups = new Map<string | null, string[]>();
      for (const row of rows) {
        const taskIds = groups.get(row.value) ?? [];
        taskIds.push(row.taskId);
        groups.set(row.value, taskIds);
      }
      return {
        groups: [...groups].map(([heading, taskIds]) => ({ heading, taskIds })),
        taskIds: rows.map(({ taskId }) => taskId).toSorted(),
      };
    }

    const result = await db.execute(sql`
      select
        collection.locale,
        value.document,
        value.readable_text as "readableText",
        task.task_id as "taskId"
      from ticketing.task_text_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = ${input.query.datatype}
      inner join ticketing.task_collections as collection
        on collection.collection_id = task.collection_id
        and collection.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.tenant_id = ${context.tenantId}
    `);
    const rows = await Promise.all(
      rowsFromResult<TextQueryRow>(result).map(async (row) => ({
        ...row,
        ...(await resolveTextDocumentProjection({
          context: { principalId: context.principalId, tenantId: context.tenantId },
          document: row.document,
        })),
      })),
    );
    const locale = rows.at(0)?.locale ?? 'en-GB';
    const collation = textCollation(locale);
    const { operation } = input.query;
    if (operation.type === 'sort') {
      return {
        taskIds: sortTextRows(rows, locale, operation.direction).map(({ taskId }) => taskId),
      };
    }
    if (operation.type === 'group') {
      return {
        groups: groupTextRows(rows, locale),
        taskIds: rows.map(({ taskId }) => taskId).toSorted(),
      };
    }
    const matches =
      operation.type === 'search'
        ? ({ readableText }: TextQueryRow) =>
            readableText !== null && collation.includes(readableText, operation.query)
        : ({ readableText }: TextQueryRow) => matchesTextFilter(readableText, operation, collation);

    return {
      taskIds: rows
        .filter(matches)
        .map(({ taskId }) => taskId)
        .toSorted(),
    };
  },
};
