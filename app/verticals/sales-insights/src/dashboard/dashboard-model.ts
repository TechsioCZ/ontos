import { computeMetric, computePipelineSummary } from '../../shared/metrics.ts';
import type { CalendarDay, MetricInputs, MetricUnit } from '../../shared/metrics.ts';
import { Schema } from 'effect';

export const DashboardMetricSchema = Schema.Literals([
  'opportunities_open',
  'pipeline_open_value',
  'unpaid_amount',
  'tasks_open',
  'tasks_overdue',
]);
export type DashboardMetric = typeof DashboardMetricSchema.Type;
export const DashboardDisplaySchema = Schema.Literals(['cards', 'list']);
export const DashboardPreferencesSchema = Schema.Struct({
  display: DashboardDisplaySchema,
  metrics: Schema.Array(DashboardMetricSchema).check(Schema.isMaxLength(5)),
  version: Schema.Literal(1),
});
export type DashboardPreferences = typeof DashboardPreferencesSchema.Type;
export interface DashboardContext {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
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
export const defaultDashboardPreferences: DashboardPreferences = {
  display: 'cards',
  metrics: ['opportunities_open', 'pipeline_open_value', 'unpaid_amount', 'tasks_open', 'tasks_overdue'],
  version: 1,
};
export const dashboardPreferencesKey = (context: DashboardContext): string =>
  `ontos:crm-dashboard:v1:${encodeURIComponent(context.principalId)}:${encodeURIComponent(context.tenantId)}:${encodeURIComponent(context.legalEntityId)}`;

const metricSource = {
  opportunities_open: 'opportunities',
  pipeline_open_value: 'opportunities',
  tasks_open: 'tasks',
  tasks_overdue: 'tasks',
  unpaid_amount: 'invoices',
} as const satisfies Record<DashboardMetric, DashboardSource>;
const sourcePaths = {
  invoices: '/siampark/finance',
  opportunities: '/prodej/prilezitosti',
  tasks: '/siampark/work',
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
  return defaultDashboardPreferences.metrics.map((id) => {
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
