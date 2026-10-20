// AREA: reports (C05) — owned by the crm-reports lane. Read-only aggregation over the projected state the read
// server returns (so a salesperson's report and CSV never contain other salespeople's clients, C05-04).
// No commands. Pure aggregation helpers live here; pages live under src/routes/[lang]/crm/prehled-prodeju.
//
// Rules (CRM-DEMO C03/C04/C05):
//  - Only paired, non-duplicate orders count. Unpaired, in-review and cross-source duplicates are excluded and
//    reported beside the totals with their reason.
//  - Amounts are exact decimals and are summed per currency only. CZK and EUR are never added together.
//  - Raw source statuses stay visible. A status gets a business meaning only through the versioned mapping below;
//    anything else is "bez schváleného významu". Totals are "hodnota evidovaných objednávek", never revenue.
//  - Salesperson grouping follows the client's CURRENT owner (C04: summaries follow the valid binding).
import type { ImportedOrder } from './imports.ts';
import type { CrmState } from './state.ts';

// ---------------------------------------------------------------------------------------------------------------
// Status meanings
// ---------------------------------------------------------------------------------------------------------------

export type StatusMeaning = 'open' | 'paid' | 'fulfilled' | 'cancelled';
export type StatusMeaningOrUnmapped = StatusMeaning | 'unmapped';

export const statusMeanings: readonly StatusMeaningOrUnmapped[] = [
  'open',
  'paid',
  'fulfilled',
  'cancelled',
  'unmapped',
];

export const statusMeaningLabels: Record<StatusMeaningOrUnmapped, string> = {
  cancelled: 'Stornovaná',
  fulfilled: 'Vyřízená / dodaná',
  open: 'Přijatá / rozpracovaná',
  paid: 'Uhrazená',
  unmapped: 'Bez schváleného významu',
};

export interface StatusMappingEntry {
  readonly meaning: StatusMeaning;
  /** Raw statuses as the sources send them (compared case- and diacritics-insensitively). */
  readonly raw: readonly string[];
}

/**
 * Versioned raw -> meaning mapping used by the report. Raw statuses that are not listed keep only their raw value
 * and fall into "Bez schváleného významu". The customer confirms the final meaning of statuses, cancellations and
 * returns separately (CRM-DEMO R04); the page says so next to the table.
 */
export const statusMapping = {
  approvedOn: '2026-10-19',
  entries: [
    { meaning: 'open', raw: ['nova', 'nová', 'prijata', 'přijatá', 'prijato', 'v reseni', 'new', 'received'] },
    { meaning: 'paid', raw: ['zaplacena', 'uhrazena', 'uhrazeno', 'paid'] },
    {
      meaning: 'fulfilled',
      raw: [
        'dorucena',
        'doručena',
        'dodana',
        'vyrizena',
        'vyřízená',
        'vyrizeno',
        'dokoncena',
        'delivered',
        'completed',
      ],
    },
    { meaning: 'cancelled', raw: ['stornovana', 'stornována', 'stornovano', 'storno', 'zrusena', 'cancelled'] },
  ] satisfies readonly StatusMappingEntry[],
  version: 'stavy-v1',
} as const;

/** Lower case, no diacritics, single spaces. */
export const normalizeStatus = (raw: string) =>
  raw
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/[\s_-]+/gu, ' ')
    .trim();

const meaningByRaw: ReadonlyMap<string, StatusMeaning> = new Map(
  statusMapping.entries.flatMap((entry) => entry.raw.map((raw) => [normalizeStatus(raw), entry.meaning] as const)),
);

export const reportStatusMeaning = (rawStatus: string): StatusMeaningOrUnmapped =>
  meaningByRaw.get(normalizeStatus(rawStatus)) ?? 'unmapped';

// ---------------------------------------------------------------------------------------------------------------
// Exact decimal money (amounts are DecimalString with up to 4 decimals)
// ---------------------------------------------------------------------------------------------------------------

const SCALE_DIGITS = 4;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** "1234.5" -> 12345000n (units of 1/10_000). Undefined for anything that is not a plain decimal. */
export const decimalToUnits = (value: string): bigint | undefined => {
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, '0'));
  return sign === '-' ? -units : units;
};

/** 12345000n -> "1234.50" (at least two decimals, trailing zeros beyond that dropped). */
export const unitsToDecimal = (units: bigint): string => {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  let fraction = (absolute % SCALE).toString().padStart(SCALE_DIGITS, '0');
  while (fraction.length > 2 && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
};

export interface MoneyTotal {
  /** Exact decimal sum, e.g. "48250.00". */
  readonly amount: string;
  /** Orders that make up this sum. */
  readonly count: number;
  readonly currency: string;
}

const normalizeCurrency = (currency: string | undefined) => {
  const value = currency?.trim().toUpperCase();
  return value === undefined || value === '' ? undefined : value;
};

/** Currency and exact units of an order, or undefined when the source sent no amount or no currency. */
export const orderMoney = (order: ImportedOrder): { readonly currency: string; readonly units: bigint } | undefined => {
  const currency = normalizeCurrency(order.currency);
  const units = order.amount === undefined ? undefined : decimalToUnits(order.amount);
  return currency === undefined || units === undefined ? undefined : { currency, units };
};

/** Currency order: CZK first, then alphabetical. */
const compareCurrency = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }
  if (left === 'CZK') {
    return -1;
  }
  if (right === 'CZK') {
    return 1;
  }
  return left.localeCompare(right);
};

interface Accumulator {
  count: number;
  lastOrderAt: string | undefined;
  money: Map<string, { count: number; units: bigint }>;
  withoutAmount: number;
}

const newAccumulator = (): Accumulator => ({ count: 0, lastOrderAt: undefined, money: new Map(), withoutAmount: 0 });

const accumulate = (target: Accumulator, row: ReportOrderRow) => {
  target.count += 1;
  if (target.lastOrderAt === undefined || row.date > target.lastOrderAt) {
    target.lastOrderAt = row.date;
  }
  const money = orderMoney(row.order);
  if (money === undefined) {
    target.withoutAmount += 1;
    return;
  }
  const current = target.money.get(money.currency) ?? { count: 0, units: 0n };
  target.money.set(money.currency, { count: current.count + 1, units: current.units + money.units });
};

const totalsOf = (accumulator: Accumulator): MoneyTotal[] =>
  [...accumulator.money.entries()]
    .toSorted(([left], [right]) => compareCurrency(left, right))
    .map(([currency, value]) => ({ amount: unitsToDecimal(value.units), count: value.count, currency }));

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

/** Inclusive day range "YYYY-MM-DD"; either end may be open. */
export interface ReportPeriod {
  readonly from?: string;
  readonly to?: string;
}

export type ReportStatusFilter =
  | { readonly kind: 'meaning'; readonly meaning: StatusMeaningOrUnmapped }
  | { readonly kind: 'raw'; readonly raw: string };

export interface ReportFilters {
  readonly clientId?: string;
  readonly period?: ReportPeriod;
  /** Salesperson id, or 'none' for clients without a salesperson. */
  readonly salespersonId?: string;
  readonly status?: ReportStatusFilter;
}

export const UNASSIGNED = 'none';

export interface ReportOrderRow {
  readonly clientId: string;
  readonly clientName: string;
  /** Order date; the time of receipt when the source sent no order date (see dateSource). */
  readonly date: string;
  readonly dateSource: 'ordered' | 'received';
  readonly meaning: StatusMeaningOrUnmapped;
  readonly month: string;
  readonly order: ImportedOrder;
  readonly salespersonId: string | undefined;
  readonly salespersonName: string | undefined;
}

export interface ReportGroup {
  readonly count: number;
  readonly key: string;
  readonly label: string;
  readonly lastOrderAt: string | undefined;
  readonly totals: readonly MoneyTotal[];
  readonly withoutAmount: number;
}

export type ExclusionReason = 'unpaired' | 'review' | 'duplicate' | 'confirmed_duplicate';

export const exclusionReasonLabels: Record<ExclusionReason, string> = {
  confirmed_duplicate: 'potvrzený duplikát z jiného zdroje (nepočítá se dvakrát)',
  duplicate: 'možný duplikát z jiného zdroje, čeká na rozhodnutí',
  review: 'vazba na klienta vyžaduje kontrolu',
  unpaired: 'nespárováno s klientem',
};

export interface ReportExclusion {
  readonly count: number;
  readonly reason: ExclusionReason;
}

export interface SkuRow {
  readonly key: string;
  readonly name: string;
  readonly orders: number;
  /** Exact decimal quantity sum. */
  readonly quantity: string;
  readonly sku: string | undefined;
}

export interface SalesReport {
  readonly byClient: readonly ReportGroup[];
  readonly byMonth: readonly ReportGroup[];
  readonly bySalesperson: readonly ReportGroup[];
  readonly byStatus: readonly ReportGroup[];
  readonly count: number;
  /** Currencies present in the included rows, CZK first. */
  readonly currencies: readonly string[];
  readonly excluded: readonly ReportExclusion[];
  readonly excludedTotal: number;
  /** Item sales by SKU; only orders whose source really sent lines contribute. */
  readonly items: { readonly ordersWithLines: number; readonly rows: readonly SkuRow[] };
  readonly lastOrderAt: string | undefined;
  /** Included orders with a status event flagged for review (kept, but its order is uncertain). */
  readonly reviewEvents: number;
  readonly rows: readonly ReportOrderRow[];
  /** Included rows whose date is the time of receipt (the source sent no order date). */
  readonly rowsWithReceivedDate: number;
  readonly sources: readonly string[];
  readonly totals: readonly MoneyTotal[];
  readonly withoutAmount: number;
}

const dayOf = (iso: string) => iso.slice(0, 10);

export const orderDate = (order: ImportedOrder) => order.orderedAt ?? order.receivedAt;

const inPeriod = (date: string, period: ReportPeriod | undefined) => {
  const day = dayOf(date);
  return (period?.from === undefined || day >= period.from) && (period?.to === undefined || day <= period.to);
};

const matchesStatus = (row: ReportOrderRow, status: ReportStatusFilter | undefined) => {
  if (status === undefined) {
    return true;
  }
  return status.kind === 'meaning'
    ? row.meaning === status.meaning
    : normalizeStatus(row.order.rawStatus) === normalizeStatus(status.raw);
};

/**
 * Latest manual decision on a cross-source duplicate (crm-imports `decisions`), read structurally so this file
 * also decodes documents written before the field existed.
 */
const duplicateDecision = (order: ImportedOrder): string | undefined => {
  const decisions = (order as { readonly decisions?: readonly { readonly decision?: unknown }[] }).decisions;
  const last = decisions?.at(-1)?.decision;
  return typeof last === 'string' ? last : undefined;
};

const exclusionOf = (order: ImportedOrder): ExclusionReason | undefined => {
  if (order.duplicateOf !== undefined) {
    const decision = duplicateDecision(order);
    if (decision === 'confirmed_duplicate') {
      return 'confirmed_duplicate';
    }
    if (decision !== 'distinct') {
      return 'duplicate';
    }
  }
  if (order.pairing === 'review') {
    return 'review';
  }
  if (order.pairing === 'unpaired' || order.clientId === undefined) {
    return 'unpaired';
  }
  return undefined;
};

/** Orders that count into confirmed figures: paired, not an undecided or confirmed duplicate. */
export const confirmedOrders = (state: CrmState) =>
  state.imports.orders.filter((order) => exclusionOf(order) === undefined);

const groupBy = (
  rows: readonly ReportOrderRow[],
  keyOf: (row: ReportOrderRow) => { readonly key: string; readonly label: string },
): ReportGroup[] => {
  const groups = new Map<string, { label: string; accumulator: Accumulator }>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const group = groups.get(key) ?? { accumulator: newAccumulator(), label };
    accumulate(group.accumulator, row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    count: group.accumulator.count,
    key,
    label: group.label,
    lastOrderAt: group.accumulator.lastOrderAt,
    totals: totalsOf(group.accumulator),
    withoutAmount: group.accumulator.withoutAmount,
  }));
};

const monthNames = [
  'leden',
  'únor',
  'březen',
  'duben',
  'květen',
  'červen',
  'červenec',
  'srpen',
  'září',
  'říjen',
  'listopad',
  'prosinec',
];

/** "2026-10" -> "říjen 2026". */
export const monthLabel = (month: string) => {
  const index = Number(month.slice(5, 7)) - 1;
  return `${monthNames[index] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
};

const nextMonth = (month: string) => {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
};

/** Months between the first and last group, gaps filled with zero-order months (a real zero inside the range). */
const continuousMonths = (groups: readonly ReportGroup[]): ReportGroup[] => {
  const sorted = groups.toSorted((left, right) => left.key.localeCompare(right.key));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const byKey = new Map(sorted.map((group) => [group.key, group]));
  const result: ReportGroup[] = [];
  for (let month = first.key; month <= last.key; month = nextMonth(month)) {
    result.push(
      byKey.get(month) ?? {
        count: 0,
        key: month,
        label: monthLabel(month),
        lastOrderAt: undefined,
        totals: [],
        withoutAmount: 0,
      },
    );
  }
  return result;
};

const itemRows = (rows: readonly ReportOrderRow[]) => {
  const items = new Map<string, { name: string; orders: Set<string>; sku: string | undefined; units: bigint }>();
  let ordersWithLines = 0;
  for (const row of rows) {
    const lines = row.order.lines;
    if (lines === undefined || lines.length === 0) {
      continue;
    }
    ordersWithLines += 1;
    for (const line of lines) {
      const key = line.sku ?? line.externalId ?? line.name;
      const item = items.get(key) ?? { name: line.name, orders: new Set<string>(), sku: line.sku, units: 0n };
      item.units += decimalToUnits(line.quantity) ?? 0n;
      item.orders.add(row.order.id);
      items.set(key, item);
    }
  }
  return {
    ordersWithLines,
    rows: [...items.entries()]
      .map(([key, item]) => ({
        key,
        name: item.name,
        orders: item.orders.size,
        quantity: unitsToDecimal(item.units).replace(/\.00$/u, ''),
        sku: item.sku,
      }))
      .toSorted((left, right) => right.orders - left.orders || left.name.localeCompare(right.name, 'cs')),
  };
};

/**
 * The C05 sales report over the (already ACL-projected) state. Filters apply to the included rows; exclusions are
 * counted in the same period (they have no reliable client or salesperson, so those filters do not narrow them).
 */
export const buildSalesReport = (state: CrmState, filters: ReportFilters = {}): SalesReport => {
  const clients = new Map(state.clients.items.map((client) => [client.id, client]));
  const salespeople = new Map(state.salespeople.map((person) => [person.id, person.name]));
  const exclusionCounts = new Map<ExclusionReason, number>();
  const rows: ReportOrderRow[] = [];
  const sources = new Set<string>();

  for (const order of state.imports.orders) {
    const date = orderDate(order);
    if (!inPeriod(date, filters.period)) {
      continue;
    }
    const exclusion = exclusionOf(order);
    if (exclusion !== undefined) {
      exclusionCounts.set(exclusion, (exclusionCounts.get(exclusion) ?? 0) + 1);
      continue;
    }
    const clientId = order.clientId ?? '';
    const client = clients.get(clientId);
    const salespersonId = client?.ownerSalespersonId;
    const row: ReportOrderRow = {
      clientId,
      clientName: client?.name ?? 'Neznámý klient',
      date,
      dateSource: order.orderedAt === undefined ? 'received' : 'ordered',
      meaning: reportStatusMeaning(order.rawStatus),
      month: date.slice(0, 7),
      order,
      salespersonId,
      salespersonName: salespersonId === undefined ? undefined : salespeople.get(salespersonId),
    };
    if (filters.clientId !== undefined && row.clientId !== filters.clientId) {
      continue;
    }
    if (filters.salespersonId !== undefined && (row.salespersonId ?? UNASSIGNED) !== filters.salespersonId) {
      continue;
    }
    if (!matchesStatus(row, filters.status)) {
      continue;
    }
    rows.push(row);
    sources.add(order.source);
  }

  rows.sort((left, right) => right.date.localeCompare(left.date) || left.clientName.localeCompare(right.clientName));
  const all = newAccumulator();
  for (const row of rows) {
    accumulate(all, row);
  }
  const excluded = (['unpaired', 'review', 'duplicate', 'confirmed_duplicate'] as const).flatMap((reason) => {
    const count = exclusionCounts.get(reason) ?? 0;
    return count === 0 ? [] : [{ count, reason }];
  });
  const totals = totalsOf(all);
  const byStatus = groupBy(rows, (row) => ({ key: row.meaning, label: statusMeaningLabels[row.meaning] })).toSorted(
    (left, right) =>
      statusMeanings.indexOf(left.key as StatusMeaningOrUnmapped) -
      statusMeanings.indexOf(right.key as StatusMeaningOrUnmapped),
  );
  return {
    byClient: groupBy(rows, (row) => ({ key: row.clientId, label: row.clientName })).toSorted(
      (left, right) => right.count - left.count || left.label.localeCompare(right.label, 'cs'),
    ),
    byMonth: continuousMonths(groupBy(rows, (row) => ({ key: row.month, label: monthLabel(row.month) }))),
    bySalesperson: groupBy(rows, (row) => ({
      key: row.salespersonId ?? UNASSIGNED,
      label: row.salespersonName ?? 'Nepřiděleno',
    })).toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'cs')),
    byStatus,
    count: all.count,
    currencies: totals.map((total) => total.currency),
    excluded,
    excludedTotal: excluded.reduce((sum, entry) => sum + entry.count, 0),
    items: itemRows(rows),
    lastOrderAt: all.lastOrderAt,
    reviewEvents: rows.filter((row) => row.order.statusHistory.some((event) => event.review === true)).length,
    rows,
    rowsWithReceivedDate: rows.filter((row) => row.dateSource === 'received').length,
    sources: [...sources].toSorted((left, right) => left.localeCompare(right, 'cs')),
    totals,
    withoutAmount: all.withoutAmount,
  };
};

/** Raw statuses present among the confirmed orders, with their meaning (for the status filter and mapping table). */
export const rawStatusesInUse = (state: CrmState) => {
  const statuses = new Map<string, { raw: string; meaning: StatusMeaningOrUnmapped; sources: Set<string> }>();
  for (const order of state.imports.orders) {
    const key = normalizeStatus(order.rawStatus);
    const entry = statuses.get(key) ?? {
      meaning: reportStatusMeaning(order.rawStatus),
      raw: order.rawStatus,
      sources: new Set<string>(),
    };
    entry.sources.add(order.source);
    statuses.set(key, entry);
  }
  return [...statuses.values()]
    .map((entry) => ({
      meaning: entry.meaning,
      raw: entry.raw,
      sources: [...entry.sources].toSorted((left, right) => left.localeCompare(right, 'cs')),
    }))
    .toSorted(
      (left, right) =>
        statusMeanings.indexOf(left.meaning) - statusMeanings.indexOf(right.meaning) ||
        left.raw.localeCompare(right.raw, 'cs'),
    );
};

// ---------------------------------------------------------------------------------------------------------------
// Client card facts (C05 / C06: facts only, no recommendation)
// ---------------------------------------------------------------------------------------------------------------

export interface ClientSalesFacts {
  readonly lastOrderAt: string | undefined;
  readonly lastVisitAt: string | undefined;
  /** Confirmed (paired, non-duplicate) orders of the client. */
  readonly orderCount: number;
  /** Value of the confirmed orders per currency (never added across currencies). */
  readonly totals: readonly MoneyTotal[];
  readonly withoutAmount: number;
}

export const clientSalesFacts = (state: CrmState, clientId: string, period?: ReportPeriod): ClientSalesFacts => {
  const report = buildSalesReport(state, period === undefined ? { clientId } : { clientId, period });
  const lastVisitAt = state.visits.items
    .filter((visit) => visit.clientId === clientId)
    .reduce<string | undefined>(
      (latest, visit) => (latest === undefined || visit.occurredAt > latest ? visit.occurredAt : latest),
      undefined,
    );
  return {
    lastOrderAt: report.lastOrderAt,
    lastVisitAt,
    orderCount: report.count,
    totals: report.totals,
    withoutAmount: report.withoutAmount,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// CSV (exactly the rows the page shows)
// ---------------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value);
  return /[";\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Semicolon-separated CSV with CRLF line ends (opens directly in Czech Excel; prepend a BOM when saving). */
export const toCsv = (header: readonly string[], rows: readonly (readonly (string | number | undefined)[])[]) =>
  [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');

/** Decimal for Czech spreadsheets: "1234.50" -> "1234,50". */
const csvDecimal = (value: string | undefined) => value?.replace('.', ',');

export const ordersCsv = (report: SalesReport) =>
  toCsv(
    [
      'Datum objednávky',
      'Číslo objednávky',
      'Zdroj',
      'Externí ID',
      'Klient',
      'Obchodník',
      'Surový stav',
      'Význam stavu',
      'Částka',
      'Měna',
    ],
    report.rows.map((row) => {
      const money = orderMoney(row.order);
      return [
        dayOf(row.date),
        row.order.number,
        row.order.source,
        row.order.externalId,
        row.clientName,
        row.salespersonName ?? 'Nepřiděleno',
        row.order.rawStatus,
        statusMeaningLabels[row.meaning],
        money === undefined ? 'údaj neposkytnut' : csvDecimal(unitsToDecimal(money.units)),
        money?.currency ?? '',
      ];
    }),
  );

export const groupsCsv = (groupLabel: string, groups: readonly ReportGroup[], currencies: readonly string[]) =>
  toCsv(
    [groupLabel, 'Počet objednávek', ...currencies.map((currency) => `Hodnota ${currency}`), 'Bez částky'],
    groups.map((group) => [
      group.label,
      group.count,
      ...currencies.map((currency) =>
        csvDecimal(group.totals.find((total) => total.currency === currency)?.amount ?? '0.00'),
      ),
      group.withoutAmount,
    ]),
  );
