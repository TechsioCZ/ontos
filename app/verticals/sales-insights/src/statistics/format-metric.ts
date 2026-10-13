import { formatMoney, formatNumber } from '@app/admin-ui';
import { Match } from 'effect';
import type { MetricUnit } from '../../shared/metrics.ts';

/**
 * CZK values arrive in minor units (haléře) and display as whole Kč. Percent arrives as a number of
 * percent points. Counts and pieces show a bare number; the metric label already names the unit.
 */
export const formatMetricValue = (value: number, unit: MetricUnit): string =>
  Match.value(unit).pipe(
    Match.when('CZK', () => formatMoney(Math.round(value / 100) * 100)),
    Match.when('percent', () => `${formatNumber(value)} %`),
    Match.whenOr('count', 'pieces', () => formatNumber(value)),
    Match.exhaustive,
  );
