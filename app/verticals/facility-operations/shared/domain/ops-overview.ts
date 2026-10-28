// Server-side projection of the provoz agendas for Přehled provozu and Moje agenda (overview read).
// The pages show deadlines, open incidents, search rows and record counts of these agendas, never the whole
// agenda documents (~270 kB on Nájempark), so the overview read computes them here and ships only the result.
// Pure functions over the decoded agenda states the person may read; owned by the ops-agenda lane.
import { Schema } from 'effect';
import type { DateTime } from 'effect';
import { AgendaStateSchema } from './agenda.ts';
import type { CalendarEvent } from './agenda.ts';
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

const DeadlineOwnerPrincipalIdSchema = Schema.String.pipe(
  Schema.brand('FacilityDeadlineOwnerPrincipalId'),
  Schema.decodeTo(Schema.String),
);
const DeadlineEventIdSchema = Schema.String.pipe(
  Schema.brand('FacilityDeadlineEventId'),
  Schema.decodeTo(Schema.String),
);

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
  eventId: Schema.optionalKey(DeadlineEventIdSchema),
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

const day = (value: string) => value.slice(0, 10);

export const eventDeadlines = (events: readonly CalendarEvent[]): Deadline[] =>
  events.flatMap((event): Deadline[] => {
    if (event.status === 'CANCELLED') {
      return [];
    }
    const deadline: { -readonly [K in keyof Deadline]: Deadline[K] } = {
      category: 'event',
      date: day(event.date),
      detail: event.kind,
      done: event.status === 'DONE',
      eventId: event.id,
      href: `/provoz/agenda?event=${encodeURIComponent(event.id)}`,
      key: `agenda-event:${event.id}:${day(event.date)}`,
      ownerPrincipalId: event.assignee?.principalId ?? event.createdBy.principalId,
      source: 'ops',
      title: event.title,
    };
    if (event.related !== undefined) {
      deadline.location = event.related.label;
    }
    return [deadline];
  });

// ---- Generic scan of the other provoz agendas (their shapes evolve in parallel lanes) -------------------------

/** Route segment of each provoz agenda. */
export const opsSegments = Object.fromEntries<string>([
  ['agenda', 'agenda'],
  ['assets', 'majetek'],
  ['documents', 'dokumenty'],
  ['meters', 'meridla'],
  ['purchasing', 'nakupy'],
  ['security', 'bezpecnost'],
]);

const detailParameter = new Map([
  ['assets', 'asset'],
  ['devices', 'device'],
  ['documents', 'doc'],
  ['meters', 'meter'],
  ['orders', 'orderId'],
]);

/** Detail links follow the source module's existing public query parameters. */
export const opsRecordHref = (agenda: string, collection: string, id: string): string => {
  const param = detailParameter.get(collection);
  const path = `/provoz/${opsSegments[agenda] ?? agenda}`;
  return param === undefined ? path : `${path}?${param}=${encodeURIComponent(id)}`;
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

/** Decoded agenda documents contain native instants as well as JSON values. */
export type OverviewValue = Schema.Json | DateTime.Utc | readonly OverviewValue[] | OverviewRecord;
export interface OverviewRecord {
  readonly [field: string]: OverviewValue;
}
export const OverviewValueSchema: Schema.Codec<OverviewValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.DateTimeUtc,
    Schema.Array(OverviewValueSchema),
    Schema.Record(Schema.String, OverviewValueSchema),
  ]),
);
const isRecord = Schema.is(Schema.Record(Schema.String, OverviewValueSchema));
const isArray = Schema.is(Schema.Array(OverviewValueSchema));
const isString: (value: OverviewValue | undefined) => value is string = Schema.is(Schema.String);

const titleOf = (record: OverviewRecord): string | undefined => {
  for (const field of TITLE_FIELDS) {
    const value = record[field];
    if (isString(value) && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
};

/** `true` when a loose record says it is finished (state/status value, or closedAt/resolvedAt set). */
export const isClosedRecord = (record: OverviewRecord): boolean => {
  for (const field of ['state', 'status', 'lifecycleState']) {
    const value = record[field];
    if (isString(value) && CLOSED_VALUES.has(value.toLowerCase())) {
      return true;
    }
  }
  const { closedAt, resolvedAt } = record;
  return (closedAt !== undefined && closedAt !== null) || (resolvedAt !== undefined && resolvedAt !== null);
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

const locationOf = (record: OverviewRecord): string | undefined => {
  for (const field of ['location', 'related', 'propertyRef', 'place']) {
    const value = record[field];
    if (isRecord(value) && isString(value['label'])) {
      return value['label'];
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
  readonly closed: boolean;
  readonly href: string;
  readonly location: string | undefined;
  readonly recordId: string;
  readonly title: string;
}

const scanContext = (
  agenda: string,
  collection: string,
  entry: OverviewRecord,
  index: number,
  parent: ScanParent | undefined,
): ScanContext => {
  const recordId = isString(entry['id']) ? entry['id'] : `${parent?.id ?? agenda}#${index}`;
  return {
    closed: isClosedRecord(entry) || parent?.closed === true,
    href: parent?.href ?? opsRecordHref(agenda, collection, recordId),
    location: locationOf(entry) ?? parent?.location,
    recordId,
    title: titleOf(entry) ?? parent?.title ?? recordId,
  };
};

const scanHit = (
  agenda: string,
  entry: OverviewRecord,
  field: string,
  value: string,
  context: ScanContext,
  parent: ScanParent | undefined,
): ScanHit => {
  const { closed, href, location, recordId, title } = context;
  const kind = isString(entry['kind']) ? entry['kind'] : '';
  const hit: { -readonly [K in keyof ScanHit]: ScanHit[K] } = {
    agenda,
    closed,
    date: day(value),
    field,
    groupKey:
      parent === undefined ? `${recordId}:${field}` : `nested:${parent.id}:${kind}:${title.toLowerCase()}:${field}`,
    href,
    rank: isString(entry['performedOn']) ? entry['performedOn'] : day(value),
    recordId,
    title,
  };
  if (location !== undefined) {
    hit.location = location;
  }
  if (parent?.title !== undefined) {
    hit.parentTitle = parent.title;
  }
  return hit;
};

const scanRecords = (
  agenda: string,
  records: readonly OverviewValue[],
  depth: number,
  parent: ScanParent | undefined,
  hits: ScanHit[],
  collection: string,
) => {
  for (const [index, entry] of records.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const context = scanContext(agenda, collection, entry, index, parent);
    for (const [field, value] of Object.entries(entry)) {
      if (isString(value) && DEADLINE_FIELD.test(field) && DATE_VALUE.test(value)) {
        hits.push(scanHit(agenda, entry, field, value, context, parent));
      } else if (depth < 3 && (isArray(value) || isRecord(value))) {
        // Contract terms and inventory follow-ups are nested objects, not arrays.
        const nextParent: { -readonly [K in keyof ScanParent]: ScanParent[K] } = {
          closed: context.closed,
          href: context.href,
          id: `${context.recordId}:${field}`,
          title: context.title,
        };
        if (context.location !== undefined) {
          nextParent.location = context.location;
        }
        scanRecords(agenda, isArray(value) ? value : [value], depth + 1, nextParent, hits, collection);
      }
    }
  }
};

/**
 * Deadlines of one provoz agenda state, found by field name (`next…Date`, `…Due…`, `validUntil`, `expiresOn`, …).
 * Nested records (e.g. revisions of an asset) contribute only their latest date per parent and field.
 */
export const opsAgendaDeadlines = (agenda: string, state: OverviewValue): Deadline[] => {
  if (agenda === 'agenda' || !isRecord(state)) {
    return [];
  }
  const hits: ScanHit[] = [];
  for (const [collection, value] of Object.entries(state)) {
    if (isArray(value)) {
      scanRecords(agenda, value, 1, undefined, hits, collection);
    }
  }
  const latest = new Map<string, ScanHit>();
  for (const hit of hits) {
    const current = latest.get(hit.groupKey);
    if (current === undefined || hit.rank >= current.rank) {
      latest.set(hit.groupKey, hit);
    }
  }
  return [...latest.values()].map((hit): Deadline => {
    const deadline: { -readonly [K in keyof Deadline]: Deadline[K] } = {
      category: categoryOfField(hit.field, hit.agenda),
      date: hit.date,
      detail: hit.parentTitle !== undefined && hit.parentTitle !== hit.title ? hit.parentTitle : hit.agenda,
      done: hit.closed,
      field: hit.field,
      href: hit.href,
      key: `ops:${hit.agenda}:${hit.recordId}:${hit.field}:${hit.date}`,
      source: 'ops',
      title: hit.title,
    };
    if (hit.location !== undefined) {
      deadline.location = hit.location;
    }
    return deadline;
  });
};

/** Open incidents / faults of the provoz agendas (arrays named …incident…, …fault…, …defect…, …issue…). */
export const openOpsIncidents = (agenda: string, state: OverviewValue): OpsIncident[] => {
  if (!isRecord(state)) {
    return [];
  }
  return Object.entries(state).flatMap(([key, value]) => {
    if (!isArray(value) || !/incident|fault|defect|issue|ticket|porucha/iu.test(key)) {
      return [];
    }
    return value.flatMap((entry, index): OpsIncident[] => {
      if (!isRecord(entry) || isClosedRecord(entry)) {
        return [];
      }
      const incident: { -readonly [K in keyof OpsIncident]: OpsIncident[K] } = {
        agenda,
        id: isString(entry['id']) ? entry['id'] : `${agenda}:${key}#${index}`,
        title: titleOf(entry) ?? (isString(entry['description']) ? entry['description'] : key),
      };
      const location = locationOf(entry);
      if (location !== undefined) {
        incident.location = location;
      }
      return [incident];
    });
  });
};

const searchRow = (entry: Omit<OpsSearchRow, 'terms'>, extra: readonly (string | null | undefined)[]): OpsSearchRow => {
  const terms = extra.filter(isString).join(' ');
  return terms === '' ? entry : { ...entry, terms };
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

const recordSearchRow = (agenda: string, field: string, entry: OverviewValue): OpsSearchRow[] => {
  if (!isRecord(entry) || !isString(entry['id'])) {
    return [];
  }
  let title: string | undefined;
  for (const key of SEARCH_TITLE_FIELDS) {
    const value = entry[key];
    if (isString(value) && value !== '') {
      title = value;
      break;
    }
  }
  if (title === undefined) {
    return [];
  }
  const extra: string[] = [];
  for (const value of Object.values(entry)) {
    if (isString(value) && value.length < 200) {
      extra.push(value);
    }
  }
  let location: OverviewRecord | undefined;
  if (isRecord(entry['location'])) {
    ({ location } = entry);
  } else if (isRecord(entry['related'])) {
    location = entry['related'];
  }
  return [
    searchRow(
      {
        href: opsRecordHref(agenda, field, entry['id']),
        id: entry['id'],
        kind: 'ops',
        title,
        ...subtitleOf(isString(location?.['label']) ? location['label'] : undefined),
      },
      [agenda, ...extra],
    ),
  ];
};

/** Search rows of one readable provoz agenda: calendar events, or the records of every top-level collection. */
export const opsSearchRows = (agenda: string, state: OverviewValue): OpsSearchRow[] => {
  if (agenda === 'agenda') {
    if (!Schema.is(AgendaStateSchema)(state)) {
      return [];
    }
    return state.events.map((event) =>
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
  if (!isRecord(state)) {
    return [];
  }
  const rows: OpsSearchRow[] = [];
  for (const [field, list] of Object.entries(state)) {
    if (isArray(list) && !SKIPPED_SEARCH_COLLECTIONS.test(field)) {
      for (const entry of list) {
        rows.push(...recordSearchRow(agenda, field, entry));
      }
    }
  }
  return rows;
};

/** Number of records of the agenda's first collection (Přehled tile). */
export const opsRecordCount = (state: OverviewValue): number => {
  if (!isRecord(state)) {
    return 0;
  }
  const first = Object.values(state).find(isArray);
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

interface OpsOverview {
  agendas: OpsAgendaSummary[];
  deadlines: Deadline[];
  incidents?: OpsIncident[];
  searchRows?: OpsSearchRow[];
}

/**
 * The provoz part of Přehled / Moje agenda from the agenda states the person may read (already narrowed to what
 * they may see). Incidents are present only when the security agenda is readable (it holds the incidents).
 */
export const opsOverviewOf = (
  visible: ReadonlyMap<AgendaId, { readonly revision: number; readonly state: OverviewValue }>,
  includeSearch: boolean,
) => {
  const agendas = overviewAgendaOrder.flatMap((agenda) => {
    const entry = visible.get(agenda);
    return entry === undefined ? [] : [{ agenda, entry }];
  });
  const overview: OpsOverview = {
    agendas: agendas.map(({ agenda, entry }): OpsAgendaSummary => ({
      agenda,
      records: opsRecordCount(entry.state),
      revision: entry.revision,
    })),
    deadlines: agendas.flatMap(({ agenda, entry }) => {
      if (agenda !== 'agenda') {
        return opsAgendaDeadlines(agenda, entry.state);
      }
      return Schema.is(AgendaStateSchema)(entry.state) ? eventDeadlines(entry.state.events) : [];
    }),
  };
  if (visible.has('security')) {
    overview.incidents = agendas.flatMap(({ agenda, entry }) => openOpsIncidents(agenda, entry.state));
  }
  if (includeSearch) {
    overview.searchRows = agendas.flatMap(({ agenda, entry }) => opsSearchRows(agenda, entry.state));
  }
  return overview;
};
