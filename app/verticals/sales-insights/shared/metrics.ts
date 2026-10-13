// Pure metric catalog for the sales-insights statistics page and the agent MCP get_metrics tool.
// Plain functions only: no React, no fetch, no Effect services, no ambient clock. The caller passes the
// reference day (`today`) when a metric depends on "now". Inputs use the producer verticals' decoded types:
// calendar days are `CalendarDay` (YYYY-MM-DD) and instants are `DateTime.Utc`.
// Money is integer CZK minor units (haléře); CZK values returned here are minor units as well.
// Period keys are UTC calendar days taken from the instant.
import type { CalendarDateWireSchema } from '@app/shared-contracts';
import { DateTime, Match, Schema } from 'effect';

export const MetricIdSchema = Schema.Literals([
  'revenue_invoiced',
  'invoice_count',
  'unpaid_amount',
  'pipeline_open_value',
  'pipeline_weighted_value',
  'opportunities_won',
  'opportunities_lost',
  'win_rate',
  'orders_count',
  'units_sold',
  'stock_value',
  'tasks_open',
  'tasks_overdue',
  'tasks_done',
]);
export type MetricId = typeof MetricIdSchema.Type;

export const MetricUnitSchema = Schema.Literals(['CZK', 'count', 'percent', 'pieces']);
export type MetricUnit = typeof MetricUnitSchema.Type;

export const GroupingSchema = Schema.Literals([
  'day',
  'week',
  'month',
  'employee',
  'customer',
  'product',
  'stage',
  'tag',
]);
export type Grouping = typeof GroupingSchema.Type;

export type CalendarDay = typeof CalendarDateWireSchema.Type;
export type Instant = typeof Schema.DateTimeUtcFromString.Type;

// Producer vocabularies, mirrored structurally from sales-pipeline, billing, siampark-work, merchandise
// and tagging. Kept local so this module has no cross-vertical package dependency.
const OpportunityStageSchema = Schema.Literals(['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']);
export type OpportunityStage = typeof OpportunityStageSchema.Type;
const InvoiceBusinessStateSchema = Schema.Literals(['DRAFT', 'CONFIRMED', 'VOIDED']);
export type InvoiceBusinessState = typeof InvoiceBusinessStateSchema.Type;
const InvoiceDirectionSchema = Schema.Literals(['OUTGOING', 'INCOMING']);
export type InvoiceDirection = typeof InvoiceDirectionSchema.Type;
const PaymentStateSchema = Schema.Literals(['UNPAID', 'PARTIALLY_PAID', 'PAID']);
export type PaymentState = typeof PaymentStateSchema.Type;
const OrderStatusSchema = Schema.Literals(['NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type OrderStatus = typeof OrderStatusSchema.Type;
const TaskStateSchema = Schema.Literals(['NEW', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED']);
export type TaskState = typeof TaskStateSchema.Type;
const SubjectKindSchema = Schema.Literals(['customer', 'order', 'product', 'employee', 'opportunity']);
export type SubjectKind = typeof SubjectKindSchema.Type;

export interface OpportunityInput {
  readonly amountMinor: number;
  readonly closedAt?: Instant | undefined;
  readonly expectedCloseDate: CalendarDay;
  readonly id: string;
  readonly ownerEmployeeId?: string | undefined;
  readonly partyId: string;
  readonly probability: number;
  readonly stage: OpportunityStage;
}

export interface InvoiceInput {
  readonly businessState: InvoiceBusinessState;
  readonly direction?: InvoiceDirection | undefined;
  readonly issueDate: CalendarDay;
  readonly opportunityId?: string | undefined;
  readonly paidMinor: number;
  readonly partyId?: string | undefined;
  readonly paymentState: PaymentState;
  readonly totalMinor: number;
}

export interface OrderLineInput {
  readonly productId: string;
  readonly quantity: number;
}

export interface OrderInput {
  readonly createdAt: Instant;
  readonly id: string;
  readonly lines: readonly OrderLineInput[];
  readonly opportunityId?: string | undefined;
  readonly partyId: string;
  readonly status: OrderStatus;
}

export interface ProductInput {
  readonly currentPriceMinor: number;
  readonly id: string;
  readonly name: string;
}

export interface MovementInput {
  readonly delta: number;
  readonly productId: string;
}

export interface TaskInput {
  readonly assigneeEmployeeId?: string | undefined;
  readonly dueDate?: CalendarDay | undefined;
  readonly partyId?: string | undefined;
  readonly state: TaskState;
  readonly updatedAt: Instant;
}

export interface EmployeeInput {
  readonly fullName: string;
  readonly id: string;
}

export interface TagAssignmentInput {
  readonly subject: { readonly id: string; readonly kind: SubjectKind };
  readonly tagId: string;
}

export interface NamedInput {
  readonly id: string;
  readonly name: string;
}

export interface MetricInputs {
  readonly customers?: readonly NamedInput[];
  readonly employees: readonly EmployeeInput[];
  readonly invoices: readonly InvoiceInput[];
  readonly movements: readonly MovementInput[];
  readonly opportunities: readonly OpportunityInput[];
  readonly orders: readonly OrderInput[];
  readonly products: readonly ProductInput[];
  readonly tagAssignments?: readonly TagAssignmentInput[] | undefined;
  readonly tags?: readonly NamedInput[] | undefined;
  readonly tasks: readonly TaskInput[];
}

/** Inclusive calendar range. `today` is the reference day for "overdue"; it defaults to `to`. */
export interface MetricRange {
  readonly from: CalendarDay;
  readonly to: CalendarDay;
  readonly today?: CalendarDay | undefined;
}

export interface MetricQuery extends MetricRange {
  readonly groupBy: Grouping;
}

export interface MetricCatalogEntry {
  readonly allowedGroupings: readonly Grouping[];
  readonly id: MetricId;
  readonly label: string;
  readonly source: string;
  readonly unit: MetricUnit;
}

export interface MetricPoint {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface MetricResult {
  readonly series: readonly MetricPoint[];
  readonly supported: boolean;
  readonly total: number;
}

export interface KpiValue {
  readonly id: MetricId;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly value: number;
}

interface Subject {
  readonly id: string;
  readonly kind: SubjectKind;
}

/** One record's contribution to a metric: a numerator, an optional denominator, and its dimensions. */
interface Contribution {
  readonly date?: CalendarDay | undefined;
  readonly den: number;
  readonly employeeId?: string | undefined;
  readonly num: number;
  readonly partyId?: string | undefined;
  readonly productId?: string | undefined;
  readonly stage?: OpportunityStage | undefined;
  readonly subjects: readonly Subject[];
}

interface MetricDefinition extends MetricCatalogEntry {
  readonly collect: (inputs: MetricInputs, range: MetricRange) => readonly Contribution[];
  /** Ratio metrics report num / den as a percent; sum metrics report num. */
  readonly ratio: boolean;
}

interface Names {
  readonly customers: ReadonlyMap<string, string>;
  readonly employees: ReadonlyMap<string, string>;
  readonly products: ReadonlyMap<string, string>;
  readonly tagAssignments: ReadonlyMap<string, readonly string[]>;
  readonly tags: ReadonlyMap<string, string>;
}

interface Bucket {
  readonly key: string;
  readonly label: string;
}

interface Totals {
  readonly den: number;
  readonly num: number;
}

interface Cell extends Totals {
  readonly key: string;
  readonly label: string;
}

const CATEGORY_LIMIT = 12;
const OTHER_KEY = 'other';
const NONE_KEY = 'none';
const TIME_GROUPINGS: ReadonlySet<Grouping> = new Set<Grouping>(['day', 'week', 'month']);
const OPEN_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['NEW', 'IN_PROGRESS', 'WAITING']);
const CZ_MONTHS: readonly string[] = [
  'led',
  'úno',
  'bře',
  'dub',
  'kvě',
  'čvn',
  'čvc',
  'srp',
  'zář',
  'říj',
  'lis',
  'pro',
];
const STAGE_LABELS = {
  LEAD: 'Lead',
  LOST: 'Prohráno',
  NEGOTIATION: 'Vyjednávání',
  PROPOSAL: 'Nabídka',
  QUALIFIED: 'Kvalifikace',
  WON: 'Vyhráno',
} as const satisfies Record<OpportunityStage, string>;

const SOURCE_INVOICES = 'siampark-billing-finance · invoices';
const SOURCE_OPPORTUNITIES = 'sales-pipeline · opportunities';
const SOURCE_ORDERS = 'merchandise · orders';
const SOURCE_TASKS = 'siampark-work · tasks';

// ---------------------------------------------------------------------------------------------------------
// Date helpers (Effect DateTime for calendar arithmetic; no ambient clock)
// ---------------------------------------------------------------------------------------------------------

const dateOf = (instant: Instant): CalendarDay => DateTime.formatIsoDateUtc(instant);

const dayLabel = (date: CalendarDay): string => `${Number(date.slice(8, 10))}. ${Number(date.slice(5, 7))}.`;

const monthLabel = (date: CalendarDay): string =>
  `${CZ_MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${date.slice(0, 4)}`;

/** Monday of the ISO week containing `date`. */
const mondayOf = (date: CalendarDay): CalendarDay => {
  const day = DateTime.makeUnsafe(`${date}T00:00:00.000Z`);
  const sundayBasedWeekDay = DateTime.getPartUtc(day, 'weekDay');
  return DateTime.formatIsoDateUtc(DateTime.subtract(day, { days: (sundayBasedWeekDay + 6) % 7 }));
};

const inRange = (date: CalendarDay | undefined, range: MetricRange): boolean =>
  date === undefined || (date >= range.from && date <= range.to);

// ---------------------------------------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------------------------------------

const refs = (...pairs: [SubjectKind, string | undefined][]): readonly Subject[] =>
  pairs.flatMap(([kind, id]) => (id === undefined ? [] : [{ id, kind }]));

const ownerIndex = (opportunities: readonly OpportunityInput[]): ReadonlyMap<string, string | undefined> =>
  new Map<string, string | undefined>(
    opportunities.map((o): [string, string | undefined] => [o.id, o.ownerEmployeeId]),
  );

const ownerOf = (owners: ReadonlyMap<string, string | undefined>, opportunityId?: string): string | undefined =>
  opportunityId === undefined ? undefined : owners.get(opportunityId);

const isOpenStage = (stage: OpportunityStage): boolean => stage !== 'WON' && stage !== 'LOST';

const isSaleInvoice = (invoice: InvoiceInput): boolean =>
  invoice.businessState === 'CONFIRMED' && invoice.direction !== 'INCOMING';

const isOpenTask = (task: TaskInput): boolean => OPEN_TASK_STATES.has(task.state);

const invoiceRow = (
  invoice: InvoiceInput,
  owners: ReadonlyMap<string, string | undefined>,
  num: number,
): Contribution => ({
  date: invoice.issueDate,
  den: 0,
  employeeId: ownerOf(owners, invoice.opportunityId),
  num,
  partyId: invoice.partyId,
  subjects: refs(['customer', invoice.partyId], ['opportunity', invoice.opportunityId]),
});

/** Confirmed outgoing invoices that pass `include`, valued by `num`. */
const saleRows = (
  inputs: MetricInputs,
  include: (invoice: InvoiceInput) => boolean,
  num: (invoice: InvoiceInput) => number,
): readonly Contribution[] => {
  const owners = ownerIndex(inputs.opportunities);
  return inputs.invoices.flatMap((invoice) =>
    isSaleInvoice(invoice) && include(invoice) ? [invoiceRow(invoice, owners, num(invoice))] : [],
  );
};

const opportunityRow = (o: OpportunityInput, date: CalendarDay, num: number, den = 0): Contribution => ({
  date,
  den,
  employeeId: o.ownerEmployeeId,
  num,
  partyId: o.partyId,
  stage: o.stage,
  subjects: refs(['customer', o.partyId], ['opportunity', o.id], ['employee', o.ownerEmployeeId]),
});

const closedOpportunityRows = (
  inputs: MetricInputs,
  stages: ReadonlySet<OpportunityStage>,
  numOf: (o: OpportunityInput) => number,
  den: number,
): readonly Contribution[] =>
  inputs.opportunities.flatMap((o) =>
    o.closedAt === undefined || !stages.has(o.stage) ? [] : [opportunityRow(o, dateOf(o.closedAt), numOf(o), den)],
  );

const openOpportunityRows = (inputs: MetricInputs, numOf: (o: OpportunityInput) => number): readonly Contribution[] =>
  inputs.opportunities.flatMap((o) => (isOpenStage(o.stage) ? [opportunityRow(o, o.expectedCloseDate, numOf(o))] : []));

const taskRow = (task: TaskInput, date: CalendarDay | undefined, num: number): Contribution => ({
  date,
  den: 0,
  employeeId: task.assigneeEmployeeId,
  num,
  partyId: task.partyId,
  subjects: refs(['employee', task.assigneeEmployeeId], ['customer', task.partyId]),
});

// ---------------------------------------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------------------------------------

const INVOICE_GROUPINGS: readonly Grouping[] = ['day', 'week', 'month', 'employee', 'customer', 'tag'];
const PIPELINE_GROUPINGS: readonly Grouping[] = ['day', 'week', 'month', 'employee', 'customer', 'stage', 'tag'];
const CLOSED_GROUPINGS: readonly Grouping[] = ['day', 'week', 'month', 'employee', 'customer', 'tag'];
const WON_STAGES: ReadonlySet<OpportunityStage> = new Set<OpportunityStage>(['WON']);
const LOST_STAGES: ReadonlySet<OpportunityStage> = new Set<OpportunityStage>(['LOST']);
const CLOSED_STAGES: ReadonlySet<OpportunityStage> = new Set<OpportunityStage>(['WON', 'LOST']);

// Keys stay alphabetical (lint); the catalog order is METRIC_ORDER below.
const METRIC_DEFINITIONS = {
  invoice_count: {
    allowedGroupings: INVOICE_GROUPINGS,
    collect: (inputs) =>
      saleRows(
        inputs,
        () => true,
        () => 1,
      ),
    id: 'invoice_count',
    label: 'Počet faktur',
    ratio: false,
    source: SOURCE_INVOICES,
    unit: 'count',
  },
  opportunities_lost: {
    allowedGroupings: CLOSED_GROUPINGS,
    collect: (inputs) => closedOpportunityRows(inputs, LOST_STAGES, (o) => o.amountMinor, 0),
    id: 'opportunities_lost',
    label: 'Prohrané příležitosti',
    ratio: false,
    source: SOURCE_OPPORTUNITIES,
    unit: 'CZK',
  },
  opportunities_won: {
    allowedGroupings: CLOSED_GROUPINGS,
    collect: (inputs) => closedOpportunityRows(inputs, WON_STAGES, (o) => o.amountMinor, 0),
    id: 'opportunities_won',
    label: 'Vyhrané příležitosti',
    ratio: false,
    source: SOURCE_OPPORTUNITIES,
    unit: 'CZK',
  },
  orders_count: {
    allowedGroupings: ['day', 'week', 'month', 'employee', 'customer', 'tag'],
    collect: (inputs) => {
      const owners = ownerIndex(inputs.opportunities);
      return inputs.orders.flatMap((order) =>
        order.status === 'CANCELLED'
          ? []
          : [
              {
                date: dateOf(order.createdAt),
                den: 0,
                employeeId: ownerOf(owners, order.opportunityId),
                num: 1,
                partyId: order.partyId,
                subjects: refs(['customer', order.partyId], ['order', order.id], ['opportunity', order.opportunityId]),
              },
            ],
      );
    },
    id: 'orders_count',
    label: 'Počet objednávek',
    ratio: false,
    source: SOURCE_ORDERS,
    unit: 'count',
  },
  pipeline_open_value: {
    allowedGroupings: PIPELINE_GROUPINGS,
    collect: (inputs) => openOpportunityRows(inputs, (o) => o.amountMinor),
    id: 'pipeline_open_value',
    label: 'Pipeline (otevřené)',
    ratio: false,
    source: SOURCE_OPPORTUNITIES,
    unit: 'CZK',
  },
  pipeline_weighted_value: {
    allowedGroupings: PIPELINE_GROUPINGS,
    collect: (inputs) => openOpportunityRows(inputs, (o) => Math.round((o.amountMinor * o.probability) / 100)),
    id: 'pipeline_weighted_value',
    label: 'Vážená pipeline',
    ratio: false,
    source: SOURCE_OPPORTUNITIES,
    unit: 'CZK',
  },
  revenue_invoiced: {
    allowedGroupings: INVOICE_GROUPINGS,
    collect: (inputs) =>
      saleRows(
        inputs,
        () => true,
        (invoice) => invoice.totalMinor,
      ),
    id: 'revenue_invoiced',
    label: 'Tržby z faktur',
    ratio: false,
    source: `${SOURCE_INVOICES} (CONFIRMED, by issueDate)`,
    unit: 'CZK',
  },
  stock_value: {
    allowedGroupings: ['product', 'tag'],
    collect: (inputs) => {
      const onHand = new Map<string, number>();
      for (const movement of inputs.movements) {
        onHand.set(movement.productId, (onHand.get(movement.productId) ?? 0) + movement.delta);
      }
      return inputs.products.map((product) => ({
        den: 0,
        num: (onHand.get(product.id) ?? 0) * product.currentPriceMinor,
        productId: product.id,
        subjects: refs(['product', product.id]),
      }));
    },
    id: 'stock_value',
    label: 'Hodnota skladu',
    ratio: false,
    source: 'merchandise · products + stock movements (current snapshot)',
    unit: 'CZK',
  },
  tasks_done: {
    allowedGroupings: ['day', 'week', 'month', 'employee'],
    collect: (inputs) =>
      inputs.tasks.flatMap((task) => (task.state === 'DONE' ? [taskRow(task, dateOf(task.updatedAt), 1)] : [])),
    id: 'tasks_done',
    label: 'Splněné úkoly',
    ratio: false,
    source: `${SOURCE_TASKS} (date = updatedAt proxy)`,
    unit: 'count',
  },
  tasks_open: {
    allowedGroupings: ['employee'],
    collect: (inputs) => inputs.tasks.flatMap((task) => (isOpenTask(task) ? [taskRow(task, undefined, 1)] : [])),
    id: 'tasks_open',
    label: 'Otevřené úkoly',
    ratio: false,
    source: `${SOURCE_TASKS} (current snapshot)`,
    unit: 'count',
  },
  tasks_overdue: {
    allowedGroupings: ['employee'],
    collect: (inputs, range) => {
      const asOf = range.today ?? range.to;
      return inputs.tasks.flatMap((task) =>
        isOpenTask(task) && task.dueDate !== undefined && task.dueDate < asOf ? [taskRow(task, undefined, 1)] : [],
      );
    },
    id: 'tasks_overdue',
    label: 'Úkoly po termínu',
    ratio: false,
    source: `${SOURCE_TASKS} (dueDate before the reference day)`,
    unit: 'count',
  },
  units_sold: {
    allowedGroupings: ['day', 'week', 'month', 'employee', 'customer', 'product', 'tag'],
    collect: (inputs) => {
      const owners = ownerIndex(inputs.opportunities);
      return inputs.orders.flatMap((order) =>
        order.status === 'CANCELLED'
          ? []
          : order.lines.map((line) => ({
              date: dateOf(order.createdAt),
              den: 0,
              employeeId: ownerOf(owners, order.opportunityId),
              num: line.quantity,
              partyId: order.partyId,
              productId: line.productId,
              subjects: refs(
                ['product', line.productId],
                ['order', order.id],
                ['customer', order.partyId],
                ['opportunity', order.opportunityId],
              ),
            })),
      );
    },
    id: 'units_sold',
    label: 'Prodané kusy',
    ratio: false,
    source: 'merchandise · order lines (non-cancelled)',
    unit: 'pieces',
  },
  unpaid_amount: {
    allowedGroupings: INVOICE_GROUPINGS,
    collect: (inputs) =>
      saleRows(
        inputs,
        (invoice) => invoice.paymentState !== 'PAID',
        (invoice) => Math.max(0, invoice.totalMinor - invoice.paidMinor),
      ),
    id: 'unpaid_amount',
    label: 'Nezaplaceno',
    ratio: false,
    source: `${SOURCE_INVOICES} (totalMinor minus paidMinor)`,
    unit: 'CZK',
  },
  win_rate: {
    allowedGroupings: CLOSED_GROUPINGS,
    collect: (inputs) => closedOpportunityRows(inputs, CLOSED_STAGES, (o) => (o.stage === 'WON' ? 1 : 0), 1),
    id: 'win_rate',
    label: 'Úspěšnost (win rate)',
    ratio: true,
    source: 'sales-pipeline · won / (won + lost) by closedAt',
    unit: 'percent',
  },
} satisfies Record<MetricId, MetricDefinition>;

const METRIC_ORDER: readonly MetricId[] = [
  'revenue_invoiced',
  'invoice_count',
  'unpaid_amount',
  'pipeline_open_value',
  'pipeline_weighted_value',
  'opportunities_won',
  'opportunities_lost',
  'win_rate',
  'orders_count',
  'units_sold',
  'stock_value',
  'tasks_open',
  'tasks_overdue',
  'tasks_done',
];

const KPI_METRIC_IDS: readonly MetricId[] = [
  'revenue_invoiced',
  'pipeline_open_value',
  'win_rate',
  'units_sold',
  'unpaid_amount',
  'tasks_overdue',
];

/** Catalog for the statistics page builder and the MCP get_metrics tool. */
export const metricCatalog: readonly MetricCatalogEntry[] = METRIC_ORDER.map((id) => {
  const definition: MetricDefinition = METRIC_DEFINITIONS[id];
  return {
    allowedGroupings: definition.allowedGroupings,
    id: definition.id,
    label: definition.label,
    source: definition.source,
    unit: definition.unit,
  };
});

// ---------------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------------

const namesOf = (inputs: MetricInputs): Names => {
  const tagAssignments = new Map<string, string[]>();
  for (const assignment of inputs.tagAssignments ?? []) {
    const key = `${assignment.subject.kind}:${assignment.subject.id}`;
    tagAssignments.set(key, [...(tagAssignments.get(key) ?? []), assignment.tagId]);
  }
  return {
    customers: new Map<string, string>((inputs.customers ?? []).map((c): [string, string] => [c.id, c.name])),
    employees: new Map<string, string>(inputs.employees.map((e): [string, string] => [e.id, e.fullName])),
    products: new Map<string, string>(inputs.products.map((p): [string, string] => [p.id, p.name])),
    tagAssignments,
    tags: new Map<string, string>((inputs.tags ?? []).map((t): [string, string] => [t.id, t.name])),
  };
};

const timeBucket = (date: CalendarDay, groupBy: Grouping): Bucket => {
  if (groupBy === 'month') {
    return { key: date.slice(0, 7), label: monthLabel(date) };
  }
  if (groupBy === 'week') {
    const monday = mondayOf(date);
    return { key: monday, label: `Týden ${dayLabel(monday)}` };
  }
  return { key: date, label: dayLabel(date) };
};

const namedBucket = (id: string | undefined, names: ReadonlyMap<string, string>, noneLabel: string): Bucket =>
  id === undefined ? { key: NONE_KEY, label: noneLabel } : { key: id, label: names.get(id) ?? id };

const stageBucket = (stage: OpportunityStage | undefined): Bucket =>
  stage === undefined ? { key: NONE_KEY, label: 'Bez fáze' } : { key: stage, label: STAGE_LABELS[stage] };

const tagBuckets = (row: Contribution, names: Names): readonly Bucket[] => {
  const tagIds = new Set<string>();
  for (const subject of row.subjects) {
    for (const tagId of names.tagAssignments.get(`${subject.kind}:${subject.id}`) ?? []) {
      tagIds.add(tagId);
    }
  }
  if (tagIds.size === 0) {
    return [{ key: NONE_KEY, label: 'Bez štítku' }];
  }
  return [...tagIds].map((tagId) => ({ key: tagId, label: names.tags.get(tagId) ?? tagId }));
};

const bucketsOf = (row: Contribution, groupBy: Grouping, names: Names): readonly Bucket[] =>
  Match.value(groupBy).pipe(
    Match.whenOr('day', 'week', 'month', (grouping) =>
      row.date === undefined ? [] : [timeBucket(row.date, grouping)],
    ),
    Match.when('employee', () => [namedBucket(row.employeeId, names.employees, 'Bez obchodníka')]),
    Match.when('customer', () => [namedBucket(row.partyId, names.customers, 'Bez zákazníka')]),
    Match.when('product', () => [namedBucket(row.productId, names.products, 'Bez produktu')]),
    Match.when('stage', () => [stageBucket(row.stage)]),
    Match.when('tag', () => tagBuckets(row, names)),
    Match.exhaustive,
  );

const sumOf = (rows: readonly Totals[]): Totals => {
  let den = 0;
  let num = 0;
  for (const row of rows) {
    den += row.den;
    num += row.num;
  }
  return { den, num };
};

const valueFor = (totals: Totals, ratio: boolean): number => {
  if (!ratio) {
    return totals.num;
  }
  return totals.den === 0 ? 0 : Math.round((totals.num / totals.den) * 1000) / 10;
};

const compareKeys = (a: { readonly key: string }, b: { readonly key: string }): number => {
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
};

const pointOf = (cell: Cell, ratio: boolean): MetricPoint => ({
  key: cell.key,
  label: cell.label,
  value: valueFor(cell, ratio),
});

/** Categorical series: highest value first, top N then one "Ostatní" point for the rest. */
const categoricalSeries = (cells: readonly Cell[], ratio: boolean): readonly MetricPoint[] => {
  const ranked = cells.toSorted((a, b) => valueFor(b, ratio) - valueFor(a, ratio) || compareKeys(a, b));
  const head = ranked.slice(0, CATEGORY_LIMIT).map((cell) => pointOf(cell, ratio));
  const rest = ranked.slice(CATEGORY_LIMIT);
  if (rest.length === 0) {
    return head;
  }
  return [...head, { key: OTHER_KEY, label: 'Ostatní', value: valueFor(sumOf(rest), ratio) }];
};

const collectRows = (definition: MetricDefinition, inputs: MetricInputs, range: MetricRange): readonly Contribution[] =>
  definition.collect(inputs, range).filter((row) => inRange(row.date, range));

/**
 * Compute one metric as a series grouped by `query.groupBy`. Time groupings are sorted ascending by period;
 * categorical groupings are sorted by value descending (top 12 plus "Ostatní"). A grouping the metric does
 * not allow returns `supported: false` with an empty series. A record with several tags is counted under each
 * tag, so tag series can sum above `total`.
 */
export const computeMetric = (id: MetricId, inputs: MetricInputs, query: MetricQuery): MetricResult => {
  const definition: MetricDefinition = METRIC_DEFINITIONS[id];
  if (!definition.allowedGroupings.includes(query.groupBy)) {
    return { series: [], supported: false, total: 0 };
  }
  const rows = collectRows(definition, inputs, query);
  const names = namesOf(inputs);
  const cells = new Map<string, Cell>();
  for (const row of rows) {
    for (const bucket of bucketsOf(row, query.groupBy, names)) {
      const previous = cells.get(bucket.key);
      cells.set(bucket.key, {
        den: (previous?.den ?? 0) + row.den,
        key: bucket.key,
        label: bucket.label,
        num: (previous?.num ?? 0) + row.num,
      });
    }
  }
  const cellList = [...cells.values()];
  const series = TIME_GROUPINGS.has(query.groupBy)
    ? cellList.toSorted(compareKeys).map((cell) => pointOf(cell, definition.ratio))
    : categoricalSeries(cellList, definition.ratio);
  return { series, supported: true, total: valueFor(sumOf(rows), definition.ratio) };
};

/** Headline numbers for the StatRow over one range (totals only, no grouping). */
export const computeKpis = (inputs: MetricInputs, range: MetricRange): readonly KpiValue[] =>
  KPI_METRIC_IDS.map((id) => {
    const definition: MetricDefinition = METRIC_DEFINITIONS[id];
    return {
      id,
      label: definition.label,
      unit: definition.unit,
      value: valueFor(sumOf(collectRows(definition, inputs, range)), definition.ratio),
    };
  });
