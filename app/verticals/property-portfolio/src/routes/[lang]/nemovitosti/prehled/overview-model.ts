import { formatCzechDays } from '@app/shared-contracts';
import type { executeRecords as executeAgreements } from '@app/legal-agreements/clients/records';
import type { executeRecords as executeFinance } from '@app/finance-billing/clients/records';
import type { executeRecords as executeOccupancy } from '@app/property-leasing/clients/records';
import type { executeRecords as executeWork } from '@app/work-tasks/clients/records';
import { DateTime, Schema } from 'effect';
import type { Effect } from 'effect';
import type { executeRecords as executeProperty } from '../../../../api/records-client';

export type PropertyRecords = Effect.Success<ReturnType<typeof executeProperty>>;
export type AgreementsRecords = Effect.Success<ReturnType<typeof executeAgreements>>;
export type FinanceRecords = Effect.Success<ReturnType<typeof executeFinance>>;
export type OccupancyRecords = Effect.Success<ReturnType<typeof executeOccupancy>>;
export type WorkRecords = Effect.Success<ReturnType<typeof executeWork>>;

/** One governed source: loaded, refused by Core, or unavailable. Never silently replaced by zeros. */
export type Source<A> =
  | { readonly data: A; readonly status: 'ready' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' };

export interface OverviewSources {
  readonly agreements: Source<AgreementsRecords>;
  readonly finance: Source<FinanceRecords>;
  readonly occupancy: Source<OccupancyRecords>;
  readonly property: Source<PropertyRecords>;
  readonly work: Source<WorkRecords>;
}

export const readyData = <A>(source: Source<A>): A | undefined => (source.status === 'ready' ? source.data : undefined);

const money = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
export const formatCzk = (minor: number) => money.format(Math.round(minor / 100));
const dayFormat = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  timeZone: 'UTC',
  year: 'numeric',
});
export const formatDay = (value: string | null | undefined) =>
  value === null || value === undefined || value === ''
    ? '—'
    : dayFormat.format(DateTime.toEpochMillis(DateTime.makeUnsafe(`${value}T00:00:00Z`)));

export const addDays = (isoDate: string, days: number) =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${isoDate}T00:00:00Z`), { days }));
export const daysBetween = (from: string, to: string) =>
  Math.round(
    (DateTime.toEpochMillis(DateTime.makeUnsafe(`${to}T00:00:00Z`)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(`${from}T00:00:00Z`))) /
      86_400_000,
  );

const UnitAvailabilitySchema = Schema.Literals(['OCCUPIED', 'RESERVED', 'AVAILABLE', 'OUT_OF_SERVICE']);
export type UnitAvailability = typeof UnitAvailabilitySchema.Type;

export const unitAvailability = (
  unit: PropertyRecords['units'][number],
  occupancy: OccupancyRecords | undefined,
  today: string,
): UnitAvailability => {
  if (unit.lifecycleState !== 'ACTIVE') {
    return 'OUT_OF_SERVICE';
  }
  const current = (occupancy?.occupancies ?? []).filter(
    (item) =>
      item.unitRef.resourceId === unit.unitRef.resourceId &&
      item.startDate <= today &&
      (item.endDate === null || today < item.endDate),
  );
  if (current.some((item) => item.state === 'ACTIVE')) {
    return 'OCCUPIED';
  }
  if (current.some((item) => item.state === 'CONFIRMED')) {
    return 'RESERVED';
  }
  return 'AVAILABLE';
};

export const availabilityLabel = {
  AVAILABLE: 'Volno',
  OCCUPIED: 'Obsazeno',
  OUT_OF_SERVICE: 'Mimo provoz',
  RESERVED: 'Rezervováno',
} as const satisfies Record<UnitAvailability, string>;

export const isOpenTask = (task: WorkRecords['items'][number]) => !['DONE', 'CANCELLED'].includes(task.state);
export const isOpenInvoice = (invoice: FinanceRecords['state']['invoices'][number]) =>
  invoice.businessState === 'CONFIRMED' && invoice.paidMinor < invoice.totalMinor;
export const isOverdueInvoice = (invoice: FinanceRecords['state']['invoices'][number], today: string) =>
  isOpenInvoice(invoice) && invoice.dueDate < today;

export const unitLabel = (property: PropertyRecords | undefined, unitId: string | undefined | null) => {
  const unit =
    unitId === undefined || unitId === null
      ? undefined
      : property?.units.find((item) => item.unitRef.resourceId === unitId);
  const parent =
    unit === undefined
      ? undefined
      : property?.properties.find((item) => item.propertyRef.resourceId === unit.propertyRef.resourceId);
  const parentLabel = parent === undefined ? '' : ` · ${parent.name}`;
  return unit === undefined ? undefined : `${unit.name} ${unit.code}${parentLabel}`;
};

export interface SourceRow {
  readonly badge?: string;
  readonly detail: string;
  readonly href: string;
  readonly id: string;
  readonly label: string;
  readonly tone?: 'danger' | 'warning' | 'success' | 'info' | 'outline';
}

export interface AttentionItem {
  readonly date: string;
  readonly detail: string;
  readonly href: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly tone: 'danger' | 'warning' | 'info';
}

const invoiceAttention = (finance: FinanceRecords | undefined, today: string, lang: string): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const invoice of finance?.state.invoices ?? []) {
    if (isOverdueInvoice(invoice, today)) {
      const counterparty = invoice.counterpartyName === undefined ? '' : ` · ${invoice.counterpartyName}`;
      items.push({
        date: invoice.dueDate,
        detail: `${invoice.direction === 'OUTGOING' ? 'Pohledávka' : 'Závazek'} ${formatCzk(invoice.totalMinor - invoice.paidMinor)} · ${formatCzechDays(daysBetween(invoice.dueDate, today))} po splatnosti`,
        href: `/${lang}/finance?resourceId=${invoice.ref.resourceId}`,
        id: `invoice:${invoice.ref.resourceId}`,
        kind: invoice.direction === 'OUTGOING' ? 'Vydaná faktura' : 'Přijatá faktura',
        label: `${invoice.documentNumber}${counterparty}`,
        tone: 'danger',
      });
    }
  }
  return items;
};

const taskAttention = (work: WorkRecords | undefined, today: string, lang: string): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const task of work?.items ?? []) {
    if (isOpenTask(task) && task.dueDate !== undefined && task.dueDate < today) {
      items.push({
        date: task.dueDate,
        detail: `Termín ${formatDay(task.dueDate)} · ${formatCzechDays(daysBetween(task.dueDate, today))} po termínu`,
        href: `/${lang}/ukoly`,
        id: `task:${task.ref.resourceId}`,
        kind: 'Úkol po termínu',
        label: task.title,
        tone: 'danger',
      });
    }
  }
  return items;
};

const contractAttention = (
  agreements: AgreementsRecords | undefined,
  property: PropertyRecords | undefined,
  today: string,
  horizon: string,
  lang: string,
): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const contract of agreements?.contracts ?? []) {
    if (contract.lifecycleState !== 'ACTIVE') {
      continue;
    }
    const unit = unitLabel(property, contract.unitRef?.resourceId) ?? contract.subject ?? 'Smlouva';
    const contractId = contract.contractRef.resourceId;
    if (
      contract.renewalNoticeDate !== null &&
      contract.renewalNoticeDate >= today &&
      contract.renewalNoticeDate <= horizon
    ) {
      items.push({
        date: contract.renewalNoticeDate,
        detail: `Výpovědní / prodlužovací lhůta ${formatDay(contract.renewalNoticeDate)} · za ${formatCzechDays(daysBetween(today, contract.renewalNoticeDate))}`,
        href: `/${lang}/smlouvy?resourceId=${contractId}`,
        id: `notice:${contractId}`,
        kind: 'Lhůta smlouvy',
        label: unit,
        tone: 'warning',
      });
    }
    if (contract.endDate !== null && contract.endDate >= today && contract.endDate <= horizon) {
      items.push({
        date: contract.endDate,
        detail: `Konec platnosti ${formatDay(contract.endDate)} · za ${formatCzechDays(daysBetween(today, contract.endDate))}${contract.hasSuccessorDraft ? ' · návrh navazující smlouvy existuje' : ' · bez navazující smlouvy'}`,
        href: `/${lang}/smlouvy?resourceId=${contractId}`,
        id: `end:${contractId}`,
        kind: 'Končící smlouva',
        label: unit,
        tone: contract.hasSuccessorDraft ? 'info' : 'warning',
      });
    }
  }
  return items;
};

const leaseAttention = (
  occupancy: OccupancyRecords | undefined,
  property: PropertyRecords | undefined,
  today: string,
  horizon: string,
  lang: string,
): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const lease of occupancy?.occupancies ?? []) {
    if (lease.state === 'CONFIRMED' && lease.startDate >= today && lease.startDate <= horizon) {
      items.push({
        date: lease.startDate,
        detail: `Začátek ${formatDay(lease.startDate)} · za ${formatCzechDays(daysBetween(today, lease.startDate))}`,
        href: `/${lang}/najmy?resourceId=${lease.occupancyRef.resourceId}`,
        id: `lease:${lease.occupancyRef.resourceId}`,
        kind: lease.kind === 'SHORT_STAY' ? 'Nástup pobytu' : 'Nástup nájemce',
        label: unitLabel(property, lease.unitRef.resourceId) ?? 'Jednotka',
        tone: 'info',
      });
    }
  }
  return items;
};

/** Items management should act on, newest risk first: overdue money and work, then expiring contracts. */
export const attentionItems = (sources: OverviewSources, today: string, lang: string): AttentionItem[] => {
  const property = readyData(sources.property);
  const horizon = addDays(today, 60);
  const items = [
    ...invoiceAttention(readyData(sources.finance), today, lang),
    ...taskAttention(readyData(sources.work), today, lang),
    ...contractAttention(readyData(sources.agreements), property, today, horizon, lang),
    ...leaseAttention(readyData(sources.occupancy), property, today, horizon, lang),
  ];
  const toneRank = { danger: 0, info: 2, warning: 1 } as const;
  return items.toSorted((a, b) => toneRank[a.tone] - toneRank[b.tone] || a.date.localeCompare(b.date));
};

export interface SearchHit {
  readonly closed: boolean;
  readonly detail: string;
  readonly href: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** S15: search only inside records the governed reads returned for this person; nothing else is queried. */
type AppendSearchHit = (hit: SearchHit, haystack: readonly (string | null | undefined)[]) => void;

const searchProperties = (property: PropertyRecords | undefined, lang: string, push: AppendSearchHit) => {
  for (const item of property?.properties ?? []) {
    push(
      {
        closed: item.lifecycleState !== 'ACTIVE',
        detail: item.address,
        href: `/${lang}/nemovitosti?resourceId=${item.propertyRef.resourceId}`,
        id: `p:${item.propertyRef.resourceId}`,
        kind: 'Nemovitost',
        label: `${item.name} (${item.code})`,
      },
      [item.name, item.code, item.address, item.note],
    );
  }
};

const searchUnits = (
  property: PropertyRecords | undefined,
  occupancy: OccupancyRecords | undefined,
  lang: string,
  push: AppendSearchHit,
) => {
  for (const unit of property?.units ?? []) {
    const unitId = unit.unitRef.resourceId;
    push(
      {
        closed: unit.lifecycleState !== 'ACTIVE',
        detail: availabilityLabel[unitAvailability(unit, occupancy, DateTime.formatIsoDate(DateTime.nowUnsafe()))],
        href: `/${lang}/nemovitosti?resourceId=${unitId}`,
        id: `u:${unitId}`,
        kind: 'Jednotka',
        label: unitLabel(property, unitId) ?? unit.code,
      },
      [unit.name, unit.code, unit.unitKind, unit.note],
    );
  }
};

const searchAssets = (property: PropertyRecords | undefined, lang: string, push: AppendSearchHit) => {
  for (const asset of property?.assets ?? []) {
    const service = asset.nextServiceAt === null ? '' : ` · příští servis ${formatDay(asset.nextServiceAt)}`;
    push(
      {
        closed: asset.lifecycleState !== 'ACTIVE',
        detail: `${asset.category}${service}`,
        href: `/${lang}/nemovitosti?resourceId=${asset.propertyRef.resourceId}`,
        id: `a:${asset.assetRef.resourceId}`,
        kind: 'Vybavení',
        label: `${asset.name} (${asset.code})`,
      },
      [asset.name, asset.code, asset.category, asset.serialNumber],
    );
  }
};

const searchContracts = (
  agreements: AgreementsRecords | undefined,
  property: PropertyRecords | undefined,
  lang: string,
  push: AppendSearchHit,
) => {
  for (const contract of agreements?.contracts ?? []) {
    const unit = unitLabel(property, contract.unitRef?.resourceId);
    push(
      {
        closed: ['TERMINATED', 'EXPIRED'].includes(contract.lifecycleState),
        detail: `${formatDay(contract.startDate)} – ${contract.endDate === null ? 'na dobu neurčitou' : formatDay(contract.endDate)}`,
        href: `/${lang}/smlouvy?resourceId=${contract.contractRef.resourceId}`,
        id: `c:${contract.contractRef.resourceId}`,
        kind: 'Smlouva',
        label: contract.subject ?? unit ?? 'Smlouva',
      },
      [contract.subject, unit, contract.note, contract.responsiblePerson],
    );
  }
};

const searchLeases = (
  occupancy: OccupancyRecords | undefined,
  property: PropertyRecords | undefined,
  lang: string,
  push: AppendSearchHit,
) => {
  for (const lease of occupancy?.occupancies ?? []) {
    const unit = unitLabel(property, lease.unitRef.resourceId);
    const rent = lease.rentTerms === undefined ? '' : ` · ${formatCzk(lease.rentTerms.monthlyRentMinor)} / měs.`;
    push(
      {
        closed: ['COMPLETED', 'CANCELLED'].includes(lease.state),
        detail: `${formatDay(lease.startDate)} – ${lease.endDate === null ? 'neurčito' : formatDay(lease.endDate)}${rent}`,
        href: `/${lang}/najmy?resourceId=${lease.occupancyRef.resourceId}`,
        id: `o:${lease.occupancyRef.resourceId}`,
        kind: lease.kind === 'SHORT_STAY' ? 'Pobyt' : 'Nájem',
        label: unit ?? 'Jednotka',
      },
      [unit, lease.note],
    );
  }
};

const searchInvoices = (finance: FinanceRecords | undefined, lang: string, push: AppendSearchHit) => {
  for (const invoice of finance?.state.invoices ?? []) {
    const counterparty = invoice.counterpartyName === undefined ? '' : ` · ${invoice.counterpartyName}`;
    push(
      {
        closed: invoice.businessState === 'VOIDED' || invoice.paymentState === 'PAID',
        detail: `${invoice.direction === 'OUTGOING' ? 'vydaná' : 'přijatá'} · ${formatCzk(invoice.totalMinor)} · splatnost ${formatDay(invoice.dueDate)}`,
        href: `/${lang}/finance?resourceId=${invoice.ref.resourceId}`,
        id: `i:${invoice.ref.resourceId}`,
        kind: 'Faktura',
        label: `${invoice.documentNumber}${counterparty}`,
      },
      [
        invoice.documentNumber,
        invoice.number,
        invoice.counterpartyName,
        invoice.note,
        ...(invoice.lines ?? []).map((line) => line.description),
      ],
    );
  }
};

const searchTasks = (work: WorkRecords | undefined, lang: string, push: AppendSearchHit) => {
  for (const task of work?.items ?? []) {
    push(
      {
        closed: !isOpenTask(task),
        detail: task.dueDate === undefined ? 'bez termínu' : `termín ${formatDay(task.dueDate)}`,
        href: `/${lang}/ukoly`,
        id: `t:${task.ref.resourceId}`,
        kind: 'Úkol',
        label: task.title,
      },
      [task.title, task.description],
    );
  }
};

export const searchRentalOverview = (sources: OverviewSources, query: string, lang: string, includeClosed: boolean) => {
  const needle = fold(query.trim());
  if (needle.length < 2) {
    return [];
  }
  const property = readyData(sources.property);
  const finance = readyData(sources.finance);
  const work = readyData(sources.work);
  const agreements = readyData(sources.agreements);
  const occupancy = readyData(sources.occupancy);
  const hits: SearchHit[] = [];
  const push = (hit: SearchHit, haystack: readonly (string | null | undefined)[]) => {
    if (
      (includeClosed || !hit.closed) &&
      haystack.some((value) => value !== null && value !== undefined && fold(value).includes(needle))
    ) {
      hits.push(hit);
    }
  };
  searchProperties(property, lang, push);
  searchUnits(property, occupancy, lang, push);
  searchAssets(property, lang, push);
  searchContracts(agreements, property, lang, push);
  searchLeases(occupancy, property, lang, push);
  searchInvoices(finance, lang, push);
  searchTasks(work, lang, push);
  return hits.slice(0, 60);
};
