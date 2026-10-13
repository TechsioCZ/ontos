import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DateTime } from 'effect';
import { z } from 'zod';
import {
  computeMetric,
  metricCatalog,
  type Grouping,
  type InvoiceInput,
  type MetricId,
  type MetricInputs,
  type OpportunityInput,
  type OpportunityStage,
  type OrderInput,
  type TagAssignmentInput,
  type TaskInput,
} from '../../../../verticals/sales-insights/shared/metrics.ts';
import { readCustomers } from './customers.ts';
import { METRIC_GROUPING_CS } from './labels.ts';
import { czkFromMinor, defineTool, readRecordsOf, VERTICAL, CALENDAR_DATE } from './shared.ts';
import type {
  BillingRecordsWire,
  EmployeeWire,
  MerchandiseRecordsWire,
  OpportunitiesRecordsWire,
  TaggingRecordsWire,
  WorkRecordsWire,
} from './wire.ts';

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

export const listMetricsInput = {};

export const getMetricsInput = {
  from: z.string().regex(CALENDAR_DATE).describe('Range start, inclusive, YYYY-MM-DD.'),
  groupBy: z.enum(GROUPINGS).describe('Series grouping. Not every metric supports every grouping; see list_metrics.'),
  metric: z.enum(METRIC_IDS).describe('Metric id from list_metrics.'),
  to: z.string().regex(CALENDAR_DATE).describe('Range end, inclusive, YYYY-MM-DD.'),
};

export function listMetrics() {
  return {
    items: metricCatalog.map((entry) => ({
      allowedGroupings: entry.allowedGroupings,
      allowedGroupingsCs: entry.allowedGroupings.map((grouping) => METRIC_GROUPING_CS[grouping] ?? grouping),
      id: entry.id,
      label: entry.label,
      source: entry.source,
      unit: entry.unit,
    })),
  };
}

/**
 * Reads every vertical the metrics need, then maps the wire rows onto the engine's input types.
 * Instants become DateTime.Utc; calendar days stay YYYY-MM-DD strings; money stays in minor units because
 * the engine works in minor units and getMetrics converts the output.
 */
async function loadMetricInputs(): Promise<{ readonly inputs: MetricInputs; readonly referenceDate: string }> {
  const [customers, employees, pipeline, billing, merchandise, work, tagging] = await Promise.all([
    readCustomers(),
    readRecordsOf<{ readonly items: readonly EmployeeWire[] }>(VERTICAL.workforce, {}),
    readRecordsOf<OpportunitiesRecordsWire>(VERTICAL.salesPipeline, {}),
    readRecordsOf<BillingRecordsWire>(VERTICAL.siamparkBilling, {}),
    readRecordsOf<MerchandiseRecordsWire>(VERTICAL.merchandise, {}),
    readRecordsOf<WorkRecordsWire>(VERTICAL.siamparkWork, {}),
    readRecordsOf<TaggingRecordsWire>(VERTICAL.tagging, {}),
  ]);

  const opportunities: OpportunityInput[] = pipeline.items.map((o) => ({
    amountMinor: o.amountMinor,
    ...(o.closedAt === undefined ? {} : { closedAt: DateTime.makeUnsafe(o.closedAt) }),
    expectedCloseDate: o.expectedCloseDate,
    id: o.id,
    ownerEmployeeId: o.ownerEmployeeId,
    partyId: o.partyId,
    probability: o.probability,
    // The vertical's stage enum; the engine mirrors the same literals.
    stage: o.stage as OpportunityStage,
  }));
  const invoices: InvoiceInput[] = billing.state.invoices.map((invoice) => ({
    businessState: invoice.businessState as InvoiceInput['businessState'],
    direction: invoice.direction as InvoiceInput['direction'],
    issueDate: invoice.issueDate,
    opportunityId: invoice.opportunityId,
    paidMinor: invoice.paidMinor,
    partyId: invoice.partyId,
    paymentState: invoice.paymentState as InvoiceInput['paymentState'],
    totalMinor: invoice.totalMinor,
  }));
  const orders: OrderInput[] = merchandise.orders.map((order) => ({
    createdAt: DateTime.makeUnsafe(order.createdAt),
    id: order.id,
    lines: order.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    opportunityId: order.opportunityId,
    partyId: order.partyId,
    status: order.status as OrderInput['status'],
  }));
  const tasks: TaskInput[] = work.items.map((task) => ({
    assigneeEmployeeId: task.assigneeEmployeeId,
    dueDate: task.dueDate,
    partyId: task.partyId,
    state: task.state as TaskInput['state'],
    updatedAt: DateTime.makeUnsafe(task.updatedAt),
  }));
  const tagAssignments: TagAssignmentInput[] = tagging.assignments.map((assignment) => ({
    subject: { id: assignment.subject.id, kind: assignment.subject.kind as TagAssignmentInput['subject']['kind'] },
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
}

export async function getMetrics(input: {
  readonly from: string;
  readonly groupBy: Grouping;
  readonly metric: MetricId;
  readonly to: string;
}) {
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
    total: scale(result.total),
    unit: entry.unit,
  };
}

export function registerMetricTools(server: McpServer): void {
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
}
