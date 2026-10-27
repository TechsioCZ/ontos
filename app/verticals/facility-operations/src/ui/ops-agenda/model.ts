import { optionalField } from '../../../shared/domain/common.ts';
import { CalendarDateSchema } from '@app/shared-contracts/calendar-date';
import { Schema } from 'effect';
// Derived views over the loaded sources: calendar deadlines, overview KPIs (each with its exact drill-down rows),
// and the permission-filtered search index. Pure; owned by the ops-agenda lane.
import { foldSearchText, formatMoney } from '@app/admin-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import type { AgendaState } from '../../../shared/domain/agenda.ts';
import {
  addDays,
  assetDeadlines,
  contractDeadlines,
  daysUntil,
  invoiceDeadlines,
  isOpenInvoice,
  occupancyDeadlines,
  outstandingMinor,
  projectDeadlines,
  sortDeadlines,
  taskDeadlines,
} from './deadlines.ts';
import { opsSegmentOf } from '../../../shared/domain/ops-overview.ts';
import type { Deadline } from '../../../shared/domain/ops-overview.ts';
import { isOpenSalesCase } from './sales-source.ts';
import { sourceKeys } from './sources.ts';
import type { RentalOverviewSources, SourceKey, SourceStatus } from './sources.ts';

export const agendaStateOf = (sources: RentalOverviewSources): AgendaState | undefined =>
  sources.ops.data?.agenda?.state;

/** Retain the audit history in storage, but do not present removed, completed or superseded dates as live alerts. */
export const currentAgendaState = (
  sources: RentalOverviewSources,
  deadlines: readonly Deadline[],
  today: string,
): AgendaState | undefined => {
  const state = agendaStateOf(sources);
  if (state === undefined) {
    return undefined;
  }
  const currentKeys = new Set(
    deadlines.flatMap((row) => (row.done ? [] : [`${row.key}:${row.date < today ? 'OVERDUE' : 'DEADLINE'}`])),
  );
  const assignments = new Set(
    (sources.work.data?.items ?? []).flatMap((task) =>
      task.state === 'DONE' || task.state === 'CANCELLED'
        ? []
        : [`task-assigned:${task.ref.resourceId}:${task.ownerPrincipalRef?.principalId ?? ''}`],
    ),
  );
  return {
    ...state,
    notifications: (state.notifications ?? []).filter((entry) => {
      const source = sourceKeys.find((key) => key === entry.source);
      if (source !== undefined && sources[source].status === 'forbidden') {
        return false;
      }
      if (entry.eventKey.startsWith('task-assigned:') && sources.work.status === 'ready') {
        return assignments.has(entry.eventKey);
      }
      if (entry.category !== 'DEADLINE' && entry.category !== 'OVERDUE') {
        return true;
      }
      if (
        !/^(?:contract-|lease-|task-due:|invoice-due:|asset-service:|agenda-event:|ops:|project-)/u.test(entry.eventKey)
      ) {
        return true;
      }
      return source === undefined || sources[source].status !== 'ready' || currentKeys.has(entry.eventKey);
    }),
  };
};

/** Calendar rows from every readable source + which sources were covered. */
export const buildDeadlines = (sources: RentalOverviewSources, names: ReadonlyMap<string, string>): Deadline[] => {
  const rows: Deadline[] = [];
  if (sources.agreements.data !== undefined) {
    rows.push(...contractDeadlines(sources.agreements.data.contracts, names));
  }
  if (sources.occupancy.data !== undefined) {
    rows.push(...occupancyDeadlines(sources.occupancy.data.occupancies, names));
  }
  if (sources.work.data !== undefined) {
    rows.push(...taskDeadlines(sources.work.data.items, names), ...projectDeadlines(sources.work.data.projects ?? []));
  }
  if (sources.finance.data !== undefined) {
    rows.push(...invoiceDeadlines(sources.finance.data.state.invoices, names));
  }
  if (sources.property.data !== undefined) {
    rows.push(...assetDeadlines(sources.property.data.assets, names));
  }
  // Calendar events and provoz agenda dates: computed by the overview read on the server.
  rows.push(...(sources.ops.data?.deadlines ?? []));
  return sortDeadlines(rows);
};

// ---- KPIs --------------------------------------------------------------------------------------------------------

export interface DrillRow {
  readonly amountMinor?: number;
  readonly date?: string;
  readonly href: string;
  readonly id: string;
  /** i18n key suffix under `facility-operations.agenda.status.*` or a raw value. */
  readonly status?: string;
  readonly subtitle?: string | undefined;
  readonly title: string;
  readonly tone?: Tone;
}

export const ToneSchema = Schema.Literals(['primary', 'success', 'warning', 'danger', 'neutral', 'info']);
export type Tone = typeof ToneSchema.Type;

export const KpiIdSchema = Schema.Literals([
  'occupancy',
  'properties',
  'leases',
  'overdueInvoices',
  'openTasks',
  'incidents',
  'deadlines',
  'contracts',
  'salesCases',
  'planActual',
]);
export type KpiId = typeof KpiIdSchema.Type;

/** Latest successful read among the KPI's sources, retaining the ISO wire string. */
const KpiTimestampSchema = Schema.Struct({ loadedAt: Schema.optionalKey(Schema.DateTimeUtcFromString) });
export type Kpi = typeof KpiTimestampSchema.Encoded & {
  readonly id: KpiId;
  readonly kind: 'count' | 'percent';
  readonly rows: readonly DrillRow[];
  /** Second line values (interpolated into `facility-operations.agenda.kpi.<id>.secondary`). */
  readonly secondary?: Readonly<Record<string, string | number>>;
  readonly sources: readonly SourceKey[];
  readonly status: SourceStatus;
  readonly tone: Tone;
  /** Main number; `undefined` = „bez dat“ (never a fake zero). */
  readonly value?: number;
};

const combinedStatus = (sources: RentalOverviewSources, keys: readonly SourceKey[]): SourceStatus => {
  const statuses = new Set(keys.map((key) => sources[key].status));
  if (statuses.has('loading')) {
    return 'loading';
  }
  if (statuses.has('forbidden')) {
    return 'forbidden';
  }
  return statuses.has('unavailable') ? 'unavailable' : 'ready';
};

const loadedAtOf = (sources: RentalOverviewSources, keys: readonly SourceKey[]) =>
  keys
    .map((key) => sources[key].loadedAt)
    .filter((value): value is string => value !== undefined)
    .toSorted()
    .at(-1);

const kpiBase = (sources: RentalOverviewSources, id: KpiId, keys: readonly SourceKey[]) => {
  const loadedAt = loadedAtOf(sources, keys);
  return { id, sources: keys, status: combinedStatus(sources, keys), ...optionalField('loadedAt', loadedAt) };
};

const unavailable = (
  sources: RentalOverviewSources,
  id: KpiId,
  keys: readonly SourceKey[],
  kind: Kpi['kind'] = 'count',
): Kpi => ({
  ...kpiBase(sources, id, keys),
  kind,
  rows: [],
  tone: 'neutral',
});

const UnitAvailabilitySchema = Schema.Literals(['OCCUPIED', 'RESERVED', 'AVAILABLE']);
type UnitAvailability = typeof UnitAvailabilitySchema.Type;

const AvailabilityOccupancySchema = Schema.Struct({
  endDate: Schema.OptionFromNullOr(CalendarDateSchema),
  startDate: CalendarDateSchema,
  state: Schema.String,
  unitRef: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('ResourceId')) }),
});
type AvailabilityOccupancy = typeof AvailabilityOccupancySchema.Encoded;

export const unitAvailability = (
  unitId: string,
  occupancies: readonly AvailabilityOccupancy[],
  today: string,
): UnitAvailability => {
  const current = occupancies.filter(
    (item) =>
      item.unitRef.resourceId === unitId && item.startDate <= today && (item.endDate === null || today < item.endDate),
  );
  if (current.some((item) => item.state === 'ACTIVE')) {
    return 'OCCUPIED';
  }
  return current.some((item) => item.state === 'CONFIRMED') ? 'RESERVED' : 'AVAILABLE';
};

const availabilityTone = {
  AVAILABLE: 'success',
  OCCUPIED: 'primary',
  RESERVED: 'warning',
} satisfies Record<UnitAvailability, Tone>;

const taskTone = (dueDate: string | undefined, priority: string, today: string): Tone => {
  if (dueDate !== undefined && dueDate < today) {
    return 'danger';
  }
  return priority === 'HIGH' ? 'warning' : 'neutral';
};

const budgetTone = (kind: string, difference: number): Tone => {
  if (kind === 'COST') {
    return difference > 0 ? 'danger' : 'success';
  }
  return difference < 0 ? 'warning' : 'success';
};

export interface KpiInput {
  readonly deadlines: readonly Deadline[];
  readonly names: ReadonlyMap<string, string>;
  readonly sources: RentalOverviewSources;
  readonly today: string;
}

const propertyKpis = ({ names, sources, today }: KpiInput): Kpi[] => {
  const property = sources.property.data;
  const occupancy = sources.occupancy.data;
  const kpis: Kpi[] = [];

  // Occupancy: occupied ACTIVE units / ACTIVE units today (property + occupancy).
  if (property !== undefined && occupancy !== undefined) {
    const units = property.units.filter((unit) => unit.lifecycleState === 'ACTIVE');
    const rows = units.map((unit): DrillRow => {
      const availability = unitAvailability(unit.unitRef.resourceId, occupancy.occupancies, today);
      return {
        href: `/nemovitosti?resourceId=${encodeURIComponent(unit.unitRef.resourceId)}`,
        id: unit.unitRef.resourceId,
        status: `availability.${availability}`,
        subtitle: names.get(unit.propertyRef.resourceId) ?? unit.code,
        title: `${unit.name} (${unit.code})`,
        tone: availabilityTone[availability],
      };
    });
    const occupied = rows.filter((row) => row.status === 'availability.OCCUPIED').length;
    const reserved = rows.filter((row) => row.status === 'availability.RESERVED').length;
    kpis.push({
      ...kpiBase(sources, 'occupancy', ['property', 'occupancy']),
      kind: 'percent',
      rows: rows.toSorted(
        (left, right) => (left.status ?? '').localeCompare(right.status ?? '') || left.title.localeCompare(right.title),
      ),
      secondary: { free: units.length - occupied - reserved, occupied, reserved, total: units.length },
      tone: 'primary',
      ...optionalField('value', units.length === 0 ? undefined : occupied / units.length),
    });
  } else {
    kpis.push(unavailable(sources, 'occupancy', ['property', 'occupancy'], 'percent'));
  }

  // Active properties (S15-01: the drill-down lists exactly the counted records).
  if (property === undefined) {
    kpis.push(unavailable(sources, 'properties', ['property']));
  } else {
    const active = property.properties.filter((entry) => entry.lifecycleState === 'ACTIVE');
    kpis.push({
      ...kpiBase(sources, 'properties', ['property']),
      kind: 'count',
      rows: active.map((entry) => ({
        href: `/nemovitosti?resourceId=${encodeURIComponent(entry.propertyRef.resourceId)}`,
        id: entry.propertyRef.resourceId,
        status: 'lifecycle.ACTIVE',
        subtitle: entry.address,
        title: `${entry.name} (${entry.code})`,
        tone: 'success',
      })),
      secondary: {
        disposed: property.properties.filter(
          (entry) => entry.lifecycleState === 'DISPOSED' || entry.lifecycleState === 'INACTIVE',
        ).length,
        units: property.units.filter((unit) => unit.lifecycleState === 'ACTIVE').length,
      },
      tone: 'success',
      value: active.length,
    });
  }

  // Active leases: occupancies in state ACTIVE today; CONFIRMED (future) shown separately.
  if (occupancy === undefined) {
    kpis.push(unavailable(sources, 'leases', ['occupancy']));
  } else {
    const active = occupancy.occupancies.filter(
      (entry) =>
        entry.state === 'ACTIVE' && entry.startDate <= today && (entry.endDate === null || today < entry.endDate),
    );
    const confirmed = occupancy.occupancies.filter((entry) => entry.state === 'CONFIRMED' && entry.startDate > today);
    kpis.push({
      ...kpiBase(sources, 'leases', ['occupancy']),
      kind: 'count',
      rows: active.map((entry) => ({
        date: entry.endDate ?? entry.startDate,
        href: `/najmy?resourceId=${encodeURIComponent(entry.occupancyRef.resourceId)}`,
        id: entry.occupancyRef.resourceId,
        status: `lease.${entry.state}`,
        subtitle:
          entry.customerCounterpartyRef === null ? undefined : names.get(entry.customerCounterpartyRef.resourceId),
        title: names.get(entry.unitRef.resourceId) ?? entry.unitRef.resourceId,
        tone: entry.state === 'ACTIVE' ? 'success' : 'warning',
      })),
      secondary: { confirmed: confirmed.length },
      tone: 'success',
      value: active.length,
    });
  }

  return kpis;
};

export const buildKpis = (input: KpiInput): Kpi[] => {
  const { deadlines, names, sources, today } = input;
  const work = sources.work.data;
  const finance = sources.finance.data;
  const agreements = sources.agreements.data;
  const ops = sources.ops.data;
  const kpis = propertyKpis(input);

  // Overdue invoices: confirmed, unpaid, due before today (both directions).
  if (finance === undefined) {
    kpis.push(unavailable(sources, 'overdueInvoices', ['finance']));
  } else {
    const overdue = finance.state.invoices.filter((invoice) => isOpenInvoice(invoice) && invoice.dueDate < today);
    kpis.push({
      ...kpiBase(sources, 'overdueInvoices', ['finance']),
      kind: 'count',
      rows: overdue
        .toSorted((left, right) => left.dueDate.localeCompare(right.dueDate))
        .map((invoice) => ({
          amountMinor: outstandingMinor(invoice),
          date: invoice.dueDate,
          href: `/finance?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`,
          id: invoice.ref.resourceId,
          status: `direction.${invoice.direction}`,
          subtitle: invoice.counterpartyName ?? names.get(invoice.counterpartyRef.resourceId),
          title: invoice.number ?? invoice.documentNumber,
          tone: 'danger',
        })),
      secondary: { amountMinor: overdue.reduce((sum, invoice) => sum + outstandingMinor(invoice), 0) },
      tone: overdue.length === 0 ? 'success' : 'danger',
      value: overdue.length,
    });
  }

  // Open tasks: NEW / IN_PROGRESS / WAITING; overdue = due before today.
  if (work === undefined) {
    kpis.push(unavailable(sources, 'openTasks', ['work']));
  } else {
    const open = work.items.filter((task) => !['DONE', 'CANCELLED'].includes(task.state));
    const overdue = open.filter((task) => task.dueDate !== undefined && task.dueDate < today);
    kpis.push({
      ...kpiBase(sources, 'openTasks', ['work']),
      kind: 'count',
      rows: open
        .toSorted((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'))
        .map((task) => ({
          ...optionalField('date', task.dueDate),
          href: `/ukoly?resourceId=${encodeURIComponent(task.ref.resourceId)}`,
          id: task.ref.resourceId,
          status: `task.${task.state}`,
          subtitle: task.contextRefs.map((ref) => names.get(ref.resourceId)).find((label) => label !== undefined),
          title: task.title,
          tone: taskTone(task.dueDate, task.priority, today),
        })),
      secondary: { overdue: overdue.length },
      tone: overdue.length > 0 ? 'warning' : 'primary',
      value: open.length,
    });
  }

  // Open incidents: unresolved incidents/faults of the provoz agendas (security needs read_all).
  if (ops?.incidents === undefined) {
    const base = unavailable(sources, 'incidents', ['ops']);
    kpis.push(ops === undefined ? base : { ...base, status: 'forbidden' });
  } else {
    const { incidents } = ops;
    kpis.push({
      ...kpiBase(sources, 'incidents', ['ops']),
      kind: 'count',
      rows: incidents.map((incident) => ({
        href: `/provoz/${opsSegmentOf(incident.agenda)}`,
        id: incident.id,
        status: 'incident.OPEN',
        ...optionalField('subtitle', incident.location),
        title: incident.title,
        tone: 'danger',
      })),
      tone: incidents.length === 0 ? 'success' : 'danger',
      value: incidents.length,
    });
  }

  // Upcoming deadlines (next 30 days, open) from every readable source.
  const readable = sourceKeys.filter((key) => sources[key].status === 'ready');
  const horizon = addDays(today, 30);
  const upcoming = deadlines.filter((row) => !row.done && row.date >= today && row.date <= horizon);
  kpis.push({
    ...kpiBase(sources, 'deadlines', readable),
    kind: 'count',
    rows: upcoming.map((row) => ({
      date: row.date,
      href: row.href,
      id: row.key,
      status: `category.${row.category}`,
      ...optionalField('subtitle', row.location),
      title: row.title,
      tone: daysUntil(row.date, today) <= 7 ? 'warning' : 'info',
    })),
    secondary: { week: upcoming.filter((row) => daysUntil(row.date, today) <= 7).length },
    status: readable.length === 0 ? combinedStatus(sources, sourceKeys) : 'ready',
    tone: 'info',
    ...optionalField('value', readable.length === 0 ? undefined : upcoming.length),
  });

  // Contracts ending within 60 days (ACTIVE with an end date).
  if (agreements === undefined) {
    kpis.push(unavailable(sources, 'contracts', ['agreements']));
  } else {
    const limit = addDays(today, 60);
    const ending = agreements.contracts.filter(
      (contract) => contract.lifecycleState === 'ACTIVE' && contract.endDate !== null && contract.endDate <= limit,
    );
    kpis.push({
      ...kpiBase(sources, 'contracts', ['agreements']),
      kind: 'count',
      rows: ending.map((contract) => ({
        ...optionalField('date', contract.endDate ?? undefined),
        href: `/smlouvy?resourceId=${encodeURIComponent(contract.contractRef.resourceId)}`,
        id: contract.contractRef.resourceId,
        status: contract.endDate !== null && contract.endDate < today ? 'contract.EXPIRED' : 'contract.ENDING',
        subtitle: [
          contract.unitRef === null ? undefined : names.get(contract.unitRef.resourceId),
          contract.renewalNoticeDate === null ? undefined : `výpověď do ${contract.renewalNoticeDate}`,
        ]
          .filter((part) => part !== undefined)
          .join(' · '),
        title: names.get(contract.counterpartyRef.resourceId) ?? contract.subject ?? contract.contractRef.resourceId,
        tone: 'warning',
      })),
      secondary: { active: agreements.contracts.filter((contract) => contract.lifecycleState === 'ACTIVE').length },
      tone: ending.length === 0 ? 'success' : 'warning',
      value: ending.length,
    });
  }

  // Open sales cases: opportunities not won, lost or archived (sales pipeline, filtered to what the person may read).
  const sales = sources.sales.data;
  if (sales === undefined) {
    kpis.push(unavailable(sources, 'salesCases', ['sales']));
  } else {
    const open = sales.items
      .filter(isOpenSalesCase)
      .toSorted((left, right) => left.expectedCloseDate.localeCompare(right.expectedCloseDate));
    const value = open.reduce((sum, entry) => sum + entry.amountMinor, 0);
    const weighted = open.reduce((sum, entry) => sum + Math.round((entry.amountMinor * entry.probability) / 100), 0);
    kpis.push({
      ...kpiBase(sources, 'salesCases', ['sales']),
      kind: 'count',
      rows: open.map((entry) => ({
        amountMinor: entry.amountMinor,
        date: entry.expectedCloseDate,
        href: `/prodej/prilezitosti?resourceId=${encodeURIComponent(entry.id)}`,
        id: entry.id,
        status: `sales.${entry.stage}`,
        subtitle: names.get(entry.partyId),
        title: entry.title,
        tone: entry.expectedCloseDate < today ? 'warning' : 'info',
      })),
      secondary: { value: formatMoney(value), weighted: formatMoney(weighted) },
      tone: 'info',
      value: open.length,
    });
  }

  // Plan vs actual (year to date): budget lines of finance; the actual is the manually confirmed amount, otherwise
  // the confirmed invoices of that month, category, direction and object (same rule as Finance › Rozpočet).
  if (finance === undefined) {
    kpis.push(unavailable(sources, 'planActual', ['finance'], 'percent'));
  } else {
    const year = today.slice(0, 4);
    const month = today.slice(0, 7);
    const { invoices } = finance.state;
    const lines = (finance.state.budgets ?? []).filter((line) => line.period.startsWith(year) && line.period <= month);
    const actualOf = (line: (typeof lines)[number]) =>
      line.actualManualMinor ??
      invoices
        .filter(
          (invoice) =>
            invoice.businessState === 'CONFIRMED' &&
            invoice.budgetCategory === line.category &&
            invoice.issueDate.slice(0, 7) === line.period &&
            invoice.direction === (line.kind === 'COST' ? 'INCOMING' : 'OUTGOING') &&
            (line.propertyRef === undefined || invoice.propertyRef?.resourceId === line.propertyRef.resourceId) &&
            (line.unitRef === undefined || invoice.unitRef?.resourceId === line.unitRef.resourceId) &&
            (line.costCenter === undefined || invoice.costCenter === line.costCenter),
        )
        .reduce((sum, invoice) => sum + invoice.totalMinor, 0);
    const totals = (kind: 'COST' | 'REVENUE') => {
      const ofKind = lines.filter((line) => line.kind === kind);
      return {
        actual: ofKind.reduce((sum, line) => sum + actualOf(line), 0),
        plan: ofKind.reduce((sum, line) => sum + line.plannedMinor, 0),
      };
    };
    const cost = totals('COST');
    const revenue = totals('REVENUE');
    kpis.push({
      ...kpiBase(sources, 'planActual', ['finance']),
      kind: 'percent',
      rows: lines
        .toSorted(
          (left, right) => right.period.localeCompare(left.period) || left.category.localeCompare(right.category),
        )
        .map((line) => {
          const actual = actualOf(line);
          const difference = actual - line.plannedMinor;
          return {
            amountMinor: actual,
            date: `${line.period}-01`,
            href: '/finance?tab=plan',
            id: line.id,
            status: `budget.${line.kind}`,
            subtitle: `${line.period} · plán ${formatMoney(line.plannedMinor)} · rozdíl ${difference > 0 ? '+' : ''}${formatMoney(difference)}${line.actualManualMinor === undefined ? '' : ' · ručně potvrzeno'}`,
            title: [line.category, line.propertyRef === undefined ? undefined : names.get(line.propertyRef.resourceId)]
              .filter((part) => part !== undefined)
              .join(' · '),
            tone: budgetTone(line.kind, difference),
          };
        }),
      secondary: {
        costActual: formatMoney(cost.actual),
        costPlan: formatMoney(cost.plan),
        revenueActual: formatMoney(revenue.actual),
        revenuePlan: formatMoney(revenue.plan),
      },
      tone: cost.actual > cost.plan ? 'warning' : 'success',
      ...optionalField('value', cost.plan === 0 ? undefined : cost.actual / cost.plan),
    });
  }
  return kpis;
};

// ---- Search ------------------------------------------------------------------------------------------------------

export const SearchKindSchema = Schema.Literals([
  'property',
  'unit',
  'asset',
  'contract',
  'lease',
  'task',
  'invoice',
  'party',
  'event',
  'ops',
]);
export type SearchKind = typeof SearchKindSchema.Type;

export interface SearchRow {
  readonly href: string;
  readonly id: string;
  readonly kind: SearchKind;
  readonly source: SourceKey;
  readonly subtitle?: string;
  /** Folded text (no diacritics, lower case) the query is matched against. */
  readonly text: string;
  readonly title: string;
}

const row = (entry: Omit<SearchRow, 'text'>, ...extra: readonly (string | null | undefined)[]): SearchRow => ({
  ...entry,
  text: foldSearchText(
    [entry.title, entry.subtitle, entry.id, ...extra].filter((part) => part !== undefined && part !== null).join(' '),
  ),
});

const opt = (key: 'subtitle', value: string | null | undefined) =>
  value === null || value === undefined || value === '' ? {} : { [key]: value };

const propertyAndContractSearchRows = (
  sources: RentalOverviewSources,
  names: ReadonlyMap<string, string>,
): SearchRow[] => {
  const rows: SearchRow[] = [];
  const property = sources.property.data;
  if (property !== undefined) {
    for (const entry of property.properties) {
      rows.push(
        row(
          {
            href: `/nemovitosti?resourceId=${entry.propertyRef.resourceId}`,
            id: entry.propertyRef.resourceId,
            kind: 'property',
            source: 'property',
            title: entry.name,
            ...opt('subtitle', entry.address),
          },
          entry.code,
        ),
      );
    }
    for (const unit of property.units) {
      rows.push(
        row(
          {
            href: `/nemovitosti?resourceId=${unit.unitRef.resourceId}`,
            id: unit.unitRef.resourceId,
            kind: 'unit',
            source: 'property',
            title: `${unit.name} (${unit.code})`,
            ...opt('subtitle', names.get(unit.propertyRef.resourceId)),
          },
          unit.unitKind,
        ),
      );
    }
    for (const asset of property.assets) {
      rows.push(
        row(
          {
            href: `/nemovitosti?resourceId=${asset.propertyRef.resourceId}`,
            id: asset.assetRef.resourceId,
            kind: 'asset',
            source: 'property',
            title: `${asset.name} (${asset.code})`,
            ...opt('subtitle', names.get(asset.propertyRef.resourceId)),
          },
          asset.category,
          asset.serialNumber,
        ),
      );
    }
  }
  for (const contract of sources.agreements.data?.contracts ?? []) {
    const party = names.get(contract.counterpartyRef.resourceId);
    const contractId = contract.contractRef.resourceId;
    rows.push(
      row(
        {
          href: `/smlouvy?resourceId=${contractId}`,
          id: contractId,
          kind: 'contract',
          source: 'agreements',
          title: party ?? contract.subject ?? contractId,
          ...opt(
            'subtitle',
            [contract.unitRef === null ? undefined : names.get(contract.unitRef.resourceId), contract.subject]
              .filter(Boolean)
              .join(' · '),
          ),
        },
        contract.subject,
        contract.responsiblePerson,
      ),
    );
  }
  return rows;
};

const occupancySearchRows = (sources: RentalOverviewSources, names: ReadonlyMap<string, string>): SearchRow[] => {
  const rows: SearchRow[] = [];
  for (const entry of sources.occupancy.data?.occupancies ?? []) {
    rows.push(
      row(
        {
          href: `/najmy?resourceId=${entry.occupancyRef.resourceId}`,
          id: entry.occupancyRef.resourceId,
          kind: 'lease',
          source: 'occupancy',
          title: names.get(entry.unitRef.resourceId) ?? entry.unitRef.resourceId,
          ...opt(
            'subtitle',
            [
              entry.customerCounterpartyRef === null ? undefined : names.get(entry.customerCounterpartyRef.resourceId),
              `${entry.startDate} – ${entry.endDate ?? '…'}`,
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        },
        entry.note,
      ),
    );
  }
  return rows;
};

/** Index of every record the person can read. Unreadable sources contribute nothing (and are reported). */
export const buildSearchIndex = (sources: RentalOverviewSources, names: ReadonlyMap<string, string>): SearchRow[] => {
  const rows = propertyAndContractSearchRows(sources, names);
  rows.push(...occupancySearchRows(sources, names));
  for (const task of sources.work.data?.items ?? []) {
    rows.push(
      row(
        {
          href: `/ukoly?resourceId=${task.ref.resourceId}`,
          id: task.ref.resourceId,
          kind: 'task',
          source: 'work',
          title: task.title,
          ...opt('subtitle', task.dueDate),
        },
        task.description,
      ),
    );
  }
  for (const invoice of sources.finance.data?.state.invoices ?? []) {
    rows.push(
      row(
        {
          href: `/finance?resourceId=${invoice.ref.resourceId}`,
          id: invoice.ref.resourceId,
          kind: 'invoice',
          source: 'finance',
          title: invoice.number ?? invoice.documentNumber,
          ...opt('subtitle', invoice.counterpartyName ?? names.get(invoice.counterpartyRef.resourceId)),
        },
        invoice.documentNumber,
        invoice.note,
      ),
    );
  }
  for (const customer of sources.parties.data ?? []) {
    rows.push(
      row(
        {
          href: '/prodej/zakaznici',
          id: customer.counterpartyId,
          kind: 'party',
          source: 'parties',
          title: customer.displayName ?? customer.counterpartyId,
          ...opt('subtitle', [customer.companyId, customer.city].filter(Boolean).join(' · ')),
        },
        customer.email,
        customer.vatId,
      ),
    );
  }
  // Calendar events and provoz records: rows built by the overview read on the server, folded here.
  for (const entry of sources.ops.data?.searchRows ?? []) {
    const { terms, ...rest } = entry;
    rows.push(row({ ...rest, source: 'ops' }, terms));
  }
  return rows;
};

/** Diacritics- and case-insensitive AND match of all query words. */
export const searchRows = (index: readonly SearchRow[], query: string, limit = 60) => {
  const words = foldSearchText(query)
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  return index.filter((entry) => words.every((word) => entry.text.includes(word))).slice(0, limit);
};

/** Session names that only identify a role do not identify a person for a personal greeting. */
export const personalGreetingName = (displayName: string | undefined): string | undefined => {
  const name = displayName?.trim();
  if (
    name === undefined ||
    name === '' ||
    /^(?:vedení|provoz|účetní|externí|správce|admin|management|operations|finance|sales|expedice|e-shop|obchodník|moje úkoly)(?:\s|$)/iu.test(
      name,
    )
  ) {
    return undefined;
  }
  return name;
};

/** Names and references already visible to this actor, never a role/fixture directory or an authorization grant. */
export const agendaPeople = (state: AgendaState | undefined, context?: ModulePageContext) => {
  const people = new Map<
    string,
    { readonly displayName: string; readonly principalId: string; readonly tenantId: string }
  >();
  if (context === undefined) {
    return [];
  }
  for (const event of state?.events ?? []) {
    if (
      event.assignee?.tenantId === context.tenantId &&
      event.assigneeLabel !== undefined &&
      event.assigneeLabel.trim() !== ''
    ) {
      people.set(event.assignee.principalId, { ...event.assignee, displayName: event.assigneeLabel.trim() });
    }
  }
  if (context.displayName !== undefined && context.displayName.trim() !== '') {
    people.set(context.principalId, {
      displayName: context.displayName.trim(),
      principalId: context.principalId,
      tenantId: context.tenantId,
    });
  }
  return [...people.values()];
};
