// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskUrlValuesPayloadSchema,
  queryTaskUrlValuesResponseSchema,
} from '../../shared/url-query.ts';
import type {
  QueryTaskUrlValuesPayload,
  QueryTaskUrlValuesResponse,
} from '../../shared/url-query.ts';

interface LocaleRow {
  readonly locale: string;
}

interface UrlValueRow {
  readonly taskId: string;
  readonly value: string | null;
}

interface MutableUrlValueGroup {
  heading: string | null;
  taskIds: string[];
}

const stableTaskOrder = (left: UrlValueRow, right: UrlValueRow): number =>
  left.taskId.localeCompare(right.taskId);

const containsByCollation = (value: string, query: string, collator: Intl.Collator): boolean => {
  const source = [...value.normalize('NFC')];
  const expected = [...query.normalize('NFC')];
  if (expected.length === 0) {
    return true;
  }
  for (let start = 0; start <= source.length - expected.length; start += 1) {
    if (collator.compare(source.slice(start, start + expected.length).join(''), query) === 0) {
      return true;
    }
  }
  return false;
};

const filterRows = (
  rows: readonly UrlValueRow[],
  operation: Extract<QueryTaskUrlValuesPayload['operation'], { readonly kind: 'filter' }>,
  collator: Intl.Collator,
): readonly UrlValueRow[] => {
  switch (operation.operator) {
    case 'contains': {
      return rows.filter(
        ({ value }) => value !== null && containsByCollation(value, operation.query, collator),
      );
    }
    case 'does_not_contain': {
      return rows.filter(
        ({ value }) => value === null || !containsByCollation(value, operation.query, collator),
      );
    }
    case 'is_empty': {
      return rows.filter(({ value }) => value === null);
    }
    case 'is_not_empty': {
      return rows.filter(({ value }) => value !== null);
    }
    default: {
      throw new Error('Unsupported URL filter operation.');
    }
  }
};

const sortRows = (
  rows: readonly UrlValueRow[],
  direction: 'ascending' | 'descending',
  collator: Intl.Collator,
): readonly UrlValueRow[] =>
  rows.toSorted((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value === right.value) {
        return stableTaskOrder(left, right);
      }
      return left.value === null ? 1 : -1;
    }
    const compared = collator.compare(left.value.normalize('NFC'), right.value.normalize('NFC'));
    if (compared === 0) {
      return stableTaskOrder(left, right);
    }
    return direction === 'ascending' ? compared : -compared;
  });

const groupRows = (
  rows: readonly UrlValueRow[],
  collator: Intl.Collator,
): readonly MutableUrlValueGroup[] => {
  const groups: MutableUrlValueGroup[] = [];
  for (const row of rows.toSorted(stableTaskOrder)) {
    const existing = groups.find(({ heading }) =>
      heading === null || row.value === null
        ? heading === row.value
        : collator.compare(heading.normalize('NFC'), row.value.normalize('NFC')) === 0,
    );
    if (existing === undefined) {
      groups.push({ heading: row.value, taskIds: [row.taskId] });
    } else {
      existing.taskIds.push(row.taskId);
    }
  }
  return groups.toSorted((left, right) => {
    if (left.heading === null || right.heading === null) {
      if (left.heading === right.heading) {
        return 0;
      }
      return left.heading === null ? 1 : -1;
    }
    return collator.compare(left.heading.normalize('NFC'), right.heading.normalize('NFC'));
  });
};

export const queryTaskUrlValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskUrlValuesPayload,
  QueryTaskUrlValuesResponse
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
    dataAccessKey: 'ticketing.taskUrlValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskUrlValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: queryTaskUrlValuesPayloadSchema,
    transportResponseSchema: queryTaskUrlValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const localeResult = await db.execute(sql`
      select tenant.default_locale as locale
      from ticketing.task_collections as collection
      inner join core.tenants as tenant
        on tenant.tenant_id = collection.tenant_id
      where collection.collection_id = ${input.collectionId}
        and collection.tenant_id = ${context.tenantId}
    `);
    const locale = rowsFromResult<LocaleRow>(localeResult).at(0)?.locale ?? 'en-GB';
    const result = await db.execute(sql`
      select
        task.task_id as "taskId",
        value.value
      from ticketing.task_url_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'url'
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where value.property_definition_id = ${input.propertyDefinitionId}
        and value.tenant_id = ${context.tenantId}
        and task.collection_id = ${input.collectionId}
        and schema.collection_id = ${input.collectionId}
    `);
    const rows = rowsFromResult<UrlValueRow>(result);
    const collator = new Intl.Collator(locale, {
      sensitivity: 'accent',
      usage: 'sort',
    });
    const searchCollator = new Intl.Collator(locale, {
      sensitivity: 'accent',
      usage: 'search',
    });

    switch (input.operation.kind) {
      case 'search': {
        return {
          groups: [],
          taskIds: rows
            .filter(
              ({ value }) =>
                value !== null && containsByCollation(value, input.operation.query, searchCollator),
            )
            .toSorted(stableTaskOrder)
            .map(({ taskId }) => taskId),
        };
      }
      case 'filter': {
        return {
          groups: [],
          taskIds: filterRows(rows, input.operation, searchCollator)
            .toSorted(stableTaskOrder)
            .map(({ taskId }) => taskId),
        };
      }
      case 'sort': {
        return {
          groups: [],
          taskIds: sortRows(rows, input.operation.direction, collator).map(({ taskId }) => taskId),
        };
      }
      case 'group': {
        return {
          groups: groupRows(rows, collator),
          taskIds: [],
        };
      }
      default: {
        throw new Error('Unsupported URL query operation.');
      }
    }
  },
};
