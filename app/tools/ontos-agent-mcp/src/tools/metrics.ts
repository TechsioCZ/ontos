import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DateTime, Schema } from 'effect';
import { z } from 'zod';
import { computeMetric, metricCatalog } from '../../../../verticals/sales-insights/shared/metrics.ts';
import type {
  Grouping,
  InvoiceInput,
  MetricId,
  MetricInputs,
  OpportunityInput,
  OrderInput,
  TagAssignmentInput,
  TaskInput,
} from '../../../../verticals/sales-insights/shared/metrics.ts';
import { INVOICE_STATES, PAYMENT_STATES } from './billing.ts';
import { readCustomers } from './customers.ts';
import { METRIC_GROUPING_CS } from './labels.ts';
import { ORDER_STATUSES } from './merchandise.ts';
import { OPPORTUNITY_STAGES } from './sales.ts';
import { czkFromMinor, defineTool, readRecordsOf, VERTICAL, CALENDAR_DATE } from './shared.ts';
import { SUBJECT_KINDS } from './tagging.ts';
import { TASK_STATES } from './work.ts';
import { EmployeesWire, MovementWire } from './wire.ts';

/** Metric ids and groupings of sales-insights shared/metrics.ts, listed here so zod can validate them. */
const METRIC_IDS = [
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
] as const satisfies readonly MetricId[];

const GROUPINGS = [
  'day',
  'week',
  'month',
  'employee',
  'customer',
  'product',
  'stage',
  'tag',
] as const satisfies readonly Grouping[];

// The rows below decode only what the engine reads. Enum fields are literal schemas, so the engine's
// input types come from decoding rather than from casts.
const OpportunityRow = Schema.Struct({
  amountMinor: Schema.Number,
  closedAt: Schema.optionalKey(Schema.String),
  expectedCloseDate: Schema.String,
  id: Schema.String,
  ownerEmployeeId: Schema.optionalKey(Schema.String),
  partyId: Schema.String,
  probability: Schema.Number,
  stage: Schema.Literals(OPPORTUNITY_STAGES),
});

const InvoiceRow = Schema.Struct({
  businessState: Schema.Literals(INVOICE_STATES),
  direction: Schema.optionalKey(Schema.Literals(['OUTGOING', 'INCOMING'])),
  issueDate: Schema.String,
  opportunityId: Schema.optionalKey(Schema.String),
  paidMinor: Schema.Number,
  partyId: Schema.optionalKey(Schema.String),
  paymentState: Schema.Literals(PAYMENT_STATES),
  totalMinor: Schema.Number,
});

const OrderRow = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  lines: Schema.Array(Schema.Struct({ productId: Schema.String, quantity: Schema.Number })),
  opportunityId: Schema.optionalKey(Schema.String),
  partyId: Schema.String,
  status: Schema.Literals(ORDER_STATUSES),
});

const TaskRow = Schema.Struct({
  assigneeEmployeeId: Schema.optionalKey(Schema.String),
  dueDate: Schema.optionalKey(Schema.String),
  partyId: Schema.optionalKey(Schema.String),
  state: Schema.Literals(TASK_STATES),
  updatedAt: Schema.String,
});

const ProductRow = Schema.Struct({
  currentPriceMinor: Schema.Number,
  id: Schema.String,
  name: Schema.String,
});

const PipelineRows = Schema.Struct({ items: Schema.Array(OpportunityRow) });
const BillingRows = Schema.Struct({ state: Schema.Struct({ invoices: Schema.Array(InvoiceRow) }) });
const MerchandiseRows = Schema.Struct({
  movements: Schema.Array(MovementWire),
  orders: Schema.Array(OrderRow),
  products: Schema.Array(ProductRow),
});
const WorkRows = Schema.Struct({ items: Schema.Array(TaskRow), referenceDate: Schema.String });
const TaggingRows = Schema.Struct({
  assignments: Schema.Array(
    Schema.Struct({
      subject: Schema.Struct({ id: Schema.String, kind: Schema.Literals(SUBJECT_KINDS) }),
      tagId: Schema.String,
    }),
  ),
  tags: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

export const listMetricsInput = {};

export const getMetricsInput = {
  from: z.string().regex(CALENDAR_DATE).describe('Range start, inclusive, YYYY-MM-DD.'),
  groupBy: z.enum(GROUPINGS).describe('Series grouping. Not every metric supports every grouping; see list_metrics.'),
  metric: z.enum(METRIC_IDS).describe('Metric id from list_metrics.'),
  to: z.string().regex(CALENDAR_DATE).describe('Range end, inclusive, YYYY-MM-DD.'),
};

export const listMetrics = () => ({
  items: metricCatalog.map((entry) => ({
    allowedGroupings: entry.allowedGroupings,
    allowedGroupingsCs: entry.allowedGroupings.map((grouping) => METRIC_GROUPING_CS[grouping] ?? grouping),
    id: entry.id,
    label: entry.label,
    source: entry.source,
    unit: entry.unit,
  })),
});

/**
 * Reads every vertical the metrics need, then maps the wire rows onto the engine's input types.
 * Instants become DateTime.Utc; calendar days stay YYYY-MM-DD strings; money stays in minor units because
 * the engine works in minor units and getMetrics converts the output.
 */
const loadMetricInputs = async (): Promise<{
  readonly inputs: MetricInputs;
  readonly referenceDate: string;
}> => {
  const [customers, employees, pipeline, billing, merchandise, work, tagging] = await Promise.all([
    readCustomers(),
    readRecordsOf(VERTICAL.workforce, EmployeesWire, {}),
    readRecordsOf(VERTICAL.salesPipeline, PipelineRows, {}),
    readRecordsOf(VERTICAL.financeBilling, BillingRows, {}),
    readRecordsOf(VERTICAL.merchandise, MerchandiseRows, {}),
    readRecordsOf(VERTICAL.workTasks, WorkRows, {}),
    readRecordsOf(VERTICAL.tagging, TaggingRows, {}),
  ]);

  const opportunities: OpportunityInput[] = pipeline.items.map((o) => ({
    amountMinor: o.amountMinor,
    closedAt: o.closedAt === undefined ? undefined : DateTime.makeUnsafe(o.closedAt),
    expectedCloseDate: o.expectedCloseDate,
    id: o.id,
    ownerEmployeeId: o.ownerEmployeeId,
    partyId: o.partyId,
    probability: o.probability,
    stage: o.stage,
  }));
  const invoices: InvoiceInput[] = billing.state.invoices.map((invoice) => ({
    businessState: invoice.businessState,
    direction: invoice.direction,
    issueDate: invoice.issueDate,
    opportunityId: invoice.opportunityId,
    paidMinor: invoice.paidMinor,
    partyId: invoice.partyId,
    paymentState: invoice.paymentState,
    totalMinor: invoice.totalMinor,
  }));
  const orders: OrderInput[] = merchandise.orders.map((order) => ({
    createdAt: DateTime.makeUnsafe(order.createdAt),
    id: order.id,
    lines: order.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    opportunityId: order.opportunityId,
    partyId: order.partyId,
    status: order.status,
  }));
  const tasks: TaskInput[] = work.items.map((task) => ({
    assigneeEmployeeId: task.assigneeEmployeeId,
    dueDate: task.dueDate,
    partyId: task.partyId,
    state: task.state,
    updatedAt: DateTime.makeUnsafe(task.updatedAt),
  }));
  const tagAssignments: TagAssignmentInput[] = tagging.assignments.map((assignment) => ({
    subject: { id: assignment.subject.id, kind: assignment.subject.kind },
    tagId: assignment.tagId,
  }));

  return {
    inputs: {
      customers: customers.map((customer) => ({
        id: customer.partyId,
        name: customer.displayName ?? customer.partyId,
      })),
      employees: employees.items.map((employee) => ({ fullName: employee.fullName, id: employee.id })),
      invoices,
      movements: merchandise.movements.map((movement) => ({ delta: movement.delta, productId: movement.productId })),
      opportunities,
      orders,
      products: merchandise.products.map((product) => ({
        currentPriceMinor: product.currentPriceMinor,
        id: product.id,
        name: product.name,
      })),
      tagAssignments,
      tags: tagging.tags.map((tag) => ({ id: tag.id, name: tag.name })),
      tasks,
    },
    // The vertical's business date. Overdue tasks are counted against it, not against wall-clock time.
    referenceDate: work.referenceDate,
  };
};

export const getMetrics = async (input: {
  readonly from: string;
  readonly groupBy: Grouping;
  readonly metric: MetricId;
  readonly to: string;
}) => {
  if (input.from > input.to) {
    throw new Error('Datum from musí být nejvýše stejné jako to.');
  }
  const entry = metricCatalog.find((candidate) => candidate.id === input.metric);
  if (entry === undefined) {
    throw new Error(`Neznámá metrika ${input.metric}. Použijte list_metrics.`);
  }
  if (!entry.allowedGroupings.includes(input.groupBy)) {
    throw new Error(
      `Metrika ${input.metric} nepodporuje seskupení ${input.groupBy}. Povolená: ${entry.allowedGroupings.join(', ')}.`,
    );
  }

  const { inputs, referenceDate } = await loadMetricInputs();
  const result = computeMetric(input.metric, inputs, {
    from: input.from,
    groupBy: input.groupBy,
    to: input.to,
    today: referenceDate,
  });
  // The engine reports CZK in minor units; the tool speaks CZK numbers.
  const scale = (value: number) => (entry.unit === 'CZK' ? czkFromMinor(value) : value);
  return {
    from: input.from,
    groupBy: input.groupBy,
    label: entry.label,
    metric: input.metric,
    referenceDate,
    series: result.series.map((point) => ({ key: point.key, label: point.label, value: scale(point.value) })),
    to: input.to,
    // A ratio with no denominator (e.g. win rate with nothing closed) has no total.
    total: result.total === null ? null : scale(result.total),
    unit: entry.unit,
  };
};

export const registerMetricTools = (server: McpServer): void => {
  defineTool(
    server,
    'list_metrics',
    'List the metric catalog for get_metrics: id, Czech label, unit (CZK, count, percent, pieces) and allowed groupings.',
    listMetricsInput,
    async () => listMetrics(),
  );
  defineTool(
    server,
    'get_metrics',
    'Compute a sales metric (tržby, pipeline, výhry, objednávky, sklad, úkoly) over a date range, optionally grouped by day, week, month, employee, customer, product, stage or tag. CZK values are CZK numbers.',
    getMetricsInput,
    getMetrics,
  );
};
