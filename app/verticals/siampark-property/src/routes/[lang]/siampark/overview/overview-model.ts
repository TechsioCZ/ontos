import type { executeRecords as executeAgreements } from '@app/siampark-agreements/clients/records';
import type { executeRecords as executeFinance } from '@app/siampark-billing-finance/clients/records';
import type { executeRecords as executeOccupancy } from '@app/siampark-occupancy/clients/records';
import type { executeRecords as executeWork } from '@app/siampark-work/clients/records';
import { DateTime, type Effect } from 'effect';
import type { executeRecords as executeProperty } from '../../../../api/records-client';

export type PropertyRecords = Effect.Success<ReturnType<typeof executeProperty>>;
export type AgreementsRecords = Effect.Success<ReturnType<typeof executeAgreements>>;
export type FinanceRecords = Effect.Success<ReturnType<typeof executeFinance>>;
export type OccupancyRecords = Effect.Success<ReturnType<typeof executeOccupancy>>;
export type WorkRecords = Effect.Success<ReturnType<typeof executeWork>>;

/** One governed source: loaded, refused by Core, or unavailable. Never silently replaced by zeros. */
export type Source<A> =
  | { readonly status: 'ready'; readonly data: A }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' };

export interface OverviewSources {
  readonly agreements: Source<AgreementsRecords>;
  readonly finance: Source<FinanceRecords>;
  readonly occupancy: Source<OccupancyRecords>;
  readonly property: Source<PropertyRecords>;
  readonly work: Source<WorkRecords>;
}

export const readyData = <A>(source: Source<A>): A | undefined =>
  source.status === 'ready' ? source.data : undefined;

const money = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
export const formatCzk = (minor: number) => money.format(Math.round(minor / 100));
const dayFormat = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', timeZone: 'UTC', year: 'numeric' });
export const formatDay = (value: string | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : dayFormat.format(DateTime.toEpochMillis(DateTime.makeUnsafe(`${value}T00:00:00Z`)));

export const addDays = (isoDate: string, days: number) =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${isoDate}T00:00:00Z`), { days }));
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type UnitAvailability = 'OCCUPIED' | 'RESERVED' | 'AVAILABLE' | 'OUT_OF_SERVICE';

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

export const availabilityLabel: Record<UnitAvailability, string> = {
  AVAILABLE: 'Volno',
  OCCUPIED: 'Obsazeno',
  OUT_OF_SERVICE: 'Mimo provoz',
  RESERVED: 'Rezervováno',
};

export const isOpenTask = (task: WorkRecords['items'][number]) => !['DONE', 'CANCELLED'].includes(task.state);
export const isOpenInvoice = (invoice: FinanceRecords['state']['invoices'][number]) =>
  invoice.businessState === 'CONFIRMED' && invoice.paidMinor < invoice.totalMinor;
export const isOverdueInvoice = (invoice: FinanceRecords['state']['invoices'][number], today: string) =>
  isOpenInvoice(invoice) && invoice.dueDate < today;

export const unitLabel = (property: PropertyRecords | undefined, unitId: string | undefined | null) => {
  if (unitId === undefined || unitId === null) {
    return undefined;
  }
  const unit = property?.units.find((item) => item.unitRef.resourceId === unitId);
  if (unit === undefined) {
    return undefined;
  }
  const parent = property?.properties.find((item) => item.propertyRef.resourceId === unit.propertyRef.resourceId);
  return `${unit.name} ${unit.code}${parent === undefined ? '' : ` · ${parent.name}`}`;
};

export interface SourceRow {
  readonly detail: string;
  readonly href: string;
  readonly id: string;
  readonly label: string;
  readonly tone?: 'danger' | 'warning' | 'success' | 'info' | 'outline';
  readonly badge?: string;
}

export interface AttentionItem {
  readonly date: string;
  readonly href: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: 'danger' | 'warning' | 'info';
}

/** Items management should act on, newest risk first: overdue money and work, then expiring contracts. */
export const attentionItems = (sources: OverviewSources, today: string, lang: string): AttentionItem[] => {
  const property = readyData(sources.property);
  const finance = readyData(sources.finance);
  const work = readyData(sources.work);
  const agreements = readyData(sources.agreements);
  const occupancy = readyData(sources.occupancy);
  const horizon = addDays(today, 60);
  const items: AttentionItem[] = [];
  for (const invoice of finance?.state.invoices ?? []) {
    if (isOverdueInvoice(invoice, today)) {
      items.push({
        date: invoice.dueDate,
        detail: `${invoice.direction === 'OUTGOING' ? 'Pohledávka' : 'Závazek'} ${formatCzk(invoice.totalMinor - invoice.paidMinor)} · ${daysBetween(invoice.dueDate, today)} dní po splatnosti`,
        href: `/${lang}/siampark/finance?resourceId=${invoice.ref.resourceId}`,
        id: `invoice:${invoice.ref.resourceId}`,
        kind: invoice.direction === 'OUTGOING' ? 'Vydaná faktura' : 'Přijatá faktura',
        label: `${invoice.documentNumber}${invoice.counterpartyName === undefined ? '' : ` · ${invoice.counterpartyName}`}`,
        tone: 'danger',
      });
    }
  }
  for (const task of work?.items ?? []) {
    if (isOpenTask(task) && task.dueDate !== undefined && task.dueDate < today) {
      items.push({
        date: task.dueDate,
        detail: `Termín ${formatDay(task.dueDate)} · ${daysBetween(task.dueDate, today)} dní po termínu`,
        href: `/${lang}/siampark/work`,
        id: `task:${task.ref.resourceId}`,
        kind: 'Úkol po termínu',
        label: task.title,
        tone: 'danger',
      });
    }
  }
  for (const contract of agreements?.contracts ?? []) {
    if (contract.lifecycleState !== 'ACTIVE') {
      continue;
    }
    const unit = unitLabel(property, contract.unitRef?.resourceId) ?? contract.subject ?? 'Smlouva';
    if (contract.renewalNoticeDate !== null && contract.renewalNoticeDate >= today && contract.renewalNoticeDate <= horizon) {
      items.push({
        date: contract.renewalNoticeDate,
        detail: `Výpovědní / prodlužovací lhůta ${formatDay(contract.renewalNoticeDate)} · za ${daysBetween(today, contract.renewalNoticeDate)} dní`,
        href: `/${lang}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`,
        id: `notice:${contract.contractRef.resourceId}`,
        kind: 'Lhůta smlouvy',
        label: unit,
        tone: 'warning',
      });
    }
    if (contract.endDate !== null && contract.endDate >= today && contract.endDate <= horizon) {
      items.push({
        date: contract.endDate,
        detail: `Konec platnosti ${formatDay(contract.endDate)} · za ${daysBetween(today, contract.endDate)} dní${contract.hasSuccessorDraft ? ' · návrh navazující smlouvy existuje' : ' · bez navazující smlouvy'}`,
        href: `/${lang}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`,
        id: `end:${contract.contractRef.resourceId}`,
        kind: 'Končící smlouva',
        label: unit,
        tone: contract.hasSuccessorDraft ? 'info' : 'warning',
      });
    }
  }
  for (const lease of occupancy?.occupancies ?? []) {
    if (lease.state === 'CONFIRMED' && lease.startDate >= today && lease.startDate <= horizon) {
      items.push({
        date: lease.startDate,
        detail: `Začátek ${formatDay(lease.startDate)} · za ${daysBetween(today, lease.startDate)} dní`,
        href: `/${lang}/siampark/occupancy?resourceId=${lease.occupancyRef.resourceId}`,
        id: `lease:${lease.occupancyRef.resourceId}`,
        kind: lease.kind === 'SHORT_STAY' ? 'Nástup pobytu' : 'Nástup nájemce',
        label: unitLabel(property, lease.unitRef.resourceId) ?? 'Jednotka',
        tone: 'info',
      });
    }
  }
  const toneRank = { danger: 0, info: 2, warning: 1 } as const;
  return items.toSorted((a, b) => toneRank[a.tone] - toneRank[b.tone] || a.date.localeCompare(b.date));
};

export interface SearchHit {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly href: string;
  readonly closed: boolean;
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** S15: search only inside records the governed reads returned for this person; nothing else is queried. */
export const searchSiampark = (sources: OverviewSources, query: string, lang: string, includeClosed: boolean) => {
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
    if ((includeClosed || !hit.closed) && haystack.some((value) => value !== null && value !== undefined && fold(value).includes(needle))) {
      hits.push(hit);
    }
  };
  for (const item of property?.properties ?? []) {
    push(
      {
        closed: item.lifecycleState !== 'ACTIVE',
        detail: item.address,
        href: `/${lang}/siampark/properties?resourceId=${item.propertyRef.resourceId}`,
        id: `p:${item.propertyRef.resourceId}`,
        kind: 'Nemovitost',
        label: `${item.name} (${item.code})`,
      },
      [item.name, item.code, item.address, item.note],
    );
  }
  for (const unit of property?.units ?? []) {
    push(
      {
        closed: unit.lifecycleState !== 'ACTIVE',
        detail: availabilityLabel[unitAvailability(unit, occupancy, DateTime.formatIsoDate(DateTime.nowUnsafe()))],
        href: `/${lang}/siampark/properties?resourceId=${unit.unitRef.resourceId}`,
        id: `u:${unit.unitRef.resourceId}`,
        kind: 'Jednotka',
        label: unitLabel(property, unit.unitRef.resourceId) ?? unit.code,
      },
      [unit.name, unit.code, unit.unitKind, unit.note],
    );
  }
  for (const asset of property?.assets ?? []) {
    push(
      {
        closed: asset.lifecycleState !== 'ACTIVE',
        detail: `${asset.category}${asset.nextServiceAt === null ? '' : ` · příští servis ${formatDay(asset.nextServiceAt)}`}`,
        href: `/${lang}/siampark/properties?resourceId=${asset.propertyRef.resourceId}`,
        id: `a:${asset.assetRef.resourceId}`,
        kind: 'Vybavení',
        label: `${asset.name} (${asset.code})`,
      },
      [asset.name, asset.code, asset.category, asset.serialNumber],
    );
  }
  for (const contract of agreements?.contracts ?? []) {
    const unit = unitLabel(property, contract.unitRef?.resourceId);
    push(
      {
        closed: ['TERMINATED', 'EXPIRED'].includes(contract.lifecycleState),
        detail: `${formatDay(contract.startDate)} – ${contract.endDate === null ? 'na dobu neurčitou' : formatDay(contract.endDate)}`,
        href: `/${lang}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`,
        id: `c:${contract.contractRef.resourceId}`,
        kind: 'Smlouva',
        label: contract.subject ?? unit ?? 'Smlouva',
      },
      [contract.subject, unit, contract.note, contract.responsiblePerson],
    );
  }
  for (const lease of occupancy?.occupancies ?? []) {
    const unit = unitLabel(property, lease.unitRef.resourceId);
    push(
      {
        closed: ['COMPLETED', 'CANCELLED'].includes(lease.state),
        detail: `${formatDay(lease.startDate)} – ${lease.endDate === null ? 'neurčito' : formatDay(lease.endDate)}${lease.rentTerms === undefined ? '' : ` · ${formatCzk(lease.rentTerms.monthlyRentMinor)} / měs.`}`,
        href: `/${lang}/siampark/occupancy?resourceId=${lease.occupancyRef.resourceId}`,
        id: `o:${lease.occupancyRef.resourceId}`,
        kind: lease.kind === 'SHORT_STAY' ? 'Pobyt' : 'Nájem',
        label: unit ?? 'Jednotka',
      },
      [unit, lease.note],
    );
  }
  for (const invoice of finance?.state.invoices ?? []) {
    push(
      {
        closed: invoice.businessState === 'VOIDED' || invoice.paymentState === 'PAID',
        detail: `${invoice.direction === 'OUTGOING' ? 'vydaná' : 'přijatá'} · ${formatCzk(invoice.totalMinor)} · splatnost ${formatDay(invoice.dueDate)}`,
        href: `/${lang}/siampark/finance?resourceId=${invoice.ref.resourceId}`,
        id: `i:${invoice.ref.resourceId}`,
        kind: 'Faktura',
        label: `${invoice.documentNumber}${invoice.counterpartyName === undefined ? '' : ` · ${invoice.counterpartyName}`}`,
      },
      [invoice.documentNumber, invoice.number, invoice.counterpartyName, invoice.note, ...(invoice.lines ?? []).map((line) => line.description)],
    );
  }
  for (const task of work?.items ?? []) {
    push(
      {
        closed: !isOpenTask(task),
        detail: task.dueDate === undefined ? 'bez termínu' : `termín ${formatDay(task.dueDate)}`,
        href: `/${lang}/siampark/work`,
        id: `t:${task.ref.resourceId}`,
        kind: 'Úkol',
        label: task.title,
      },
      [task.title, task.description],
    );
  }
  return hits.slice(0, 60);
};
