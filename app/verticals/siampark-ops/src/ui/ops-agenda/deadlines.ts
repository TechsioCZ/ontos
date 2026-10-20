// @effect-diagnostics globalDate:off
// S13 calendar: deadlines DERIVED from their source records (never copied, never edited here).
// Pure functions over minimal structural shapes of the public reads, so they are unit-testable without the
// other verticals. Owned by the ops-agenda lane. Each deadline has a stable `key` (source + record + field + date):
// when the source date changes, the key changes, so the calendar shows the new date without a second write (S13-02)
// and a notification is offered again exactly once (S13-03 dedup is enforced by the agenda reducer).

export type SourceId = 'agreements' | 'occupancy' | 'work' | 'finance' | 'property' | 'ops' | 'parties';

export type DeadlineCategory =
  | 'contractEnd'
  | 'contractNotice'
  | 'contractStart'
  | 'leaseStart'
  | 'leaseEnd'
  | 'assetService'
  | 'inspection'
  | 'meterReading'
  | 'invoiceDue'
  | 'task'
  | 'event'
  | 'opsDeadline';

export interface Deadline {
  /** Stable identity of this occurrence (changes when the source date changes). */
  readonly key: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly category: DeadlineCategory;
  readonly source: SourceId;
  readonly title: string;
  readonly detail?: string;
  /** In-app path without the language prefix. */
  readonly href: string;
  /** Person responsible, when the source knows one. */
  readonly ownerPrincipalId?: string;
  /** Completed / cancelled / paid in the source: shown, never notified, never overdue. */
  readonly done: boolean;
  readonly amountMinor?: number;
  readonly location?: string;
  /** Ops agenda record field that produced the date (generic scanner). */
  readonly field?: string;
  /** Own calendar event id (editable here). */
  readonly eventId?: string;
}

interface Ref {
  readonly resourceId: string;
}

export interface ContractSource {
  readonly contractRef: Ref;
  readonly counterpartyRef: Ref;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly renewalNoticeDate: string | null;
  readonly lifecycleState: string;
  readonly unitRef: Ref | null;
  readonly propertyRef: Ref | null;
  readonly subject?: string;
}

export interface OccupancySource {
  readonly occupancyRef: Ref;
  readonly unitRef: Ref;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly state: string;
  readonly kind: string;
  readonly customerCounterpartyRef: Ref | null;
}

export interface TaskSource {
  readonly ref: Ref;
  readonly title: string;
  readonly dueDate?: string;
  readonly state: string;
  readonly priority: string;
  readonly ownerPrincipalRef?: { readonly principalId: string };
  readonly contextRefs: readonly Ref[];
}

export interface InvoiceSource {
  readonly ref: Ref;
  readonly dueDate: string;
  readonly direction: string;
  readonly businessState: string;
  readonly paymentState: string;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly documentNumber: string;
  readonly number?: string;
  readonly counterpartyName?: string;
  readonly counterpartyRef: Ref;
  readonly unitRef?: Ref;
  readonly propertyRef?: Ref;
}

export interface AssetSource {
  readonly assetRef: Ref;
  readonly name: string;
  readonly code: string;
  readonly nextServiceAt: string | null;
  readonly lifecycleState: string;
  readonly propertyRef: Ref;
  readonly unitRef: Ref | null;
}

export interface CalendarEventSource {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly kind: string;
  readonly status?: string;
  readonly assignee?: { readonly principalId: string };
  readonly createdBy: { readonly principalId: string };
  readonly related?: { readonly label: string };
  readonly note?: string;
}

/** Display names of referenced records (units, properties, counterparties) keyed by resource id. */
export type NameLookup = ReadonlyMap<string, string>;

const nameOf = (names: NameLookup, ref: Ref | null | undefined) =>
  ref === null || ref === undefined ? undefined : names.get(ref.resourceId);

const withOptional = <Key extends string, Value>(key: Key, value: Value | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const day = (value: string) => value.slice(0, 10);

/** Contract end, renewal notice and (future) start dates of ACTIVE/DRAFT contracts. */
export const contractDeadlines = (contracts: readonly ContractSource[], names: NameLookup): Deadline[] =>
  contracts.flatMap((contract) => {
    if (!['ACTIVE', 'DRAFT'].includes(contract.lifecycleState)) {
      return [];
    }
    const id = contract.contractRef.resourceId;
    const party = nameOf(names, contract.counterpartyRef);
    const location = nameOf(names, contract.unitRef) ?? nameOf(names, contract.propertyRef);
    const title = [party ?? contract.subject, location].filter((part) => part !== undefined).join(' · ') || id;
    const base = {
      done: false,
      href: `/siampark/agreements?resourceId=${encodeURIComponent(id)}`,
      source: 'agreements' as const,
      title,
      ...withOptional('location', location),
    };
    const rows: Deadline[] = [];
    if (contract.lifecycleState === 'ACTIVE' && contract.endDate !== null) {
      rows.push({ ...base, category: 'contractEnd', date: day(contract.endDate), key: `contract-end:${id}:${day(contract.endDate)}` });
    }
    if (contract.lifecycleState === 'ACTIVE' && contract.renewalNoticeDate !== null) {
      rows.push({
        ...base,
        category: 'contractNotice',
        date: day(contract.renewalNoticeDate),
        key: `contract-notice:${id}:${day(contract.renewalNoticeDate)}`,
      });
    }
    if (contract.lifecycleState === 'DRAFT' || contract.lifecycleState === 'ACTIVE') {
      rows.push({
        ...base,
        category: 'contractStart',
        date: day(contract.startDate),
        done: contract.lifecycleState === 'ACTIVE',
        key: `contract-start:${id}:${day(contract.startDate)}`,
      });
    }
    return rows;
  });

/** Lease / stay start and end of CONFIRMED and ACTIVE occupancies. */
export const occupancyDeadlines = (occupancies: readonly OccupancySource[], names: NameLookup): Deadline[] =>
  occupancies.flatMap((occupancy) => {
    if (!['CONFIRMED', 'ACTIVE'].includes(occupancy.state)) {
      return [];
    }
    const id = occupancy.occupancyRef.resourceId;
    const location = nameOf(names, occupancy.unitRef);
    const party = nameOf(names, occupancy.customerCounterpartyRef);
    const title = [party, location].filter((part) => part !== undefined).join(' · ') || id;
    const base = {
      href: `/siampark/occupancy?resourceId=${encodeURIComponent(id)}`,
      source: 'occupancy' as const,
      title,
      ...withOptional('location', location),
    };
    const rows: Deadline[] = [
      {
        ...base,
        category: 'leaseStart',
        date: day(occupancy.startDate),
        done: occupancy.state === 'ACTIVE',
        key: `lease-start:${id}:${day(occupancy.startDate)}`,
      },
    ];
    if (occupancy.endDate !== null) {
      rows.push({
        ...base,
        category: 'leaseEnd',
        date: day(occupancy.endDate),
        done: false,
        key: `lease-end:${id}:${day(occupancy.endDate)}`,
      });
    }
    return rows;
  });

const closedTaskStates = new Set(['DONE', 'CANCELLED']);

export const taskDeadlines = (tasks: readonly TaskSource[], names: NameLookup): Deadline[] =>
  tasks.flatMap((task) => {
    if (task.dueDate === undefined || task.state === 'CANCELLED') {
      return [];
    }
    const location = task.contextRefs.map((ref) => names.get(ref.resourceId)).find((label) => label !== undefined);
    return [
      {
        category: 'task',
        date: day(task.dueDate),
        done: closedTaskStates.has(task.state),
        href: `/siampark/work?resourceId=${encodeURIComponent(task.ref.resourceId)}`,
        key: `task-due:${task.ref.resourceId}:${day(task.dueDate)}`,
        source: 'work',
        title: task.title,
        ...withOptional('location', location),
        ...withOptional('ownerPrincipalId', task.ownerPrincipalRef?.principalId),
      },
    ];
  });

/** Outstanding amount of an invoice in minor units (never negative). */
export const outstandingMinor = (invoice: InvoiceSource) => Math.max(0, invoice.totalMinor - invoice.paidMinor);

/** Confirmed, not voided, not fully paid invoices (both directions). */
export const isOpenInvoice = (invoice: InvoiceSource) =>
  invoice.businessState === 'CONFIRMED' && invoice.paymentState !== 'PAID' && outstandingMinor(invoice) > 0;

export const invoiceDeadlines = (invoices: readonly InvoiceSource[], names: NameLookup): Deadline[] =>
  invoices.flatMap((invoice) => {
    if (invoice.businessState === 'VOIDED') {
      return [];
    }
    const id = invoice.ref.resourceId;
    const party = invoice.counterpartyName ?? nameOf(names, invoice.counterpartyRef);
    const number = invoice.number ?? invoice.documentNumber;
    const location = nameOf(names, invoice.unitRef) ?? nameOf(names, invoice.propertyRef);
    return [
      {
        amountMinor: outstandingMinor(invoice),
        category: 'invoiceDue',
        date: day(invoice.dueDate),
        detail: invoice.direction,
        done: !isOpenInvoice(invoice),
        href: `/siampark/finance?resourceId=${encodeURIComponent(id)}`,
        key: `invoice-due:${id}:${day(invoice.dueDate)}`,
        source: 'finance',
        title: [number, party].filter((part) => part !== undefined && part !== '').join(' · '),
        ...withOptional('location', location),
      },
    ];
  });

export const assetDeadlines = (assets: readonly AssetSource[], names: NameLookup): Deadline[] =>
  assets.flatMap((asset) => {
    if (asset.nextServiceAt === null || asset.lifecycleState === 'DISPOSED' || asset.lifecycleState === 'RETIRED') {
      return [];
    }
    const id = asset.assetRef.resourceId;
    const location = nameOf(names, asset.unitRef) ?? nameOf(names, asset.propertyRef);
    return [
      {
        category: 'assetService',
        date: day(asset.nextServiceAt),
        done: false,
        href: `/siampark/properties?resourceId=${encodeURIComponent(asset.propertyRef.resourceId)}`,
        key: `asset-service:${id}:${day(asset.nextServiceAt)}`,
        source: 'property',
        title: `${asset.name} (${asset.code})`,
        ...withOptional('location', location),
      },
    ];
  });

export const eventDeadlines = (events: readonly CalendarEventSource[]): Deadline[] =>
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
            href: `/siampark/provoz/agenda?event=${encodeURIComponent(event.id)}`,
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
  return record['closedAt'] !== undefined || record['resolvedAt'] !== undefined;
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
  readonly recordId: string;
  readonly field: string;
  readonly date: string;
  readonly title: string;
  readonly parentTitle?: string;
  readonly location?: string;
  readonly closed: boolean;
  /** Parent record id; hits of nested records keep only the latest date per parent + field. */
  readonly groupKey: string;
}

const scanRecords = (
  agenda: string,
  records: readonly unknown[],
  depth: number,
  parent: { readonly id: string; readonly title?: string; readonly location?: string; readonly closed: boolean } | undefined,
  hits: ScanHit[],
) => {
  for (const [index, entry] of records.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const recordId = typeof entry['id'] === 'string' ? entry['id'] : `${parent?.id ?? agenda}#${index}`;
    const title = titleOf(entry) ?? parent?.title ?? recordId;
    const closed = isClosedRecord(entry) || parent?.closed === true;
    const location = locationOf(entry) ?? parent?.location;
    for (const [field, value] of Object.entries(entry)) {
      if (typeof value === 'string' && DEADLINE_FIELD.test(field) && DATE_VALUE.test(value)) {
        hits.push({
          agenda,
          closed,
          date: day(value),
          field,
          groupKey: parent === undefined ? `${recordId}:${field}` : `nested:${parent.id}:${field}`,
          recordId,
          title,
          ...withOptional('location', location),
          ...withOptional('parentTitle', parent?.title),
        });
      } else if (Array.isArray(value) && depth < 3) {
        scanRecords(agenda, value, depth + 1, { closed, id: recordId, title, ...withOptional('location', location) }, hits);
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
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) {
      scanRecords(agenda, value, 1, undefined, hits);
    }
  }
  const latest = new Map<string, ScanHit>();
  for (const hit of hits) {
    const current = latest.get(hit.groupKey);
    if (current === undefined || hit.date > current.date) {
      latest.set(hit.groupKey, hit);
    }
  }
  return [...latest.values()].map((hit) => ({
    category: categoryOfField(hit.field, hit.agenda),
    date: hit.date,
    detail: hit.parentTitle !== undefined && hit.parentTitle !== hit.title ? hit.parentTitle : hit.agenda,
    done: hit.closed,
    field: hit.field,
    href: `/siampark/provoz/${opsSegments[hit.agenda] ?? hit.agenda}`,
    key: `ops:${hit.agenda}:${hit.recordId}:${hit.field}:${hit.date}`,
    source: 'ops',
    title: hit.title,
    ...withOptional('location', hit.location),
  }));
};

/** Open incidents / faults of the provoz agendas (arrays named …incident…, …fault…, …defect…, …issue…). */
export const openOpsIncidents = (
  agenda: string,
  state: unknown,
): readonly { readonly id: string; readonly title: string; readonly agenda: string; readonly location?: string }[] => {
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

// ---- Time helpers ----------------------------------------------------------------------------------------------

const pragueFormat = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});

/** Today in Europe/Prague as `YYYY-MM-DD`. */
export const pragueToday = (now: Date = new Date()) => pragueFormat.format(now);

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/** Whole days from `today` to `date` (negative = past). */
export const daysUntil = (date: string, today: string) => dayNumber(date) - dayNumber(today);

export const addDays = (date: string, days: number) =>
  new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);

export type Urgency = 'done' | 'overdue' | 'today' | 'soon' | 'later';

/** done → overdue (past) → today → soon (≤ 7 days) → later. */
export const urgencyOf = (deadline: Pick<Deadline, 'date' | 'done'>, today: string): Urgency => {
  if (deadline.done) {
    return 'done';
  }
  const days = daysUntil(deadline.date, today);
  if (days < 0) {
    return 'overdue';
  }
  if (days === 0) {
    return 'today';
  }
  return days <= 7 ? 'soon' : 'later';
};

export const sortDeadlines = (rows: readonly Deadline[]) =>
  rows.toSorted((left, right) => left.date.localeCompare(right.date) || left.key.localeCompare(right.key));

// ---- Notifications ---------------------------------------------------------------------------------------------

export interface DeliveryCandidate {
  readonly eventKey: string;
  readonly category: 'DEADLINE' | 'OVERDUE';
  readonly title: string;
  readonly detail?: string;
  readonly source: string;
  readonly href: string;
  readonly dueDate: string;
}

/** Overdue horizon: older overdue items are not re-announced (they are visible in the calendar). */
const OVERDUE_HORIZON_DAYS = 60;

/**
 * Deadlines that deserve an in-app notice for `me`: open, due within `leadDays` (or overdue up to 60 days), and
 * either owned by me or without a known owner. The eventKey includes the category, so an item notified as
 * DEADLINE is announced once more when it becomes OVERDUE — and never twice for the same state.
 */
export const notificationCandidates = (
  deadlines: readonly Deadline[],
  today: string,
  leadDays: number,
  me: string | undefined,
): DeliveryCandidate[] =>
  deadlines.flatMap((deadline) => {
    if (deadline.done || (deadline.ownerPrincipalId !== undefined && deadline.ownerPrincipalId !== me)) {
      return [];
    }
    if (deadline.category === 'contractStart' || deadline.category === 'leaseStart') {
      return [];
    }
    const days = daysUntil(deadline.date, today);
    if (days > leadDays || days < -OVERDUE_HORIZON_DAYS) {
      return [];
    }
    const category = days < 0 ? 'OVERDUE' : 'DEADLINE';
    return [
      {
        category,
        dueDate: deadline.date,
        eventKey: `${deadline.key}:${category}`.slice(0, 400),
        href: deadline.href,
        source: deadline.source,
        title: `${deadline.title}`.slice(0, 300) || deadline.key.slice(0, 300),
        ...withOptional('detail', deadline.category),
      },
    ];
  });

// ---- CSV -------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value);
  return /[";\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Semicolon-separated CSV with a UTF-8 BOM (opens correctly in Czech Excel). */
export const toCsv = (header: readonly string[], rows: readonly (readonly (string | number | undefined)[])[]) =>
  `﻿${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
