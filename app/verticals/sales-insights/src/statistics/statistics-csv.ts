import type { MetricPoint, MetricUnit } from '../../shared/metrics.ts';
import { formatMetricValue } from './format-metric.ts';

/** Quote every field and neutralize spreadsheet formulas in user-provided group labels. */
const csvCell = (value: string): string => {
  const safe = /^[\s]*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** Export exactly the displayed table series, including its translated labels and rounding. */
export const statisticsCsv = (
  series: readonly MetricPoint[],
  unit: MetricUnit,
  headers: readonly [string, string],
): string =>
  `﻿${[headers, ...series.map((point) => [point.label, formatMetricValue(point.value, unit)])]
    .map((row) => row.map(csvCell).join(';'))
    .join('\r\n')}`;
