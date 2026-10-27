// Server-side projection of the provoz agendas for Přehled provozu and Moje agenda (overview read).
// The pages show deadlines, open incidents, search rows and record counts of these agendas, never the whole
// agenda documents (~270 kB on Siampark), so the overview read computes them here and ships only the result.
// Pure functions over the decoded agenda states the person may read; owned by the ops-agenda lane.
import { Brand, DateTime, Option, Result, Schema } from 'effect';
import { AgendaStateSchema, CalendarEventIdSchema } from './agenda.ts';
import type { CalendarEvent } from './agenda.ts';
import { AgendaIdSchema } from './common.ts';
import type { AgendaId } from './common.ts';

export const SourceIdSchema = Schema.Literals([
  'agreements',
  'occupancy',
  'work',
  'finance',
  'property',
  'ops',
  'parties',
]);
export type SourceId = typeof SourceIdSchema.Type;

export const DeadlineCategorySchema = Schema.Literals([
  'contractEnd',
  'contractNotice',
  'contractStart',
  'leaseStart',
  'leaseEnd',
  'assetService',
  'inspection',
  'meterReading',
  'invoiceDue',
  'task',
  'event',
  'delivery',
  'validity',
  'opsDeadline',
]);
export type DeadlineCategory = typeof DeadlineCategorySchema.Type;

export const DeadlineOwnerPrincipalIdSchema = Schema.String.pipe(Schema.brand('FacilityDeadlineOwnerPrincipalId'));
export const deadlineOwnerPrincipalId = Brand.nominal<typeof DeadlineOwnerPrincipalIdSchema.Type>();

export const DeadlineSchema = Schema.Struct({
  /** Stable identity of this occurrence (changes when the source date changes). */
  key: Schema.String,
  /** `YYYY-MM-DD`. */
  category: DeadlineCategorySchema,
  date: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  source: SourceIdSchema,
  title: Schema.String,
  /** In-app path without the language prefix. */
  href: Schema.String,
  /** Person responsible, when the source knows one. */
  ownerPrincipalId: Schema.optionalKey(DeadlineOwnerPrincipalIdSchema),
  /** Completed / cancelled / paid in the source: shown, never notified, never overdue. */
  amountMinor: Schema.optionalKey(Schema.Finite),
  done: Schema.Boolean,
  location: Schema.optionalKey(Schema.String),
  /** Ops agenda record field that produced the date (generic scanner). */
  field: Schema.optionalKey(Schema.String),
  /** Own calendar event id (editable here). */
  eventId: Schema.optionalKey(CalendarEventIdSchema),
});
export type Deadline = typeof DeadlineSchema.Type;

export const OpsIncidentSchema = Schema.Struct({
  agenda: Schema.String,
  id: Schema.String,
  location: Schema.optionalKey(Schema.String),
  title: Schema.String,
});
export type OpsIncident = typeof OpsIncidentSchema.Type;

/**
 * One searchable provoz record. `terms` = the other short text values of the record (joined); the browser folds
 * `title`, `subtitle`, `id` and `terms` into its match text, so folding stays in one place.
 */
export const OpsSearchRowSchema = Schema.Struct({
  href: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(['event', 'ops']),
  subtitle: Schema.optionalKey(Schema.String),
  terms: Schema.optionalKey(Schema.String),
  title: Schema.String,
});
export type OpsSearchRow = typeof OpsSearchRowSchema.Type;

/** Per readable agenda: revision and number of records of its first collection (the Přehled tile). */
export const OpsAgendaSummarySchema = Schema.Struct({
  agenda: Schema.Literals(['assets', 'meters', 'security', 'documents', 'agenda', 'purchasing']),
  records: Schema.Int,
  revision: Schema.Int,
});
export type OpsAgendaSummary = typeof OpsAgendaSummarySchema.Type;

type OptionalField<Key extends string, Value> = Partial<Record<Key, Value>>;

const withOptional = <Key extends string, Value>(key: Key, value: Value | undefined) => {
  const fields: OptionalField<Key, Value> = {};
  if (value !== undefined) {
    fields[key] = value;
  }
  return fields;
};

const day = (value: string) => value.slice(0, 10);

export const eventDeadlines = (events: readonly CalendarEvent[]): Deadline[] =>
  events.flatMap((event) =>
    event.status === 'CANCELLED'
      ? []
      : [
          {
            category: 'event',
            date: day(event.date),
            detail: event.kind,
            done: event.status === 'DONE',
            eventId: event.id,
            href: `/provoz/agenda?event=${encodeURIComponent(event.id)}`,
            key: `agenda-event:${event.id}:${day(event.date)}`,
            ownerPrincipalId: deadlineOwnerPrincipalId(event.assignee?.principalId ?? event.createdBy.principalId),
            source: 'ops',
            title: event.title,
            ...withOptional('location', event.related?.label),
          },
        ],
  );

// ---- Generic scan of the other provoz agendas (their shapes evolve in parallel lanes) -------------------------

/** Route segment of each provoz agenda. */
export const opsSegments = {
  agenda: 'agenda',
  assets: 'majetek',
  documents: 'dokumenty',
  meters: 'meridla',
  purchasing: 'nakupy',
  security: 'bezpecnost',
};

/** A known agenda uses its route; an unknown source keeps its own route segment. */
export const opsSegmentOf = (agenda: string): string =>
  Option.match(Schema.decodeUnknownOption(AgendaIdSchema)(agenda), {
    onNone: () => agenda,
    onSome: (known) => opsSegments[known],
  });

const recordParameters = new Map([
  ['assets', 'asset'],
  ['devices', 'device'],
  ['documents', 'doc'],
  ['meters', 'meter'],
  ['orders', 'orderId'],
]);

/** Detail links follow the source module's existing public query parameters. */
export const opsRecordHref = (agenda: string, collection: string, id: string): string => {
  const param = recordParameters.get(collection);
  const query = param === undefined ? '' : `?${param}=${encodeURIComponent(id)}`;
  return `/provoz/${opsSegmentOf(agenda)}${query}`;
};

const DEADLINE_FIELD =
  /^(?:next[A-Z]\w*|\w*Due(?:On|Date|At)?|dueDate|dueOn|validUntil|validTo|expiresOn|expiresAt|expiryDate|expirationDate|expectedDate|deadline|reviewDate|plannedDate)$/u;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/u;
const CLOSED_VALUES = new Set([
  'cancelled',
  'canceled',
  'closed',
  'completed',
  'decommissioned',
  'delivered',
  'disposed',
  'done',
  'archived',
  'received',
  'resolved',
  'retired',
  'sold',
  'terminated',
  'expired',
]);
const TITLE_FIELDS = ['name', 'title', 'label', 'serialNumber', 'code', 'documentNumber', 'number', 'summary'] as const;

/** Decoded agenda documents retain their JSON values and their typed audit instants. */
export type OpsProjectionValue =
  | Schema.Json
  | DateTime.Utc
  | undefined
  | readonly OpsProjectionValue[]
  | OpsProjectionRecord;
interface OpsProjectionRecord {
  readonly [field: string]: OpsProjectionValue;
}

const OpsProjectionValueSchema: Schema.Codec<OpsProjectionValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Json,
    Schema.DateTimeUtc,
    Schema.Undefined,
    Schema.Array(OpsProjectionValueSchema),
    Schema.Record(Schema.String, OpsProjectionValueSchema),
  ]),
);
const OpsProjectionRecordSchema = Schema.Record(Schema.String, OpsProjectionValueSchema);
const OpsProjectionArraySchema = Schema.Array(OpsProjectionValueSchema);
const isRecord = Schema.is(OpsProjectionRecordSchema);
const isLabelledRecord = Schema.is(Schema.Struct({ label: Schema.String }));
const isProjectionArray = Schema.is(OpsProjectionArraySchema);
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const isFiniteNumber = Schema.is(Schema.Finite);
const isUtc = Schema.is(Schema.DateTimeUtc);
const stringOf = (value: OpsProjectionValue): string | undefined =>
  Schema.decodeUnknownOption(Schema.String)(value).pipe(Option.getOrUndefined);

const titleOf = (record: OpsProjectionRecord): string | undefined => {
  for (const field of TITLE_FIELDS) {
    const value = stringOf(record[field]);
    if (value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
};

/** A finished state/status value or a present closed/resolved stamp closes a record. */
export const isClosedRecord = (record: OpsProjectionRecord): boolean => {
  for (const field of ['state', 'status', 'lifecycleState']) {
    const value = stringOf(record[field]);
    if (value !== undefined && CLOSED_VALUES.has(value.toLowerCase())) {
      return true;
    }
  }
  const { closedAt, resolvedAt } = record;
  return (closedAt !== null && closedAt !== undefined) || (resolvedAt !== null && resolvedAt !== undefined);
};

const categoryOfField = (field: string, agenda: string): DeadlineCategory => {
  if (/inspection|revision|revize/iu.test(field) || agenda === 'security') {
    return 'inspection';
  }
  if (/reading|odecet/iu.test(field) || agenda === 'meters') {
    return 'meterReading';
  }
  if (/service|maintenance|due/iu.test(field) && agenda === 'assets') {
    return 'assetService';
  }
  if (/expected|delivery/iu.test(field)) {
    return 'delivery';
  }
  if (/valid|expir/iu.test(field)) {
    return 'validity';
  }
  return 'opsDeadline';
};

const locationOf = (record: OpsProjectionRecord): string | undefined => {
  for (const field of ['location', 'related', 'propertyRef', 'place']) {
    const value = record[field];
    if (isLabelledRecord(value)) {
      return value.label;
    }
  }
  return undefined;
};

interface ScanHit {
  readonly agenda: string;
  readonly closed: boolean;
  readonly date: string;
  readonly field: string;
  /** Nested services keep a separate current deadline per parent + service kind/title + field. */
  readonly groupKey: string;
  readonly href: string;
  readonly location?: string;
  readonly parentTitle?: string;
  /** Latest performed service wins, not the most distant promised deadline. */
  readonly rank: string;
  readonly recordId: string;
  readonly title: string;
}

interface ScanParent {
  readonly closed: boolean;
  readonly href: string;
  readonly id: string;
  readonly location?: string;
  readonly title?: string;
}
interface ScanContext {
  readonly agenda: string;
  readonly collection: string;
  readonly depth: number;
  readonly parent?: ScanParent;
}

/** Preserve the former string coercion of nested service-kind grouping keys. */
const kindText = (value: OpsProjectionValue): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (isString(value)) {
    return value;
  }
  if (isBoolean(value) || isFiniteNumber(value)) {
    return String(value);
  }
  if (isProjectionArray(value)) {
    return value.map(kindText).join(',');
  }
  if (isUtc(value)) {
    return `DateTime.Utc(${DateTime.formatIso(value)})`;
  }
  return '[object Object]';
};

const scanRecordIdentity = (entry: OpsProjectionRecord, index: number, context: ScanContext): ScanParent => {
  const { agenda, collection, parent } = context;
  const id = stringOf(entry['id']) ?? `${parent?.id ?? agenda}#${index}`;
  return {
    closed: isClosedRecord(entry) || parent?.closed === true,
    href: parent?.href ?? opsRecordHref(agenda, collection, id),
    id,
    title: titleOf(entry) ?? parent?.title ?? id,
    ...withOptional('location', locationOf(entry) ?? parent?.location),
  };
};

const nestedRecords = (value: OpsProjectionValue): readonly OpsProjectionValue[] | undefined => {
  if (isProjectionArray(value)) {
    return value;
  }
  return isRecord(value) ? [value] : undefined;
};

const deadlineHit = (
  entry: OpsProjectionRecord,
  identity: ScanParent & { readonly title: string },
  field: string,
  value: string,
  context: ScanContext,
): ScanHit => {
  const { agenda, parent } = context;
  return {
    agenda,
    closed: identity.closed,
    date: day(value),
    field,
    groupKey:
      parent === undefined
        ? `${identity.id}:${field}`
        : `nested:${parent.id}:${kindText(entry['kind'])}:${identity.title.toLowerCase()}:${field}`,
    href: identity.href,
    rank: stringOf(entry['performedOn']) ?? day(value),
    recordId: identity.id,
    title: identity.title,
    ...withOptional('location', identity.location),
    ...withOptional('parentTitle', parent?.title),
  };
};

const scanRecords = (records: readonly OpsProjectionValue[], context: ScanContext, hits: ScanHit[]): void => {
  for (const [index, entry] of records.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const identity = scanRecordIdentity(entry, index, context);
    const title = identity.title ?? identity.id;
    for (const [field, value] of Object.entries(entry)) {
      if (isString(value) && DEADLINE_FIELD.test(field) && DATE_VALUE.test(value)) {
        hits.push(deadlineHit(entry, { ...identity, title }, field, value, context));
      } else if (context.depth < 3) {
        const children = nestedRecords(value);
        if (children !== undefined) {
          scanRecords(
            children,
            {
              agenda: context.agenda,
              collection: context.collection,
              depth: context.depth + 1,
              parent: { ...identity, id: `${identity.id}:${field}`, title },
            },
            hits,
          );
        }
      }
    }
  }
};

/**
 * Deadlines of one provoz agenda state, found by field name (`next…Date`, `…Due…`, `validUntil`, `expiresOn`, …).
 * Nested records (e.g. revisions of an asset) contribute only their latest date per parent and field.
 */
export const opsAgendaDeadlines = (agenda: string, state: OpsProjectionValue): Deadline[] => {
  if (agenda === 'agenda' || !isRecord(state)) {
    return [];
  }
  const hits: ScanHit[] = [];
  for (const [collection, value] of Object.entries(state)) {
    if (isProjectionArray(value)) {
      scanRecords(value, { agenda, collection, depth: 1 }, hits);
    }
  }
  const latest = new Map<string, ScanHit>();
  for (const hit of hits) {
    const current = latest.get(hit.groupKey);
    if (current === undefined || hit.rank >= current.rank) {
      latest.set(hit.groupKey, hit);
    }
  }
  return [...latest.values()].map((hit) => ({
    category: categoryOfField(hit.field, hit.agenda),
    date: hit.date,
    detail: hit.parentTitle !== undefined && hit.parentTitle !== hit.title ? hit.parentTitle : hit.agenda,
    done: hit.closed,
    field: hit.field,
    href: hit.href,
    key: `ops:${hit.agenda}:${hit.recordId}:${hit.field}:${hit.date}`,
    source: 'ops',
    title: hit.title,
    ...withOptional('location', hit.location),
  }));
};

/** Open incidents / faults of the provoz agendas (arrays named …incident…, …fault…, …defect…, …issue…). */
export const openOpsIncidents = (agenda: string, state: OpsProjectionValue): OpsIncident[] => {
  if (!isRecord(state)) {
    return [];
  }
  return Object.entries(state).flatMap(([key, value]) =>
    isProjectionArray(value) && /incident|fault|defect|issue|ticket|porucha/iu.test(key)
      ? value.flatMap((entry, index) =>
          isRecord(entry) && !isClosedRecord(entry)
            ? [
                {
                  agenda,
                  id: stringOf(entry['id']) ?? `${agenda}:${key}#${index}`,
                  title: titleOf(entry) ?? stringOf(entry['description']) ?? key,
                  ...withOptional('location', locationOf(entry)),
                },
              ]
            : [],
        )
      : [],
  );
};

const searchRow = (entry: Omit<OpsSearchRow, 'terms'>, extra: readonly (string | null | undefined)[]): OpsSearchRow => {
  const terms = extra.filter(isString).join(' ');
  return { ...entry, ...withOptional('terms', terms === '' ? undefined : terms) };
};

const subtitleOf = (value: string | null | undefined) =>
  value === null || value === undefined || value === '' ? {} : { subtitle: value };

const SKIPPED_SEARCH_COLLECTIONS =
  /history|events|versions|readings|log|comments|threads|messages|preferences|exports|templates|signatures/iu;
const SEARCH_TITLE_FIELDS = [
  'name',
  'title',
  'label',
  'inventoryNumber',
  'serialNumber',
  'code',
  'documentNumber',
  'number',
  'description',
  'summary',
] as const;

const searchLocationOf = (entry: OpsProjectionRecord): string | undefined => {
  if (isRecord(entry['location'])) {
    return stringOf(entry['location']['label']);
  }
  if (isRecord(entry['related'])) {
    return stringOf(entry['related']['label']);
  }
  return undefined;
};

const opsRecordSearchRow = (
  agenda: string,
  collection: string,
  entry: OpsProjectionValue,
): OpsSearchRow | undefined => {
  if (!isRecord(entry)) {
    return undefined;
  }
  const id = stringOf(entry['id']);
  const title = SEARCH_TITLE_FIELDS.map((field) => stringOf(entry[field])).find(
    (value) => value !== undefined && value !== '',
  );
  if (id === undefined || title === undefined) {
    return undefined;
  }
  const extra = Object.values(entry).flatMap((value) => (isString(value) && value.length < 200 ? [value] : []));
  return searchRow(
    {
      href: opsRecordHref(agenda, collection, id),
      id,
      kind: 'ops',
      title,
      ...subtitleOf(searchLocationOf(entry)),
    },
    [agenda, ...extra],
  );
};

/** Search rows of one readable provoz agenda: calendar events, or the records of every top-level collection. */
export const opsSearchRows = (agenda: string, state: OpsProjectionValue): OpsSearchRow[] => {
  if (agenda === 'agenda') {
    return Result.getOrThrow(Schema.decodeUnknownResult(Schema.toType(AgendaStateSchema))(state)).events.map((event) =>
      searchRow(
        {
          href: `/provoz/agenda?event=${event.id}`,
          id: event.id,
          kind: 'event',
          title: event.title,
          ...subtitleOf(event.date),
        },
        [event.note, event.related?.label],
      ),
    );
  }
  const rows: OpsSearchRow[] = [];
  for (const [field, list] of Object.entries(isRecord(state) ? state : {})) {
    if (!isProjectionArray(list) || SKIPPED_SEARCH_COLLECTIONS.test(field)) {
      continue;
    }
    for (const entry of list) {
      const row = opsRecordSearchRow(agenda, field, entry);
      if (row !== undefined) {
        rows.push(row);
      }
    }
  }
  return rows;
};

/** Number of records of the agenda's first collection (Přehled tile). */
export const opsRecordCount = (state: OpsProjectionValue): number => {
  if (!isRecord(state) && !isProjectionArray(state)) {
    return 0;
  }
  const first = Object.values(state).find(isProjectionArray);
  return first?.length ?? 0;
};

/** Order in which the overview walks the readable agendas (the order the browser saw them in the records read). */
export const overviewAgendaOrder: readonly AgendaId[] = [
  'agenda',
  'assets',
  'documents',
  'meters',
  'purchasing',
  'security',
];

/**
 * The provoz part of Přehled / Moje agenda from the agenda states the person may read (already narrowed to what
 * they may see). Incidents are present only when the security agenda is readable (it holds the incidents).
 */
export const opsOverviewOf = (
  visible: ReadonlyMap<AgendaId, { readonly revision: number; readonly state: OpsProjectionValue }>,
  includeSearch: boolean,
) => {
  const agendas = overviewAgendaOrder.flatMap((agenda) => {
    const entry = visible.get(agenda);
    return entry === undefined ? [] : [{ agenda, entry }];
  });
  return {
    agendas: agendas.map(({ agenda, entry }): OpsAgendaSummary => ({
      agenda,
      records: opsRecordCount(entry.state),
      revision: entry.revision,
    })),
    deadlines: agendas.flatMap(({ agenda, entry }) =>
      agenda === 'agenda'
        ? eventDeadlines(
            Result.getOrThrow(Schema.decodeUnknownResult(Schema.toType(AgendaStateSchema))(entry.state)).events,
          )
        : opsAgendaDeadlines(agenda, entry.state),
    ),
    ...withOptional(
      'incidents',
      visible.has('security')
        ? agendas.flatMap(({ agenda, entry }) => openOpsIncidents(agenda, entry.state))
        : undefined,
    ),
    ...withOptional(
      'searchRows',
      includeSearch ? agendas.flatMap(({ agenda, entry }) => opsSearchRows(agenda, entry.state)) : undefined,
    ),
  };
};
