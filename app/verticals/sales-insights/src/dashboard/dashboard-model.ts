import { computeMetric, computePipelineSummary } from '../../shared/metrics.ts';
import type { CalendarDay, MetricInputs, MetricUnit } from '../../shared/metrics.ts';
import { Schema } from 'effect';

const DashboardMetricSchema = Schema.Literals([
  'opportunities_open',
  'pipeline_open_value',
  'unpaid_amount',
  'tasks_open',
  'tasks_overdue',
]);
export type DashboardMetric = typeof DashboardMetricSchema.Type;
export const DashboardSourceSchema = Schema.Literals(['opportunities', 'invoices', 'tasks']);
export type DashboardSource = typeof DashboardSourceSchema.Type;
export const DashboardSourceStateSchema = Schema.Literals(['empty', 'forbidden', 'ready', 'unavailable']);
export type DashboardSourceState = typeof DashboardSourceStateSchema.Type;
export interface DashboardValue {
  readonly href: string;
  readonly id: DashboardMetric;
  readonly source: DashboardSource;
  readonly state: DashboardSourceState;
  readonly unit: MetricUnit;
  readonly value?: number;
}
const dashboardMetrics: readonly DashboardMetric[] = [
  'opportunities_open',
  'pipeline_open_value',
  'unpaid_amount',
  'tasks_open',
  'tasks_overdue',
];

const metricSource = {
  opportunities_open: 'opportunities',
  pipeline_open_value: 'opportunities',
  tasks_open: 'tasks',
  tasks_overdue: 'tasks',
  unpaid_amount: 'invoices',
} as const satisfies Record<DashboardMetric, DashboardSource>;
const sourcePaths = {
  invoices: '/finance',
  opportunities: '/prodej/prilezitosti',
  tasks: '/ukoly',
} as const satisfies Record<DashboardSource, string>;

/** Current-state metrics use the existing owner semantics. All-time invoices are not silently date-filtered. */
export const dashboardValues = (
  inputs: MetricInputs,
  states: Readonly<Record<DashboardSource, DashboardSourceState>>,
  today: CalendarDay,
): readonly DashboardValue[] => {
  const range = { from: '0001-01-01', to: '9999-12-31', today };
  const { open } = computePipelineSummary(inputs, range);
  const totals = {
    opportunities_open: open.count,
    pipeline_open_value: open.valueMinor,
    tasks_open: computeMetric('tasks_open', inputs, { ...range, groupBy: 'employee' }).total ?? 0,
    tasks_overdue: computeMetric('tasks_overdue', inputs, { ...range, groupBy: 'employee' }).total ?? 0,
    unpaid_amount: computeMetric('unpaid_amount', inputs, { ...range, groupBy: 'month' }).total ?? 0,
  };
  return dashboardMetrics.map((id) => {
    const source = metricSource[id];
    const state = states[source];
    const base = {
      href: sourcePaths[source],
      id,
      source,
      state,
      unit: id === 'pipeline_open_value' || id === 'unpaid_amount' ? ('CZK' as const) : ('count' as const),
    };
    return state === 'forbidden' || state === 'unavailable' ? base : { ...base, value: totals[id] };
  });
};
