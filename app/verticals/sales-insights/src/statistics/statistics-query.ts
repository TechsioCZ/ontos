// Pure query state for the Statistiky page: URL parsing, period presets, chart kinds and slice folding.
// No React and no Effect services, so it can be unit-tested directly.
import { DateTime, Option, Schema } from 'effect';
import type { CalendarDay, Grouping, MetricId, MetricPoint, MetricUnit } from '../../shared/metrics.ts';
import { GroupingSchema, MetricIdSchema, metricCatalog } from '../../shared/metrics.ts';

const HORIZONTAL_BAR = 'bar-horizontal' as const;
export const ChartKindSchema = Schema.Literals(['line', 'area', 'bar', HORIZONTAL_BAR, 'pie']);
export type ChartKind = typeof ChartKindSchema.Type;
export const chartKinds: readonly ChartKind[] = ['line', 'area', 'bar', HORIZONTAL_BAR, 'pie'];

export const PresetSchema = Schema.Literals(['30d', 'quarter', 'ytd', '12m']);
export type Preset = typeof PresetSchema.Type;
export const presets: readonly Preset[] = ['30d', 'quarter', 'ytd', '12m'];

/** Pie charts fold anything beyond this many slices into one "Ostatní" slice. */
export const PIE_SLICE_LIMIT = 6;

export interface StatisticsQuery {
  readonly chart: ChartKind;
  readonly from: CalendarDay;
  readonly groupBy: Grouping;
  readonly metric: MetricId;
  readonly to: CalendarDay;
}

const DAY_MS = 86_400_000;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

const instantOf = (day: CalendarDay): DateTime.Utc => DateTime.makeUnsafe(`${day}T00:00:00Z`);
const dayOf = (instant: DateTime.DateTime): CalendarDay => DateTime.formatIsoDateUtc(instant);
const padMonth = (month: number): string => String(month).padStart(2, '0');
const yearOf = (day: CalendarDay): number => Number(day.slice(0, 4));
const monthOf = (day: CalendarDay): number => Number(day.slice(5, 7));

/** Accepts `YYYY-MM-DD` only when the date exists in the calendar. */
export const asCalendarDay = (value: string): CalendarDay | undefined => {
  if (!dayPattern.test(value)) {
    return undefined;
  }
  const parsed = Option.getOrUndefined(DateTime.make(`${value}T00:00:00Z`));
  return parsed !== undefined && dayOf(parsed) === value ? value : undefined;
};

const presetFrom = {
  '12m': (today: CalendarDay): CalendarDay => {
    const index = yearOf(today) * 12 + (monthOf(today) - 1) - 11;
    return `${Math.floor(index / 12)}-${padMonth((index % 12) + 1)}-01`;
  },
  '30d': (today: CalendarDay): CalendarDay =>
    dayOf(DateTime.makeUnsafe(DateTime.toEpochMillis(instantOf(today)) - 29 * DAY_MS)),
  quarter: (today: CalendarDay): CalendarDay =>
    `${yearOf(today)}-${padMonth(Math.floor((monthOf(today) - 1) / 3) * 3 + 1)}-01`,
  ytd: (today: CalendarDay): CalendarDay => `${yearOf(today)}-01-01`,
} satisfies Record<Preset, (today: CalendarDay) => CalendarDay>;

/** Inclusive calendar range for a preset, ending on the reference day. */
export const presetRange = (preset: Preset, today: CalendarDay) => ({
  from: presetFrom[preset](today),
  to: today,
});

/** The preset whose range equals the query's range, if any. */
export const activePreset = (
  range: { readonly from: CalendarDay; readonly to: CalendarDay },
  today: CalendarDay,
): Preset | undefined =>
  presets.find((preset) => {
    const candidate = presetRange(preset, today);
    return candidate.from === range.from && candidate.to === range.to;
  });

export const defaultQuery = (today: CalendarDay): StatisticsQuery => ({
  chart: 'bar',
  groupBy: 'month',
  metric: 'revenue_invoiced',
  ...presetRange('12m', today),
});

/** Keeps the grouping only when the metric supports it; otherwise falls back to the metric's first grouping. */
export const coerceGrouping = (metric: MetricId, groupBy: Grouping): Grouping => {
  const entry = metricCatalog.find((candidate) => candidate.id === metric);
  if (entry === undefined || entry.allowedGroupings.includes(groupBy)) {
    return groupBy;
  }
  return entry.allowedGroupings[0] ?? groupBy;
};

export const isTimeGrouping = (groupBy: Grouping): boolean =>
  groupBy === 'day' || groupBy === 'week' || groupBy === 'month';

export interface DayRange {
  readonly from: CalendarDay;
  readonly to: CalendarDay;
}

export const isInvertedRange = (range: DayRange): boolean => range.from > range.to;

/**
 * The URL range when it holds two valid days whose start is after their end. The query itself falls back to
 * the default period, so the picker shows this range with a validation error instead.
 */
export const invertedRangeOf = (search: string): DayRange | undefined => {
  const params = new URLSearchParams(search);
  const from = asCalendarDay(params.get('from') ?? '');
  const to = asCalendarDay(params.get('to') ?? '');
  return from !== undefined && to !== undefined && isInvertedRange({ from, to }) ? { from, to } : undefined;
};

/** Reads the query from URL search params. Anything invalid falls back to the default for that field. */
export const parseStatisticsQuery = (search: string, fallback: StatisticsQuery): StatisticsQuery => {
  const params = new URLSearchParams(search);
  const from = asCalendarDay(params.get('from') ?? '') ?? fallback.from;
  const to = asCalendarDay(params.get('to') ?? '') ?? fallback.to;
  const ordered = from <= to ? { from, to } : { from: fallback.from, to: fallback.to };
  const metricParam = params.get('metric');
  const metric = Schema.is(MetricIdSchema)(metricParam) ? metricParam : fallback.metric;
  const chartParam = params.get('chart');
  const chart = Schema.is(ChartKindSchema)(chartParam) ? chartParam : fallback.chart;
  const groupParam = params.get('group');
  const groupBy = Schema.is(GroupingSchema)(groupParam) ? groupParam : fallback.groupBy;
  return {
    chart,
    from: ordered.from,
    groupBy: coerceGrouping(metric, groupBy),
    metric,
    to: ordered.to,
  };
};

/**
 * The grouping the URL asks for, before a metric that does not offer it falls back. The URL keeps it, so switching
 * metric and back restores the grouping instead of losing it to the fallback.
 */
export const requestedGroupingOf = (search: string): Grouping | undefined => {
  const groupParam = new URLSearchParams(search).get('group');
  return Schema.is(GroupingSchema)(groupParam) ? groupParam : undefined;
};

export const serializeStatisticsQuery = (query: StatisticsQuery): string =>
  new URLSearchParams({
    chart: query.chart,
    from: query.from,
    group: query.groupBy,
    metric: query.metric,
    to: query.to,
  }).toString();

/** Chart values are plotted in major units: CZK minor units (haléře) are divided by 100. */
export const chartScale = (unit: MetricUnit): number => (unit === 'CZK' ? 100 : 1);

/** Keeps the first `limit - 1` slices and sums the rest into one "other" slice. */
export const foldSlices = (
  points: readonly MetricPoint[],
  limit: number,
  otherKey: string,
  otherLabel: string,
): readonly MetricPoint[] => {
  if (points.length <= limit) {
    return points;
  }
  const head = points.slice(0, limit - 1);
  const rest = points.slice(limit - 1);
  return [...head, { key: otherKey, label: otherLabel, value: rest.reduce((sum, point) => sum + point.value, 0) }];
};

/**
 * Pie slices: positive values only (a pie cannot draw zero or negative shares), largest first, at most
 * `limit` slices. An existing "other" point from the categorical series joins the folded remainder, so the
 * pie never shows two "Ostatní" slices.
 */
export const pieSlices = (
  points: readonly MetricPoint[],
  limit: number,
  otherKey: string,
  otherLabel: string,
): readonly MetricPoint[] => {
  const existingOther = points.find((point) => point.key === otherKey);
  const ranked = points
    .filter((point) => point.key !== otherKey && point.value > 0)
    .toSorted((a, b) => b.value - a.value);
  const otherValue = existingOther !== undefined && existingOther.value > 0 ? existingOther.value : 0;
  if (otherValue === 0) {
    return foldSlices(ranked, limit, otherKey, otherLabel);
  }
  const head = ranked.slice(0, limit - 1);
  const restValue = ranked.slice(limit - 1).reduce((sum, point) => sum + point.value, 0);
  return [...head, { key: otherKey, label: otherLabel, value: otherValue + restValue }];
};

/**
 * Rounds each point to whole units of `step` (100 haléřů = 1 Kč) so the rounded rows add up to the rounded
 * total, using the largest-remainder method. Applies only when the rows partition the total; a series whose
 * rows overlap (a record under several tags) is rounded row by row.
 */
export const roundSeriesToTotal = (
  points: readonly MetricPoint[],
  total: number,
  step: number,
): readonly MetricPoint[] => {
  const exactSum = points.reduce((sum, point) => sum + point.value, 0);
  if (points.length === 0 || Math.abs(exactSum - total) >= step / 2) {
    return points.map((point) => ({ ...point, value: Math.round(point.value / step) * step }));
  }
  const floors = points.map((point) => Math.floor(point.value / step));
  const target = Math.round(total / step);
  const missing = target - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = points
    .map((point, index) => ({ index, remainder: point.value / step - (floors[index] ?? 0) }))
    .toSorted((a, b) => b.remainder - a.remainder || a.index - b.index);
  const bumped = new Set(byRemainder.slice(0, Math.max(0, missing)).map((entry) => entry.index));
  return points.map((point, index) => ({
    ...point,
    value: ((floors[index] ?? 0) + (bumped.has(index) ? 1 : 0)) * step,
  }));
};
