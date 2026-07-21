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

interface TextQueryRow {
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
    const result = await db.execute(sql`
      select
        collection.locale,
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
    const rows = rowsFromResult<TextQueryRow>(result);
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
