import { EmptyState, formatDate, SectionCard, StatCard, StatRow } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { KpiValue, MetricCatalogEntry, MetricPoint, MetricResult, MetricUnit } from '../../shared/metrics.ts';
import { formatMetricValue } from './format-metric.ts';
import { chartScale, foldSlices, isTimeGrouping, PIE_SLICE_LIMIT } from './statistics-query.ts';
import type { ChartKind, StatisticsQuery } from './statistics-query.ts';

const key = 'sales-insights.pages.statistics';
const SKELETON_KPI_COUNT = 4;

const KpiRow = ({ kpis }: { readonly kpis: readonly KpiValue[] | undefined }) => (
  <StatRow>
    {kpis === undefined
      ? Array.from({ length: SKELETON_KPI_COUNT }, (_, index) => (
          <Skeleton isLoaded={false} key={`kpi-${index}`}>
            <Skeleton.Rectangle className="h-24 w-full" />
          </Skeleton>
        ))
      : kpis.map((kpi) => <StatCard key={kpi.id} label={kpi.label} value={formatMetricValue(kpi.value, kpi.unit)} />)}
  </StatRow>
);

interface ChartBodyProps {
  readonly ariaLabel: string;
  readonly chart: ChartKind;
  readonly emptyText: string;
  readonly loading: boolean;
  readonly otherLabel: string;
  readonly series: readonly MetricPoint[];
  readonly unit: MetricUnit;
  readonly warning: string | undefined;
}

const UNASSIGNED_KEY = 'none';

/**
 * Sorted horizontal bars in markup, because the chart library gives every mark the same series color and
 * cannot make one row neutral. Unassigned buckets (key `none`) use the neutral foreground color.
 */
interface RankedBarsProps {
  readonly ariaLabel: string;
  readonly points: readonly MetricPoint[];
  readonly unit: MetricUnit;
}

const RankedBars = ({ ariaLabel, points, unit }: RankedBarsProps) => {
  const max = Math.max(0, ...points.map((point) => point.value));
  return (
    <ul aria-label={ariaLabel} className="flex flex-col gap-100">
      {points.map((point) => {
        const unassigned = point.key === UNASSIGNED_KEY;
        const share = max > 0 ? (point.value / max) * 100 : 0;
        return (
          <li
            className="grid grid-cols-[minmax(7rem,14rem)_minmax(0,1fr)_auto] items-center gap-150 text-sm"
            key={point.key}
          >
            <span className="min-w-0 break-words">{point.label}</span>
            <span className="h-4 rounded-sm border border-border-primary">
              <span
                className="block h-full rounded-sm"
                style={{
                  backgroundColor: unassigned ? 'var(--color-fg-secondary)' : 'var(--color-chart-series-1)',
                  opacity: unassigned ? 0.45 : 1,
                  width: `${share}%`,
                }}
              />
            </span>
            <span className="text-end tabular-nums">{formatMetricValue(point.value, unit)}</span>
          </li>
        );
      })}
    </ul>
  );
};

const ChartBody = ({ ariaLabel, chart, emptyText, loading, otherLabel, series, unit, warning }: ChartBodyProps) => {
  if (loading) {
    return (
      <Skeleton isLoaded={false}>
        <Skeleton.Rectangle className="h-70 w-full" />
      </Skeleton>
    );
  }
  if (series.length === 0) {
    return <EmptyState title={emptyText} />;
  }
  const scale = chartScale(unit);
  const points = chart === 'pie' ? foldSlices(series, PIE_SLICE_LIMIT, 'other', otherLabel) : series;
  return (
    <>
      {warning !== undefined && (
        <StatusText showIcon status="warning">
          {warning}
        </StatusText>
      )}
      {chart === 'bar-horizontal' ? (
        <RankedBars ariaLabel={ariaLabel} points={series} unit={unit} />
      ) : (
        <Chart
          ariaLabel={ariaLabel}
          data={points.map((point) => ({ key: point.key, label: point.label, value: point.value / scale }))}
          formatValue={(value) => formatMetricValue(value * scale, unit)}
          height={280}
          points={chart === 'line'}
          type={chart}
          x="label"
          y="value"
        />
      )}
    </>
  );
};

const seriesColumns = (unit: MetricUnit, groupHeader: string, valueHeader: string): ColumnDef<MetricPoint>[] => [
  { accessorKey: 'label', header: groupHeader, meta: { type: 'string' } },
  {
    accessorKey: 'value',
    cell: (info) => formatMetricValue(info.getValue<number>(), unit),
    header: valueHeader,
    meta: { align: 'end', type: 'number' },
  },
];

export interface StatisticsResultsProps {
  readonly kpis: readonly KpiValue[] | undefined;
  readonly loading: boolean;
  readonly metric: MetricCatalogEntry | undefined;
  readonly query: StatisticsQuery;
  readonly result: MetricResult | undefined;
}

/** KPI row, the selected metric as a chart, and its series as a dense table. */
export const StatisticsResults = ({ kpis, loading, metric, query, result }: StatisticsResultsProps) => {
  const { t } = useModernI18n();
  const unit = metric?.unit ?? 'count';
  const title = metric?.label ?? '';
  const from = formatDate(query.from);
  const to = formatDate(query.to);
  const series = result?.series ?? [];
  const timePie = query.chart === 'pie' && isTimeGrouping(query.groupBy);
  const showTable = !loading && series.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-250">
      <KpiRow kpis={loading ? undefined : kpis} />

      <SectionCard
        actions={
          result === undefined ? undefined : (
            <span className="tabular-nums text-sm">
              {t(`${key}.total`, { value: formatMetricValue(result.total, unit) })}
            </span>
          )
        }
        flush
        title={title}
      >
        <div className="flex min-w-0 flex-col gap-150 px-250 pb-250">
          <p className="text-fg-secondary text-sm">{t(`${key}.chartDescription`, { from, to })}</p>
          <ChartBody
            ariaLabel={t(`${key}.chartLabel`, { from, metric: title, to })}
            chart={query.chart}
            emptyText={t(`${key}.empty`)}
            loading={loading || result === undefined}
            otherLabel={t(`${key}.other`)}
            series={series}
            unit={unit}
            warning={timePie ? t(`${key}.pieTimeWarning`) : undefined}
          />
        </div>
      </SectionCard>

      {showTable && (
        <DataTable
          columns={seriesColumns(unit, t(`${key}.table.group`), t(`${key}.table.value`))}
          data={[...series]}
          getRowId={(row) => row.key}
          size="sm"
          translations={{ emptyTitle: t(`${key}.empty`), loadingLabel: t('sales-insights.loading') }}
        />
      )}
    </div>
  );
};
