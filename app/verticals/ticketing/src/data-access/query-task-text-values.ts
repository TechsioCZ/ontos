// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskTextValuesPayloadSchema,
  queryTaskTextValuesResponseSchema,
} from '../../shared/text-query.ts';
import type {
  QueryTaskTextValuesPayload,
  QueryTaskTextValuesResponse,
} from '../../shared/text-query.ts';

interface TextQueryRow {
  readonly locale: string;
  readonly readableText: string | null;
  readonly taskId: string;
}

const comparableText = (value: string, locale: string): string =>
  value.normalize('NFC').toLocaleLowerCase(locale);

const matchesTextFilter = (
  readableText: string | null,
  operation: Extract<QueryTaskTextValuesPayload['operation'], { readonly type: 'filter' }>,
  locale: string,
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

  const comparableValue = comparableText(operation.value, locale);
  const comparableReadableText = comparableText(readableText, locale);
  switch (operation.operator) {
    case 'contains': {
      return comparableReadableText.includes(comparableValue);
    }
    case 'doesNotContain': {
      return !comparableReadableText.includes(comparableValue);
    }
    case 'equals': {
      return comparableReadableText === comparableValue;
    }
    case 'doesNotEqual': {
      return comparableReadableText !== comparableValue;
    }
    case 'startsWith': {
      return comparableReadableText.startsWith(comparableValue);
    }
    case 'endsWith': {
      return comparableReadableText.endsWith(comparableValue);
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

export const queryTaskTextValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskTextValuesPayload,
  QueryTaskTextValuesResponse
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
    dataAccessKey: 'ticketing.taskTextValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskTextValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: queryTaskTextValuesPayloadSchema,
    transportResponseSchema: queryTaskTextValuesResponseSchema,
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
        and definition.datatype = 'text'
      inner join ticketing.task_collections as collection
        on collection.collection_id = task.collection_id
        and collection.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.tenant_id = ${context.tenantId}
    `);
    const rows = rowsFromResult<TextQueryRow>(result);
    const locale = rows.at(0)?.locale ?? 'en-GB';
    if (input.operation.type === 'sort') {
      return {
        taskIds: sortTextRows(rows, locale, input.operation.direction).map(({ taskId }) => taskId),
      };
    }
    if (input.operation.type === 'group') {
      return {
        groups: groupTextRows(rows, locale),
        taskIds: rows.map(({ taskId }) => taskId).toSorted(),
      };
    }
    const matches =
      input.operation.type === 'search'
        ? ({ readableText }: TextQueryRow) =>
            readableText !== null &&
            comparableText(readableText, locale).includes(
              comparableText(input.operation.query, locale),
            )
        : ({ readableText }: TextQueryRow) =>
            matchesTextFilter(readableText, input.operation, locale);

    return {
      taskIds: rows
        .filter(matches)
        .map(({ taskId }) => taskId)
        .toSorted(),
    };
  },
};
