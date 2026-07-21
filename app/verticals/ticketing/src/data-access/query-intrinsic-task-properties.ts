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
  readonly datatype: 'created_by' | 'created_time' | 'last_edited_time';
}

interface IntrinsicTaskRow {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly createdByPrincipalId: string;
  readonly createdByStatus: 'active' | 'archived' | 'disabled';
  readonly lastEditedAt: string;
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

const absoluteInstant = (value: string): number => {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value.trim())) {
    throw new TypeError('Absolute Created time filters require a timestamp with an offset.');
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new TypeError('The Created time filter is not a valid absolute timestamp.');
  }
  return instant;
};

const exactSecondRange = (value: string): InstantRange => {
  const instant = absoluteInstant(value);
  const start = Math.floor(instant / 1000) * 1000;
  return { end: start + 1000, start };
};

const validDate = ({ day, month, year }: Pick<LocalTemporal, 'day' | 'month' | 'year'>) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const parseNumericLocalTemporal = (value: string, locale: string): LocalTemporal | undefined => {
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

const normalizedLocaleText = (value: string, locale: string): string =>
  value
    .normalize('NFC')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase(locale);

const normalizedLocaleToken = (value: string, locale: string): string =>
  normalizedLocaleText(value, locale).trim();

const escapedPattern = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const intlTemporalFormatter = (
  locale: string,
  precision: LocalTemporal['precision'],
): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    ...(precision === 'day' ? {} : { timeStyle: precision === 'minute' ? 'short' : 'medium' }),
    timeZone: 'UTC',
  });

const parseDisplayedLocalTemporal = (
  value: string,
  locale: string,
  precision: LocalTemporal['precision'],
): LocalTemporal | undefined => {
  const formatter = intlTemporalFormatter(locale, precision);
  const sample = new Date(Date.UTC(2026, 2, 29, 13, 14, 15));
  const monthByToken = new Map<string, number>();
  for (let month = 0; month < 12; month += 1) {
    const monthToken = formatter
      .formatToParts(new Date(Date.UTC(2026, month, 15, 13, 14, 15)))
      .find(({ type }) => type === 'month')?.value;
    if (monthToken !== undefined) {
      monthByToken.set(normalizedLocaleToken(monthToken, locale), month + 1);
    }
  }
  const dayPeriodByToken = new Map<string, 'am' | 'pm'>();
  for (const [hour, period] of [
    [1, 'am'],
    [13, 'pm'],
  ] as const) {
    const dayPeriod = formatter
      .formatToParts(new Date(Date.UTC(2026, 2, 29, hour, 14, 15)))
      .find(({ type }) => type === 'dayPeriod')?.value;
    if (dayPeriod !== undefined) {
      dayPeriodByToken.set(normalizedLocaleToken(dayPeriod, locale), period);
    }
  }
  const alternatives = (values: Iterable<string>) =>
    [...values]
      .toSorted((left, right) => right.length - left.length)
      .map(escapedPattern)
      .join('|');
  const pattern = formatter
    .formatToParts(sample)
    .map(({ type, value: partValue }) => {
      switch (type) {
        case 'day':
        case 'hour':
        case 'minute':
        case 'second':
        case 'year': {
          return `(?<${type}>\\d{1,6})`;
        }
        case 'month': {
          return `(?<month>${alternatives(monthByToken.keys())})`;
        }
        case 'dayPeriod': {
          return `(?<dayPeriod>${alternatives(dayPeriodByToken.keys())})`;
        }
        case 'literal': {
          return escapedPattern(normalizedLocaleText(partValue, locale));
        }
        default: {
          return escapedPattern(normalizedLocaleToken(partValue, locale));
        }
      }
    })
    .join('');
  const normalized = normalizedLocaleText(value, locale).trim();
  const groups = new RegExp(`^${pattern}$`, 'iu').exec(normalized)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const dayPeriod =
    groups['dayPeriod'] === undefined
      ? undefined
      : dayPeriodByToken.get(normalizedLocaleToken(groups['dayPeriod'], locale));
  let hour = Number(groups['hour'] ?? 0);
  if (dayPeriod === 'am' && hour === 12) {
    hour = 0;
  } else if (dayPeriod === 'pm' && hour < 12) {
    hour += 12;
  }
  const parsed: LocalTemporal = {
    day: Number(groups['day']),
    hour,
    minute: Number(groups['minute'] ?? 0),
    month: monthByToken.get(normalizedLocaleToken(groups['month'] ?? '', locale)) ?? 0,
    precision,
    second: Number(groups['second'] ?? 0),
    year: Number(groups['year']),
  };
  return validDate(parsed) && hour <= 23 && parsed.minute <= 59 && parsed.second <= 59
    ? parsed
    : undefined;
};

const parseLocalTemporal = (value: string, locale: string): LocalTemporal | undefined =>
  parseNumericLocalTemporal(value, locale) ??
  parseDisplayedLocalTemporal(value, locale, 'second') ??
  parseDisplayedLocalTemporal(value, locale, 'minute') ??
  parseDisplayedLocalTemporal(value, locale, 'day');

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
) => {
  if (datatype === 'created_time') {
    return { createdAt: row.createdAt, taskId: row.taskId };
  }
  if (datatype === 'last_edited_time') {
    return { lastEditedAt: row.lastEditedAt, taskId: row.taskId };
  }
  return {
    createdBy: {
      displayName: row.createdByDisplayName,
      inactive: row.createdByStatus !== 'active',
      principalId: row.createdByPrincipalId,
    },
    taskId: row.taskId,
  };
};

const temporalInstant = (
  datatype: Extract<IntrinsicDefinitionRow['datatype'], 'created_time' | 'last_edited_time'>,
  row: IntrinsicTaskRow,
): string => (datatype === 'created_time' ? row.createdAt : row.lastEditedAt);

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
        and definition.datatype in ('created_time', 'created_by', 'last_edited_time')
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
        to_char(
          task.last_edited_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "lastEditedAt",
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
    if (datatype === 'created_time' || datatype === 'last_edited_time') {
      const operationPrefix = datatype === 'created_time' ? 'CreatedTime' : 'LastEditedTime';
      if (!input.operation._tag.startsWith(operationPrefix)) {
        throw new Error('The requested operation does not match the intrinsic datatype.');
      }
      const effectiveTimeZone = await resolveEffectiveTimeZone({
        browserTimeZone: input.browserTimeZone,
        context,
        db,
      });
      switch (input.operation._tag) {
        case 'CreatedTimeSearch':
        case 'LastEditedTimeSearch': {
          const range = await instantRangeFor({
            db,
            locale: viewerLocale,
            timeZone: effectiveTimeZone.timeZone,
            value: input.operation.value,
          });
          selectedRows = selectedRows.filter((row) => {
            const instant = Date.parse(temporalInstant(datatype, row));
            return instant >= range.start && instant < range.end;
          });
          break;
        }
        case 'CreatedTimeFilter':
        case 'LastEditedTimeFilter': {
          const usesLocalBoundary = ['local_day', 'local_range'].includes(input.operation.operator);
          let range: InstantRange;
          if (usesLocalBoundary) {
            range = await instantRangeFor({
              db,
              locale: viewerLocale,
              timeZone: effectiveTimeZone.timeZone,
              value: input.operation.value,
            });
          } else if (input.operation.operator === 'exact') {
            range = exactSecondRange(input.operation.value);
          } else {
            const comparisonInstant = absoluteInstant(input.operation.value);
            range = { end: comparisonInstant, start: comparisonInstant };
          }
          const endRange =
            input.operation.operator === 'local_range'
              ? await instantRangeFor({
                  db,
                  locale: viewerLocale,
                  timeZone: effectiveTimeZone.timeZone,
                  value: input.operation.endValue ?? '',
                })
              : range;
          selectedRows = selectedRows.filter((row) => {
            const instant = Date.parse(temporalInstant(datatype, row));
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
                return instant > range.start;
              }
              case 'on_or_before': {
                return instant <= range.start;
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
        case 'CreatedTimeSort':
        case 'LastEditedTimeSort': {
          const direction = input.operation.direction === 'ascending' ? 1 : -1;
          selectedRows.sort(
            (left, right) =>
              direction *
                (Date.parse(temporalInstant(datatype, left)) -
                  Date.parse(temporalInstant(datatype, right))) ||
              left.taskId.localeCompare(right.taskId),
          );
          break;
        }
        case 'CreatedTimeGroup':
        case 'LastEditedTimeGroup': {
          selectedRows.sort(
            (left, right) =>
              Date.parse(temporalInstant(datatype, left)) -
                Date.parse(temporalInstant(datatype, right)) ||
              left.taskId.localeCompare(right.taskId),
          );
          break;
        }
        default: {
          throw new Error('The requested operation does not match the intrinsic datatype.');
        }
      }
      const groupedRows = new Map<string, IntrinsicTaskRow[]>();
      if (
        input.operation._tag === 'CreatedTimeGroup' ||
        input.operation._tag === 'LastEditedTimeGroup'
      ) {
        for (const row of selectedRows) {
          const key = localCalendarDay(temporalInstant(datatype, row), effectiveTimeZone.timeZone);
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
    if (
      datatype !== 'created_by' ||
      input.operation._tag.startsWith('CreatedTime') ||
      input.operation._tag.startsWith('LastEditedTime')
    ) {
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
