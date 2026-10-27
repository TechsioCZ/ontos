import { CalendarDateSchema } from '@app/shared-contracts/calendar-date';
import { DateTime, Option, Schema } from 'effect';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
// S13 calendar: deadlines DERIVED from their source records (never copied, never edited here).
// Pure functions over minimal structural shapes of the public reads, so they are unit-testable without the
// other verticals. Owned by the ops-agenda lane. Each deadline has a stable `key` (source + record + field + date):
// when the source date changes, the key changes, so the calendar shows the new date without a second write (S13-02)
// and a notification is offered again exactly once (S13-03 dedup is enforced by the agenda reducer).

import type { Deadline } from '../../../shared/domain/ops-overview.ts';
import { deadlineOwnerPrincipalId } from '../../../shared/domain/ops-overview.ts';
import { EventKeySchema } from '../../../shared/domain/agenda.ts';

const RefSchema = Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('ResourceId')) });
type Ref = typeof RefSchema.Encoded;
const NullableRefSchema = Schema.OptionFromNullOr(RefSchema);
const NullableDateSchema = Schema.OptionFromNullOr(CalendarDateSchema);

export const ContractSourceSchema = Schema.Struct({
  contractRef: RefSchema,
  counterpartyRef: RefSchema,
  endDate: NullableDateSchema,
  lifecycleState: Schema.String,
  propertyRef: NullableRefSchema,
  renewalNoticeDate: NullableDateSchema,
  startDate: CalendarDateSchema,
  subject: Schema.optionalKey(Schema.String),
  unitRef: NullableRefSchema,
});
export type ContractSource = typeof ContractSourceSchema.Encoded;

export const OccupancySourceSchema = Schema.Struct({
  customerCounterpartyRef: NullableRefSchema,
  endDate: NullableDateSchema,
  kind: Schema.String,
  occupancyRef: RefSchema,
  startDate: CalendarDateSchema,
  state: Schema.String,
  unitRef: RefSchema,
});
export type OccupancySource = typeof OccupancySourceSchema.Encoded;

export const TaskSourceSchema = Schema.Struct({
  contextRefs: Schema.Array(RefSchema),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(
    Schema.Struct({ principalId: Schema.String.pipe(Schema.brand('PrincipalId')) }),
  ),
  priority: Schema.String,
  ref: RefSchema,
  state: Schema.String,
  title: Schema.String,
});
export type TaskSource = typeof TaskSourceSchema.Encoded;

export const InvoiceSourceSchema = Schema.Struct({
  businessState: Schema.String,
  counterpartyName: Schema.optionalKey(Schema.String),
  counterpartyRef: RefSchema,
  direction: Schema.String,
  documentNumber: Schema.String,
  dueDate: CalendarDateSchema,
  number: Schema.optionalKey(Schema.String),
  paidMinor: Schema.Finite,
  paymentState: Schema.String,
  propertyRef: Schema.optionalKey(RefSchema),
  ref: RefSchema,
  totalMinor: Schema.Finite,
  unitRef: Schema.optionalKey(RefSchema),
});
export type InvoiceSource = typeof InvoiceSourceSchema.Encoded;

export const AssetSourceSchema = Schema.Struct({
  assetRef: RefSchema,
  code: Schema.String,
  lifecycleState: Schema.String,
  name: Schema.String,
  nextServiceAt: NullableDateSchema,
  propertyRef: RefSchema,
  unitRef: NullableRefSchema,
});
export type AssetSource = typeof AssetSourceSchema.Encoded;

export const ProjectSourceSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.brand('ProjectId')),
  milestones: Schema.Array(
    Schema.Struct({ completed: Schema.Boolean, dueDate: CalendarDateSchema, title: Schema.String }),
  ),
  plannedEnd: CalendarDateSchema,
  plannedStart: CalendarDateSchema,
  state: Schema.String,
  title: Schema.String,
});
export type ProjectSource = typeof ProjectSourceSchema.Encoded;

/** Display names of referenced records (units, properties, counterparties) keyed by resource id. */
export type NameLookup = ReadonlyMap<string, string>;

const nameOf = (names: NameLookup, ref: Ref | null | undefined) =>
  ref === null || ref === undefined ? undefined : names.get(ref.resourceId);

type OptionalField<Key extends string, Value> = Partial<Record<Key, Value>>;

const withOptional = <Key extends string, Value>(key: Key, value: Value | undefined) => {
  const fields: OptionalField<Key, Value> = {};
  if (value !== undefined) {
    fields[key] = value;
  }
  return fields;
};

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
      detail: contract.lifecycleState,
      done: false,
      href: `/smlouvy?resourceId=${encodeURIComponent(id)}`,
      source: 'agreements' as const,
      title,
      ...withOptional('location', location),
    };
    const rows: Deadline[] = [];
    if (contract.endDate !== null) {
      rows.push({
        ...base,
        category: 'contractEnd',
        date: day(contract.endDate),
        key: `contract-end:${id}:${day(contract.endDate)}`,
      });
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
        ...withOptional(
          'ownerPrincipalId',
          task.ownerPrincipalRef === undefined
            ? undefined
            : deadlineOwnerPrincipalId(task.ownerPrincipalRef.principalId),
        ),
      },
    ];
  });

/** Project dates and milestones are read directly from the work owner's public records. */
export const projectDeadlines = (projects: readonly ProjectSource[]): Deadline[] =>
  projects.flatMap((project) => {
    const base = {
      category: 'opsDeadline' as const,
      done: project.state === 'DONE',
      href: `/ukoly?tab=projects&project=${encodeURIComponent(project.id)}`,
      source: 'work' as const,
    };
    return [
      {
        ...base,
        date: project.plannedStart,
        done: project.state !== 'PLANNED',
        key: `project-start:${project.id}:${project.plannedStart}`,
        title: project.title,
      },
      {
        ...base,
        date: project.plannedEnd,
        key: `project-end:${project.id}:${project.plannedEnd}`,
        title: project.title,
      },
      ...project.milestones.map((milestone, index) => ({
        ...base,
        date: milestone.dueDate,
        done: base.done || milestone.completed,
        key: `project-milestone:${project.id}:${index}:${milestone.dueDate}`,
        title: `${project.title} · ${milestone.title}`,
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
export const pragueToday = (now: Date = browserRuntime.runSync(DateTime.nowAsDate)) => pragueFormat.format(now);

const DAY_MS = 86_400_000;
const epochMillis = (date: string) =>
  DateTime.make(`${date}T00:00:00Z`).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => Number.NaN),
  );
const dayNumber = (date: string) => Math.round(epochMillis(date) / DAY_MS);

/** Whole days from `today` to `date` (negative = past). */
export const daysUntil = (date: string, today: string) => dayNumber(date) - dayNumber(today);

export const addDays = (date: string, days: number) =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe((dayNumber(date) + days) * DAY_MS));

export const UrgencySchema = Schema.Literals(['done', 'overdue', 'today', 'soon', 'later']);
export type Urgency = typeof UrgencySchema.Type;

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

export const DeliveryCandidateSchema = Schema.Struct({
  category: Schema.Literals(['DEADLINE', 'OVERDUE']),
  detail: Schema.optionalKey(Schema.String),
  dueDate: CalendarDateSchema,
  eventKey: EventKeySchema.pipe(Schema.brand('EventKey')),
  href: Schema.String,
  source: Schema.String,
  title: Schema.String,
});
export type DeliveryCandidate = typeof DeliveryCandidateSchema.Encoded;

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
        title: deadline.title.slice(0, 300) || deadline.key.slice(0, 300),
        ...withOptional('detail', deadline.category),
      },
    ];
  });

/** Native assignments are independent of due dates. Repeated visits deduplicate by task + recipient. */
export const taskAssignmentCandidates = (tasks: readonly TaskSource[], me: string | undefined) =>
  tasks.flatMap((task) =>
    me === undefined ||
    task.ownerPrincipalRef?.principalId !== me ||
    task.state === 'DONE' ||
    task.state === 'CANCELLED'
      ? []
      : [
          {
            category: 'ASSIGNED' as const,
            eventKey: `task-assigned:${task.ref.resourceId}:${me}`,
            href: `/ukoly?resourceId=${encodeURIComponent(task.ref.resourceId)}`,
            source: 'work',
            title: task.title.slice(0, 300),
            ...withOptional('dueDate', task.dueDate),
          },
        ],
  );

// ---- CSV -------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | undefined) => {
  const raw = value === undefined ? '' : String(value);
  // Names and notes must not execute as spreadsheet formulas when a CSV is opened in Excel.
  const text = Schema.is(Schema.String)(value) && /^[\s]*[=+@-]/u.test(raw) ? `'${raw}` : raw;
  return /[";\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Semicolon-separated CSV with a UTF-8 BOM (opens correctly in Czech Excel). */
export const toCsv = (header: readonly string[], rows: readonly (readonly (string | number | undefined)[])[]) =>
  `﻿${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
