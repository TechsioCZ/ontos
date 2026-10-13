import { formatMoney, formatNumber } from '@app/admin-ui';
import { Match } from 'effect';
import type { MetricUnit } from '../../shared/metrics.ts';

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
