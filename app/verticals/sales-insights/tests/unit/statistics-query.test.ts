import { expect, it } from 'effect-rstest';
import { metricCatalog } from '../../shared/metrics.ts';
import {
  activePreset,
  asCalendarDay,
  chartKinds,
  chartScale,
  coerceGrouping,
  defaultQuery,
  foldSlices,
  isTimeGrouping,
  parseStatisticsQuery,
  presetRange,
  resolveChartKind,
  serializeStatisticsQuery,
} from '../../src/statistics/statistics-query.ts';

const today = '2026-10-13';

it('defaults to the invoiced revenue by month over the last 12 months', () => {
  expect(defaultQuery(today)).toEqual({
    chart: 'bar',
    from: '2025-11-01',
    groupBy: 'month',
    metric: 'revenue_invoiced',
    to: today,
  });
});

it('computes period presets from the reference day', () => {
  expect(presetRange('30d', today)).toEqual({ from: '2026-09-14', to: today });
  expect(presetRange('quarter', today)).toEqual({ from: '2026-10-01', to: today });
  expect(presetRange('quarter', '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-02-10' });
  expect(presetRange('ytd', today)).toEqual({ from: '2026-01-01', to: today });
  expect(presetRange('12m', '2026-01-15')).toEqual({ from: '2025-02-01', to: '2026-01-15' });
});

it('recognises the preset that matches the current range', () => {
  expect(activePreset({ from: '2025-11-01', to: today }, today)).toBe('12m');
  expect(activePreset({ from: '2026-01-02', to: today }, today)).toBeUndefined();
});

it('accepts only calendar days that exist', () => {
  expect(asCalendarDay('2026-02-28')).toBe('2026-02-28');
  expect(asCalendarDay('2026-02-30')).toBeUndefined();
  expect(asCalendarDay('13.10.2026')).toBeUndefined();
  expect(asCalendarDay('')).toBeUndefined();
});

it('round-trips the query through URL search params', () => {
  const query = { ...defaultQuery(today), chart: 'line' as const, groupBy: 'week' as const };
  const search = `?${serializeStatisticsQuery(query)}`;
  expect(parseStatisticsQuery(search, defaultQuery(today))).toEqual(query);
});

it('falls back to defaults for unknown or invalid URL values', () => {
  const fallback = defaultQuery(today);
  const parsed = parseStatisticsQuery('?metric=nope&chart=radar&from=2026-02-30&to=2026-03-31', fallback);
  expect(parsed.metric).toBe(fallback.metric);
  expect(parsed.chart).toBe(fallback.chart);
  expect(parsed.from).toBe(fallback.from);
  expect(parsed.to).toBe('2026-03-31');
});

it('ignores a range whose start is after its end', () => {
  const fallback = defaultQuery(today);
  const parsed = parseStatisticsQuery('?from=2026-05-01&to=2026-04-01', fallback);
  expect(parsed.from).toBe(fallback.from);
  expect(parsed.to).toBe(fallback.to);
});

it('replaces a grouping the metric does not support with its first allowed grouping', () => {
  const entry = metricCatalog.find((candidate) => !candidate.allowedGroupings.includes('employee'));
  expect(entry).toBeDefined();
  if (entry === undefined) {
    return;
  }
  expect(coerceGrouping(entry.id, 'employee')).toBe(entry.allowedGroupings[0]);
  expect(coerceGrouping(entry.id, entry.allowedGroupings[0] ?? 'month')).toBe(entry.allowedGroupings[0]);
});

it('scales CZK to major units for the chart and leaves other units alone', () => {
  expect(chartScale('CZK')).toBe(100);
  expect(chartScale('count')).toBe(1);
  expect(chartScale('percent')).toBe(1);
});

it('folds pie slices beyond the limit into one other slice', () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    key: `p${index + 1}`,
    label: `P${index + 1}`,
    value: 9 - index,
  }));
  const folded = foldSlices(points, 6, 'other', 'Ostatní');
  expect(folded).toHaveLength(6);
  expect(folded.slice(0, 5).map((point) => point.key)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  expect(folded[5]).toEqual({ key: 'other', label: 'Ostatní', value: 4 + 3 + 2 });
  expect(foldSlices(points.slice(0, 6), 6, 'other', 'Ostatní')).toHaveLength(6);
});

it('keeps a pie only for a time series of at most six slices', () => {
  expect(resolveChartKind('pie', 'month', 6)).toBe('pie');
  expect(resolveChartKind('pie', 'month', 7)).toBe('bar-horizontal');
  expect(resolveChartKind('pie', 'employee', 3)).toBe('bar-horizontal');
  expect(resolveChartKind('pie', 'tag', 2)).toBe('bar-horizontal');
  expect(resolveChartKind('bar', 'employee', 3)).toBe('bar');
  expect(resolveChartKind('line', 'month', 12)).toBe('line');
});

it('lists the five chart kinds in the requested order and flags time groupings', () => {
  expect(chartKinds).toEqual(['line', 'area', 'bar', 'bar-horizontal', 'pie']);
  expect(isTimeGrouping('month')).toBe(true);
  expect(isTimeGrouping('customer')).toBe(false);
});
