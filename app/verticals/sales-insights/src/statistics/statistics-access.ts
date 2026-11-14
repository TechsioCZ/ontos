import type { Grouping, MetricId } from '../../shared/metrics.ts';
import type { StatisticsSource } from './use-statistics-inputs.ts';

/**
 * Producer reads each metric cannot be computed without. Names and tags only label groups, so a refused name or
 * tag read leaves the metric's total intact and is not listed here.
 */
const metricSources = {
  invoice_count: ['invoices'],
  opportunities_lost: ['opportunities'],
  opportunities_won: ['opportunities'],
  orders_count: ['orders'],
  pipeline_open_value: ['opportunities'],
  pipeline_weighted_value: ['opportunities'],
  revenue_invoiced: ['invoices'],
  stock_value: ['movements', 'products'],
  tasks_done: ['tasks'],
  tasks_open: ['tasks'],
  tasks_overdue: ['tasks'],
  units_sold: ['orders'],
  unpaid_amount: ['invoices'],
  win_rate: ['opportunities'],
} as const satisfies Record<MetricId, readonly StatisticsSource[]>;

/** True when the role may not read a source the metric needs, so its value is a permission state, not a zero. */
export const isMetricForbidden = (id: MetricId, forbidden: ReadonlySet<StatisticsSource>): boolean => {
  const sources: readonly StatisticsSource[] = metricSources[id];
  return sources.some((source) => forbidden.has(source));
};

/** The KPI row reads invoices and opportunities whatever the metric, so every view needs both. */
const kpiSources: readonly StatisticsSource[] = ['invoices', 'opportunities'];

/** Reads that name the groups of a grouping. Tag groups need every subject id to address their assignments. */
const groupingSources = {
  customer: ['customers'],
  day: [],
  employee: ['employees'],
  month: [],
  product: ['products'],
  stage: [],
  tag: ['customers', 'employees', 'opportunities', 'orders', 'products', 'tags'],
  week: [],
} as const satisfies Record<Grouping, readonly StatisticsSource[]>;

/** The producer reads one view needs. Every other source stays unread until a later view asks for it. */
export const statisticsSourcesFor = (metric: MetricId, groupBy: Grouping): readonly StatisticsSource[] => [
  ...new Set<StatisticsSource>([...kpiSources, ...metricSources[metric], ...groupingSources[groupBy]]),
];
