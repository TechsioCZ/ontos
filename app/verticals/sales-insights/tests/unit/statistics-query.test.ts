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
  invertedRangeOf,
  isTimeGrouping,
  parseStatisticsQuery,
  pieSlices,
  presetRange,
  requestedGroupingOf,
  roundSeriesToTotal,
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

it('returns a URL range whose end is before its start, and only for valid days', () => {
  expect(invertedRangeOf('?from=2026-05-01&to=2026-04-01')).toEqual({ from: '2026-05-01', to: '2026-04-01' });
  expect(invertedRangeOf('?from=2026-04-01&to=2026-05-01')).toBeUndefined();
  expect(invertedRangeOf('?from=2026-05-01&to=2026-05-01')).toBeUndefined();
  expect(invertedRangeOf('?from=2026-05-01&to=2026-02-30')).toBeUndefined();
  expect(invertedRangeOf('')).toBeUndefined();
});

it('builds pie slices from positive values, largest first, with a single other slice', () => {
  const points = [
    { key: 'a', label: 'A', value: 1 },
    { key: 'b', label: 'B', value: 5 },
    { key: 'zero', label: 'Nula', value: 0 },
    { key: 'c', label: 'C', value: 3 },
    { key: 'other', label: 'Ostatní', value: 2 },
  ];
  expect(pieSlices(points, 3, 'other', 'Ostatní')).toEqual([
    { key: 'b', label: 'B', value: 5 },
    { key: 'c', label: 'C', value: 3 },
    { key: 'other', label: 'Ostatní', value: 2 + 1 },
  ]);
  expect(pieSlices(points.slice(0, 4), 6, 'other', 'Ostatní').map((point) => point.key)).toEqual(['b', 'c', 'a']);
  expect(pieSlices([{ key: 'n', label: 'N', value: -4 }], 6, 'other', 'Ostatní')).toEqual([]);
});

it('rounds a partitioning CZK series so the rows add up to the rounded total', () => {
  // 3 × 10,33 Kč = 30,99 Kč: rounding each row gives 30 Kč against a 31 Kč total.
  const points = [
    { key: 'm1', label: 'M1', value: 1033 },
    { key: 'm2', label: 'M2', value: 1033 },
    { key: 'm3', label: 'M3', value: 1033 },
  ];
  const rounded = roundSeriesToTotal(points, 3099, 100);
  expect(rounded.reduce((sum, point) => sum + point.value, 0)).toBe(3100);
  expect(rounded.map((point) => point.value)).toEqual([1100, 1000, 1000]);
  // Overlapping rows (a record under several tags) do not partition the total: each row rounds on its own.
  expect(roundSeriesToTotal(points, 2000, 100).map((point) => point.value)).toEqual([1000, 1000, 1000]);
});

it('lists the five chart kinds in the requested order and flags time groupings', () => {
  expect(chartKinds).toEqual(['line', 'area', 'bar', 'bar-horizontal', 'pie']);
  expect(isTimeGrouping('month')).toBe(true);
  expect(isTimeGrouping('customer')).toBe(false);
});

it('keeps the requested grouping in the URL so a metric switch can restore it', () => {
  const search = 'metric=stock_value&group=month';
  expect(parseStatisticsQuery(search, defaultQuery(today)).groupBy).toBe('product');
  expect(requestedGroupingOf(search)).toBe('month');
  expect(requestedGroupingOf('group=unknown')).toBeUndefined();
});
