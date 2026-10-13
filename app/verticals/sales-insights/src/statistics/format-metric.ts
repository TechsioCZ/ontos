import { formatMoney, formatNumber } from '@app/admin-ui';
import { Match } from 'effect';
import type { MetricUnit } from '../../shared/metrics.ts';

/** CZK values arrive in minor units (haléře); percent arrives as a number of percent points. */
export const formatMetricValue = (value: number, unit: MetricUnit): string =>
  Match.value(unit).pipe(
    Match.when('CZK', () => formatMoney(Math.round(value))),
    Match.when('percent', () => `${formatNumber(value)} %`),
    Match.whenOr('count', 'pieces', () => `${formatNumber(value)} ks`),
    Match.exhaustive,
  );
