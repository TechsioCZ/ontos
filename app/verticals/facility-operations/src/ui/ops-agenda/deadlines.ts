// @effect-diagnostics globalDate:off
// S13 calendar: deadlines DERIVED from their source records (never copied, never edited here).
// Pure functions over minimal structural shapes of the public reads, so they are unit-testable without the
// other verticals. Owned by the ops-agenda lane. Each deadline has a stable `key` (source + record + field + date):
// when the source date changes, the key changes, so the calendar shows the new date without a second write (S13-02)
// and a notification is offered again exactly once (S13-03 dedup is enforced by the agenda reducer).

import type { Deadline } from '../../../shared/domain/ops-overview.ts';

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
      href: `/smlouvy?resourceId=${encodeURIComponent(id)}`,
      source: 'agreements' as const,
      detail: contract.lifecycleState,
      title,
      ...withOptional('location', location),
    };
    const rows: Deadline[] = [];
    if (contract.endDate !== null) {
      rows.push({ ...base, category: 'contractEnd', date: day(contract.endDate), key: `contract-end:${id}:${day(contract.endDate)}` });
    }
    if (contract.renewalNoticeDate !== null) {
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
      href: `/najmy?resourceId=${encodeURIComponent(id)}`,
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
        href: `/ukoly?resourceId=${encodeURIComponent(task.ref.resourceId)}`,
        key: `task-due:${task.ref.resourceId}:${day(task.dueDate)}`,
        source: 'work',
        title: task.title,
        ...withOptional('location', location),
        ...withOptional('ownerPrincipalId', task.ownerPrincipalRef?.principalId),
      },
    ];
  });

/** Project dates and milestones are read directly from the work owner's public records. */
export const projectDeadlines = (projects: readonly {
  readonly id: string;
  readonly title: string;
  readonly plannedStart: string;
  readonly plannedEnd: string;
  readonly state: string;
  readonly milestones: readonly { readonly title: string; readonly dueDate: string; readonly completed: boolean }[];
}[]): Deadline[] => projects.flatMap((project) => {
  const base = {
    category: 'opsDeadline' as const,
    source: 'work' as const,
    href: `/ukoly?tab=projects&project=${encodeURIComponent(project.id)}`,
    done: project.state === 'DONE',
  };
  return [
    { ...base, date: project.plannedStart, done: project.state !== 'PLANNED', title: project.title, key: `project-start:${project.id}:${project.plannedStart}` },
    { ...base, date: project.plannedEnd, title: project.title, key: `project-end:${project.id}:${project.plannedEnd}` },
    ...project.milestones.map((milestone, index) => ({
      ...base, date: milestone.dueDate, done: base.done || milestone.completed,
      title: `${project.title} · ${milestone.title}`,
      key: `project-milestone:${project.id}:${index}:${milestone.dueDate}`,
    })),
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
        href: `/finance?resourceId=${encodeURIComponent(id)}`,
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
        href: `/nemovitosti?resourceId=${encodeURIComponent(asset.propertyRef.resourceId)}`,
        key: `asset-service:${id}:${day(asset.nextServiceAt)}`,
        source: 'property',
        title: `${asset.name} (${asset.code})`,
        ...withOptional('location', location),
      },
    ];
  });

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

/** Native assignments are independent of due dates. Repeated visits deduplicate by task + recipient. */
export const taskAssignmentCandidates = (tasks: readonly TaskSource[], me: string | undefined) =>
  tasks.flatMap((task) => me === undefined || task.ownerPrincipalRef?.principalId !== me || task.state === 'DONE' || task.state === 'CANCELLED'
    ? []
    : [{
        category: 'ASSIGNED' as const,
        eventKey: `task-assigned:${task.ref.resourceId}:${me}`,
        href: `/ukoly?resourceId=${encodeURIComponent(task.ref.resourceId)}`,
        source: 'work',
        title: task.title.slice(0, 300),
        ...withOptional('dueDate', task.dueDate),
      }]);

// ---- CSV -------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | undefined) => {
  const raw = value === undefined ? '' : String(value);
  // Names and notes must not execute as spreadsheet formulas when a CSV is opened in Excel.
  const text = typeof value === 'string' && /^[\s]*[=+@-]/u.test(raw) ? `'${raw}` : raw;
  return /[";\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Semicolon-separated CSV with a UTF-8 BOM (opens correctly in Czech Excel). */
export const toCsv = (header: readonly string[], rows: readonly (readonly (string | number | undefined)[])[]) =>
  `﻿${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
