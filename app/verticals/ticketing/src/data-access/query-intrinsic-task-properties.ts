// @effect-diagnostics asyncFunction:off globalDate:off
// oxlint-disable eslint/complexity
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import { resolveEffectiveTimeZone } from '@app/core-runtime/principal-time-zone-preferences';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';
import {
  queryIntrinsicTaskPropertiesPayloadSchema,
  queryIntrinsicTaskPropertiesResponseSchema,
} from '../../shared/intrinsic-task-property-query.ts';
import type {
  QueryIntrinsicTaskPropertiesPayload,
  QueryIntrinsicTaskPropertiesResponse,
} from '../../shared/intrinsic-task-property-query.ts';

interface IntrinsicDefinitionRow {
  readonly collectionLocale: string;
  readonly datatype: 'created_by' | 'created_time';
}

interface IntrinsicTaskRow {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly createdByPrincipalId: string;
  readonly createdByStatus: 'active' | 'archived' | 'disabled';
  readonly taskId: string;
}

const searchableText = (value: string, locale: string): string =>
  value.normalize('NFC').toLocaleLowerCase(locale);

interface LocalTemporal {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly precision: 'day' | 'minute' | 'second';
  readonly second: number;
  readonly year: number;
}

interface InstantRange {
  readonly end: number;
  readonly start: number;
}

interface InstantRangeRow {
  readonly end: string;
  readonly start: string;
}

const absoluteInstantRange = (value: string): InstantRange => {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value.trim())) {
    throw new TypeError('Exact Created time filters require an absolute timestamp with an offset.');
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new TypeError('The Created time filter is not a valid absolute timestamp.');
  }
  const start = Math.floor(instant / 1000) * 1000;
  return { end: start + 1000, start };
};

const validDate = ({ day, month, year }: Pick<LocalTemporal, 'day' | 'month' | 'year'>) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const parseLocalTemporal = (value: string, locale: string): LocalTemporal | undefined => {
  const normalized = value.trim();
  const match = normalized.match(
    /^(?:(?<isoYear>\d{4})-(?<isoMonth>\d{1,2})-(?<isoDay>\d{1,2})|(?<localDay>\d{1,2})[./](?<localMonth>\d{1,2})[./](?<localYear>\d{4}))(?:[ T](?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/u,
  );
  if (match?.groups === undefined) {
    return undefined;
  }
  const { groups } = match;
  const year = Number(groups['isoYear'] ?? groups['localYear']);
  const localMonthFirst = locale === 'en-US';
  const month = Number(
    groups['isoMonth'] ?? (localMonthFirst ? groups['localDay'] : groups['localMonth']),
  );
  const day = Number(
    groups['isoDay'] ?? (localMonthFirst ? groups['localMonth'] : groups['localDay']),
  );
  const hour = Number(groups['hour'] ?? 0);
  const minute = Number(groups['minute'] ?? 0);
  const seconds = Number(groups['second'] ?? 0);
  let precision: LocalTemporal['precision'] = 'day';
  if (groups['hour'] !== undefined) {
    precision = groups['second'] === undefined ? 'minute' : 'second';
  }
  const parsed: LocalTemporal = {
    day,
    hour,
    minute,
    month,
    precision,
    second: seconds,
    year,
  };
  return validDate(parsed) && hour <= 23 && minute <= 59 && seconds <= 59 ? parsed : undefined;
};

const nextLocalTemporal = (value: LocalTemporal): LocalTemporal => {
  let addedMilliseconds = 1000;
  if (value.precision === 'day') {
    addedMilliseconds = 86_400_000;
  } else if (value.precision === 'minute') {
    addedMilliseconds = 60_000;
  }
  const next = new Date(
    Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) +
      addedMilliseconds,
  );
  return {
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
    month: next.getUTCMonth() + 1,
    precision: value.precision,
    second: next.getUTCSeconds(),
    year: next.getUTCFullYear(),
  };
};

const instantRangeFor = async ({
  db,
  locale,
  timeZone,
  value,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly locale: string;
  readonly timeZone: string;
  readonly value: string;
}): Promise<InstantRange> => {
  const start = parseLocalTemporal(value, locale);
  if (start === undefined) {
    throw new Error('The Created time query is not a valid viewer-local date or time.');
  }
  const end = nextLocalTemporal(start);
  const result = await db.execute(sql`
    select
      to_char(
        make_timestamptz(
          ${start.year}, ${start.month}, ${start.day},
          ${start.hour}, ${start.minute}, ${start.second}, ${timeZone}
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "start",
      to_char(
        make_timestamptz(
          ${end.year}, ${end.month}, ${end.day},
          ${end.hour}, ${end.minute}, ${end.second}, ${timeZone}
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "end"
  `);
  const range = rowsFromResult<InstantRangeRow>(result).at(0);
  if (range === undefined) {
    throw new Error('The Created time query range could not be resolved.');
  }
  return { end: Date.parse(range.end), start: Date.parse(range.start) };
};

const localCalendarDay = (instant: string, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const projectIntrinsicTask = (
  datatype: IntrinsicDefinitionRow['datatype'],
  row: IntrinsicTaskRow,
) =>
  datatype === 'created_time'
    ? { createdAt: row.createdAt, taskId: row.taskId }
    : {
        createdBy: {
          displayName: row.createdByDisplayName,
          inactive: row.createdByStatus !== 'active',
          principalId: row.createdByPrincipalId,
        },
        taskId: row.taskId,
      };

export const queryIntrinsicTaskPropertiesDataAccessRegistration: DataAccessRegistration<
  QueryIntrinsicTaskPropertiesPayload,
  QueryIntrinsicTaskPropertiesResponse
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
    dataAccessKey: 'ticketing.intrinsicTaskProperties.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.intrinsicTaskProperties.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: queryIntrinsicTaskPropertiesPayloadSchema,
    transportResponseSchema: queryIntrinsicTaskPropertiesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const definitionResult = await db.execute(sql`
      select
        collection.locale as "collectionLocale",
        definition.datatype
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      inner join ticketing.task_collections as collection
        on collection.collection_id = schema.collection_id
        and collection.tenant_id = schema.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.tenant_id = ${context.tenantId}
        and schema.collection_id = ${input.collectionId}
        and definition.hidden = false
        and definition.datatype in ('created_time', 'created_by')
    `);
    const definition = rowsFromResult<IntrinsicDefinitionRow>(definitionResult).at(0);
    if (definition === undefined) {
      throw new Error('The intrinsic Task Property Definition was not found or is hidden.');
    }
    const result = await db.execute(sql`
      select
        to_char(
          task.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "createdAt",
        creator.display_name as "createdByDisplayName",
        task.created_by_principal_id as "createdByPrincipalId",
        creator.status as "createdByStatus",
        task.task_id as "taskId"
      from ticketing.tasks as task
      inner join core.principals as creator
        on creator.principal_id = task.created_by_principal_id
        and creator.tenant_id = task.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id
    `);
    const rows = rowsFromResult<IntrinsicTaskRow>(result);
    const { collectionLocale, datatype } = definition;
    const viewerLocale = new Intl.Locale(input.viewerLocale).toString();
    const collator = new Intl.Collator(collectionLocale, {
      sensitivity: 'accent',
      usage: 'sort',
    });
    let selectedRows = [...rows];
    if (datatype === 'created_time') {
      if (!input.operation._tag.startsWith('CreatedTime')) {
        throw new Error('The requested operation does not match the intrinsic datatype.');
      }
      const effectiveTimeZone = await resolveEffectiveTimeZone({
        browserTimeZone: input.browserTimeZone,
        context,
        db,
      });
      switch (input.operation._tag) {
        case 'CreatedTimeSearch': {
          const range = await instantRangeFor({
            db,
            locale: viewerLocale,
            timeZone: effectiveTimeZone.timeZone,
            value: input.operation.value,
          });
          selectedRows = selectedRows.filter(({ createdAt }) => {
            const instant = Date.parse(createdAt);
            return instant >= range.start && instant < range.end;
          });
          break;
        }
        case 'CreatedTimeFilter': {
          const usesLocalBoundary = ['local_day', 'local_range'].includes(input.operation.operator);
          const range = usesLocalBoundary
            ? await instantRangeFor({
                db,
                locale: viewerLocale,
                timeZone: effectiveTimeZone.timeZone,
                value: input.operation.value,
              })
            : absoluteInstantRange(input.operation.value);
          const endRange =
            input.operation.operator === 'local_range'
              ? await instantRangeFor({
                  db,
                  locale: viewerLocale,
                  timeZone: effectiveTimeZone.timeZone,
                  value: input.operation.endValue ?? '',
                })
              : range;
          selectedRows = selectedRows.filter(({ createdAt }) => {
            const instant = Date.parse(createdAt);
            switch (input.operation.operator) {
              case 'exact':
              case 'local_day':
              case 'local_range': {
                return instant >= range.start && instant < endRange.end;
              }
              case 'before': {
                return instant < range.start;
              }
              case 'after': {
                return instant >= range.end;
              }
              case 'on_or_before': {
                return instant < range.end;
              }
              case 'on_or_after': {
                return instant >= range.start;
              }
              default: {
                return false;
              }
            }
          });
          break;
        }
        case 'CreatedTimeSort': {
          const direction = input.operation.direction === 'ascending' ? 1 : -1;
          selectedRows.sort(
            (left, right) =>
              direction * (Date.parse(left.createdAt) - Date.parse(right.createdAt)) ||
              left.taskId.localeCompare(right.taskId),
          );
          break;
        }
        case 'CreatedTimeGroup': {
          break;
        }
        default: {
          throw new Error('The requested operation does not match the intrinsic datatype.');
        }
      }
      const groupedRows = new Map<string, IntrinsicTaskRow[]>();
      if (input.operation._tag === 'CreatedTimeGroup') {
        for (const row of selectedRows) {
          const key = localCalendarDay(row.createdAt, effectiveTimeZone.timeZone);
          groupedRows.set(key, [...(groupedRows.get(key) ?? []), row]);
        }
      }
      return {
        effectiveTimeZone,
        groups: [...groupedRows].map(([key, groupRows]) => ({
          key,
          label: key,
          taskIds: groupRows.map(({ taskId }) => taskId),
        })),
        tasks: selectedRows.map((row) => projectIntrinsicTask(datatype, row)),
      };
    }
    if (datatype !== 'created_by' || input.operation._tag.startsWith('CreatedTime')) {
      throw new Error('The requested operation does not match the intrinsic datatype.');
    }
    switch (input.operation._tag) {
      case 'CreatedBySearch': {
        const query = searchableText(input.operation.value, collectionLocale);
        selectedRows = selectedRows.filter((row) =>
          searchableText(row.createdByDisplayName, collectionLocale).includes(query),
        );
        break;
      }
      case 'CreatedByFilter': {
        selectedRows = selectedRows.filter(
          (row) => row.createdByPrincipalId === input.operation.principalId,
        );
        break;
      }
      case 'CreatedBySort': {
        const direction = input.operation.direction === 'ascending' ? 1 : -1;
        selectedRows.sort((left, right) => {
          const nameOrder = collator.compare(left.createdByDisplayName, right.createdByDisplayName);
          return (
            direction * nameOrder ||
            left.createdByPrincipalId.localeCompare(right.createdByPrincipalId) ||
            left.taskId.localeCompare(right.taskId)
          );
        });
        break;
      }
      case 'CreatedByGroup': {
        selectedRows.sort(
          (left, right) =>
            collator.compare(left.createdByDisplayName, right.createdByDisplayName) ||
            left.createdByPrincipalId.localeCompare(right.createdByPrincipalId) ||
            left.taskId.localeCompare(right.taskId),
        );
        break;
      }
      default: {
        throw new Error('The requested operation does not match the intrinsic datatype.');
      }
    }
    const groups =
      input.operation._tag === 'CreatedByGroup'
        ? [...Map.groupBy(selectedRows, (row) => row.createdByPrincipalId).entries()].map(
            ([principalId, groupRows]) => ({
              key: principalId,
              label: groupRows[0]?.createdByDisplayName ?? principalId,
              taskIds: groupRows.map(({ taskId }) => taskId),
            }),
          )
        : [];
    return {
      groups,
      tasks: selectedRows.map((row) => projectIntrinsicTask(datatype, row)),
    };
  },
};
