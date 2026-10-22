// Server-side projection of the provoz agendas for Přehled provozu and Moje agenda (overview read).
// The pages show deadlines, open incidents, search rows and record counts of these agendas, never the whole
// agenda documents (~270 kB on Siampark), so the overview read computes them here and ships only the result.
// Pure functions over the decoded agenda states the person may read; owned by the ops-agenda lane.
import { Schema } from 'effect';
import type { AgendaState, CalendarEvent } from './agenda.ts';
import type { AgendaId } from './common.ts';

export const SourceIdSchema = Schema.Literals(['agreements', 'occupancy', 'work', 'finance', 'property', 'ops', 'parties']);
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

export const DeadlineSchema = Schema.Struct({
  /** Stable identity of this occurrence (changes when the source date changes). */
  key: Schema.String,
  /** `YYYY-MM-DD`. */
  date: Schema.String,
  category: DeadlineCategorySchema,
  source: SourceIdSchema,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  /** In-app path without the language prefix. */
  href: Schema.String,
  /** Person responsible, when the source knows one. */
  ownerPrincipalId: Schema.optionalKey(Schema.String),
  /** Completed / cancelled / paid in the source: shown, never notified, never overdue. */
  done: Schema.Boolean,
  amountMinor: Schema.optionalKey(Schema.Number),
  location: Schema.optionalKey(Schema.String),
  /** Ops agenda record field that produced the date (generic scanner). */
  field: Schema.optionalKey(Schema.String),
  /** Own calendar event id (editable here). */
  eventId: Schema.optionalKey(Schema.String),
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

const withOptional = <Key extends string, Value>(key: Key, value: Value | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

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
            ownerPrincipalId: event.assignee?.principalId ?? event.createdBy.principalId,
            source: 'ops',
            title: event.title,
            ...withOptional('location', event.related?.label),
          },
        ],
  );

// ---- Generic scan of the other provoz agendas (their shapes evolve in parallel lanes) -------------------------

/** Route segment of each provoz agenda. */
export const opsSegments: Readonly<Record<string, string>> = {
  agenda: 'agenda',
  assets: 'majetek',
  documents: 'dokumenty',
  meters: 'meridla',
  purchasing: 'nakupy',
  security: 'bezpecnost',
};

/** Detail links follow the source module's existing public query parameters. */
export const opsRecordHref = (agenda: string, collection: string, id: string): string => {
  const param = ({ assets: 'asset', meters: 'meter', documents: 'doc', devices: 'device', orders: 'orderId' } as Readonly<Record<string, string>>)[collection];
  return `/provoz/${opsSegments[agenda] ?? agenda}${param === undefined ? '' : `?${param}=${encodeURIComponent(id)}`}`;
};

const DEADLINE_FIELD =
  /^(next[A-Z]\w*|\w*Due(On|Date|At)?|dueDate|dueOn|validUntil|validTo|expiresOn|expiresAt|expiryDate|expirationDate|expectedDate|deadline|reviewDate|plannedDate)$/u;
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

type Loose = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);

const titleOf = (record: Loose): string | undefined => {
  for (const field of TITLE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
};

/** `true` when a loose record says it is finished (state/status value, or closedAt/resolvedAt set). */
export const isClosedRecord = (record: Loose): boolean => {
  for (const field of ['state', 'status', 'lifecycleState']) {
    const value = record[field];
    if (typeof value === 'string' && CLOSED_VALUES.has(value.toLowerCase())) {
      return true;
    }
  }
  return record['closedAt'] != null || record['resolvedAt'] != null;
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

const locationOf = (record: Loose): string | undefined => {
  for (const field of ['location', 'related', 'propertyRef', 'place']) {
    const value = record[field];
    if (isRecord(value) && typeof value['label'] === 'string') {
      return value['label'];
    }
  }
  return undefined;
};

interface ScanHit {
  readonly agenda: string;
  readonly href: string;
  readonly recordId: string;
  readonly field: string;
  readonly date: string;
  readonly title: string;
  readonly parentTitle?: string;
  readonly location?: string;
  readonly closed: boolean;
  /** Latest performed service wins, not the most distant promised deadline. */
  readonly rank: string;
  /** Nested services keep a separate current deadline per parent + service kind/title + field. */
  readonly groupKey: string;
}

const scanRecords = (
  agenda: string,
  records: readonly unknown[],
  depth: number,
  parent: { readonly id: string; readonly title?: string; readonly location?: string; readonly closed: boolean; readonly href: string } | undefined,
  hits: ScanHit[],
  collection: string,
) => {
  for (const [index, entry] of records.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const recordId = typeof entry['id'] === 'string' ? entry['id'] : `${parent?.id ?? agenda}#${index}`;
    const title = titleOf(entry) ?? parent?.title ?? recordId;
    const href = parent?.href ?? opsRecordHref(agenda, collection, recordId);
    const closed = isClosedRecord(entry) || parent?.closed === true;
    const location = locationOf(entry) ?? parent?.location;
    for (const [field, value] of Object.entries(entry)) {
      if (typeof value === 'string' && DEADLINE_FIELD.test(field) && DATE_VALUE.test(value)) {
        hits.push({
          agenda,
          href,
          closed,
          date: day(value),
          field,
          groupKey: parent === undefined
            ? `${recordId}:${field}`
            : `nested:${parent.id}:${String(entry['kind'] ?? '')}:${title.toLowerCase()}:${field}`,
          rank: typeof entry['performedOn'] === 'string' ? entry['performedOn'] : day(value),
          recordId,
          title,
          ...withOptional('location', location),
          ...withOptional('parentTitle', parent?.title),
        });
      } else if (depth < 3 && (Array.isArray(value) || isRecord(value))) {
        // Contract terms and inventory follow-ups are nested objects, not arrays.
        scanRecords(agenda, Array.isArray(value) ? value : [value], depth + 1,
          { closed, href, id: `${recordId}:${field}`, title, ...withOptional('location', location) }, hits, collection);
      }
    }
  }
};

/**
 * Deadlines of one provoz agenda state, found by field name (`next…Date`, `…Due…`, `validUntil`, `expiresOn`, …).
 * Nested records (e.g. revisions of an asset) contribute only their latest date per parent and field.
 */
export const opsAgendaDeadlines = (agenda: string, state: unknown): Deadline[] => {
  if (agenda === 'agenda' || !isRecord(state)) {
    return [];
  }
  const hits: ScanHit[] = [];
  for (const [collection, value] of Object.entries(state)) {
    if (Array.isArray(value)) {
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
export const openOpsIncidents = (agenda: string, state: unknown): OpsIncident[] => {
  if (!isRecord(state)) {
    return [];
  }
  return Object.entries(state).flatMap(([key, value]) =>
    Array.isArray(value) && /incident|fault|defect|issue|ticket|porucha/iu.test(key)
      ? value.flatMap((entry, index) =>
          isRecord(entry) && !isClosedRecord(entry)
            ? [
                {
                  agenda,
                  id: typeof entry['id'] === 'string' ? entry['id'] : `${agenda}:${key}#${index}`,
                  title: titleOf(entry) ?? (typeof entry['description'] === 'string' ? entry['description'] : key),
                  ...withOptional('location', locationOf(entry)),
                },
              ]
            : [],
        )
      : [],
  );
};

const searchRow = (entry: Omit<OpsSearchRow, 'terms'>, extra: readonly (string | null | undefined)[]): OpsSearchRow => {
  const terms = extra.filter((part) => typeof part === 'string').join(' ');
  return { ...entry, ...withOptional('terms', terms === '' ? undefined : terms) };
};

const subtitleOf = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? {} : { subtitle: value });

const SKIPPED_SEARCH_COLLECTIONS = /history|events|versions|readings|log|comments|threads|messages|preferences|exports|templates|signatures/iu;
const SEARCH_TITLE_FIELDS = ['name', 'title', 'label', 'inventoryNumber', 'serialNumber', 'code', 'documentNumber', 'number', 'description', 'summary'] as const;

/** Search rows of one readable provoz agenda: calendar events, or the records of every top-level collection. */
export const opsSearchRows = (agenda: string, state: unknown): OpsSearchRow[] => {
  if (agenda === 'agenda') {
    return (state as AgendaState).events.map((event) =>
      searchRow(
        { href: `/provoz/agenda?event=${event.id}`, id: event.id, kind: 'event', title: event.title, ...subtitleOf(event.date) },
        [event.note, event.related?.label],
      ),
    );
  }
  const rows: OpsSearchRow[] = [];
  for (const [field, list] of Object.entries(isRecord(state) ? state : {})) {
    if (!Array.isArray(list) || SKIPPED_SEARCH_COLLECTIONS.test(field)) {
      continue;
    }
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string') {
        continue;
      }
      const title = SEARCH_TITLE_FIELDS.map((key) => entry[key]).find((value): value is string => typeof value === 'string' && value !== '');
      if (title === undefined) continue;
      const extra = Object.values(entry).filter((value): value is string => typeof value === 'string' && value.length < 200);
      const location = isRecord(entry['location']) ? entry['location'] : isRecord(entry['related']) ? entry['related'] : undefined;
      rows.push(
        searchRow(
          {
            href: opsRecordHref(agenda, field, entry['id']),
            id: entry['id'],
            kind: 'ops',
            title,
            ...subtitleOf(typeof location?.['label'] === 'string' ? location['label'] : undefined),
          },
          [agenda, ...extra],
        ),
      );
    }
  }
  return rows;
};

/** Number of records of the agenda's first collection (Přehled tile). */
export const opsRecordCount = (state: unknown): number => {
  if (typeof state !== 'object' || state === null) {
    return 0;
  }
  const first = Object.values(state).find(Array.isArray);
  return Array.isArray(first) ? first.length : 0;
};

/** Order in which the overview walks the readable agendas (the order the browser saw them in the records read). */
export const overviewAgendaOrder: readonly AgendaId[] = ['agenda', 'assets', 'documents', 'meters', 'purchasing', 'security'];

/**
 * The provoz part of Přehled / Moje agenda from the agenda states the person may read (already narrowed to what
 * they may see). Incidents are present only when the security agenda is readable (it holds the incidents).
 */
export const opsOverviewOf = (
  visible: ReadonlyMap<AgendaId, { readonly revision: number; readonly state: unknown }>,
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
        ? eventDeadlines((entry.state as AgendaState).events)
        : opsAgendaDeadlines(agenda, entry.state),
    ),
    ...(visible.has('security')
      ? { incidents: agendas.flatMap(({ agenda, entry }) => openOpsIncidents(agenda, entry.state)) }
      : {}),
    ...(includeSearch ? { searchRows: agendas.flatMap(({ agenda, entry }) => opsSearchRows(agenda, entry.state)) } : {}),
  };
};
