import { formatMoney, formatNumber } from '@app/admin-ui';
import { Match } from 'effect';
import type { CalendarDay, MetricUnit } from '../../shared/metrics.ts';

/**
 * CZK values arrive in minor units (haléře) and display as whole Kč. Percent arrives as a number of
 * percent points. Pieces carry the unit `ks`; plain counts show a bare number. A `null` value (a rate with
 * nothing to divide) shows a dash.
 */
export const formatMetricValue = (value: number | null, unit: MetricUnit): string => {
  if (value === null) {
    return '—';
  }
  return Match.value(unit).pipe(
    Match.when('CZK', () => formatMoney(Math.round(value / 100) * 100)),
    Match.when('percent', () => `${formatNumber(value)} %`),
    Match.when('pieces', () => `${formatNumber(value)} ks`),
    Match.when('count', () => formatNumber(value)),
    Match.exhaustive,
  );
};

/**
 * Value-axis tick label. Counts and pieces are whole numbers, but the chart picks half steps for small ranges
 * (0,5 / 1,5), so a fractional tick of such a unit gets no label; its grid line stays.
 */
export const formatAxisValue = (value: number, unit: MetricUnit): string =>
  (unit === 'count' || unit === 'pieces') && !Number.isInteger(value) ? '' : formatMetricValue(value, unit);

/** `2025-11-01` → `1. 11. 2025`: the Czech day form the period line uses, with a space after each dot. */
export const formatPeriodDay = (day: CalendarDay): string => {
  const [year = '', month = '', date = ''] = day.split('-');
  return `${Number(date)}. ${Number(month)}. ${year}`;
};
