import { EmptyState, SectionCard, StatCard, StatRow } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { isSnapshotMetric } from '../../shared/metrics.ts';
import type {
  Grouping,
  KpiValue,
  MetricCatalogEntry,
  MetricId,
  MetricPoint,
  MetricResult,
  MetricUnit,
  PipelineSummary,
} from '../../shared/metrics.ts';
import { formatAxisValue, formatMetricValue, formatPeriodDay } from './format-metric.ts';
import { PipelineSummaryCard } from './pipeline-summary-card.tsx';
import { chartScale, isTimeGrouping, PIE_SLICE_LIMIT, pieSlices, roundSeriesToTotal } from './statistics-query.ts';
import type { ChartKind, StatisticsQuery } from './statistics-query.ts';

const key = 'sales-insights.pages.statistics';
const SKELETON_KPI_COUNT = 4;

const KpiRow = ({
  isForbidden,
  kpis,
  loadingLabel,
  noAccessLabel,
}: {
  readonly isForbidden: (id: MetricId) => boolean;
  readonly kpis: readonly KpiValue[] | undefined;
  /** Accessible name of the loading skeletons; ui-kit's default is English. */
  readonly loadingLabel: string;
  readonly noAccessLabel: string;
}) => (
  <StatRow>
    {kpis === undefined
      ? Array.from({ length: SKELETON_KPI_COUNT }, (_, index) => (
          <Skeleton aria-label={loadingLabel} isLoaded={false} key={`kpi-${index}`}>
            <Skeleton.Rectangle className="h-24 w-full" />
          </Skeleton>
        ))
      : kpis.map((kpi) =>
          // A tile the role may not read says so instead of showing 0 Kč.
          isForbidden(kpi.id) ? (
            <StatCard hint={noAccessLabel} key={kpi.id} label={kpi.label} value="—" />
          ) : (
            <StatCard key={kpi.id} label={kpi.label} value={formatMetricValue(kpi.value, kpi.unit)} />
          ),
        )}
  </StatRow>
);

interface ChartBodyProps {
  readonly ariaLabel: string;
  readonly chart: ChartKind;
  readonly emptyText: string;
  readonly loading: boolean;
  /** Accessible name of the loading skeleton; ui-kit's default is English. */
  readonly loadingLabel: string;
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
    // The rows share one set of tracks, so every bar track has the same width. On phones the label takes a line of
    // its own and the bar keeps the room beside the value.
    <ul
      aria-label={ariaLabel}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-150 gap-y-100 text-sm md:grid-cols-[minmax(7rem,14rem)_minmax(0,1fr)_auto]"
    >
      {points.map((point) => {
        const unassigned = point.key === UNASSIGNED_KEY;
        const share = max > 0 ? (point.value / max) * 100 : 0;
        return (
          <li className="col-span-full grid grid-cols-subgrid items-center" key={point.key}>
            <span className="col-span-2 min-w-0 break-words md:col-span-1">{point.label}</span>
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

const ChartBody = ({
  ariaLabel,
  chart,
  emptyText,
  loading,
  loadingLabel,
  otherLabel,
  series,
  unit,
  warning,
}: ChartBodyProps) => {
  if (loading) {
    return (
      <Skeleton aria-label={loadingLabel} isLoaded={false}>
        <Skeleton.Rectangle className="h-70 w-full" />
      </Skeleton>
    );
  }
  if (series.length === 0) {
    return <EmptyState title={emptyText} />;
  }
  const scale = chartScale(unit);
  // A pie shows the largest positive slices; the rest fold into one "Ostatní" slice.
  const points = chart === 'pie' ? pieSlices(series, PIE_SLICE_LIMIT, 'other', otherLabel) : series;
  if (points.length === 0) {
    return <EmptyState title={emptyText} />;
  }
  return (
    <>
      {warning !== undefined && (
        <StatusText showIcon size="sm" status="warning">
          {warning}
        </StatusText>
      )}
      {chart === 'bar-horizontal' ? (
        <RankedBars ariaLabel={ariaLabel} points={series} unit={unit} />
      ) : (
        <Chart
          ariaLabel={ariaLabel}
          data={points.map((point) => ({ key: point.key, label: point.label, value: point.value / scale }))}
          formatValue={(value) => formatAxisValue(value * scale, unit)}
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

const seriesColumns = (
  unit: MetricUnit,
  groupBy: Grouping,
  groupHeader: string,
  valueHeader: string,
): ColumnDef<MetricPoint>[] => [
  // Time groups sort by their ISO period key; the Czech label would sort "bře" before "led".
  isTimeGrouping(groupBy)
    ? { accessorKey: 'key', cell: (info) => info.row.original.label, header: groupHeader, meta: { type: 'string' } }
    : { accessorKey: 'label', header: groupHeader, meta: { type: 'string' } },
  {
    accessorKey: 'value',
    cell: (info) => formatMetricValue(info.getValue<number>(), unit),
    header: valueHeader,
    meta: { align: 'end', type: 'number' },
  },
];

/** A pie shows shares of a whole: rates are not shares, and a time series reads better as bars. */
const pieWarningKey = (query: StatisticsQuery, unit: MetricUnit): 'pieRateWarning' | 'pieTimeWarning' | undefined => {
  if (query.chart !== 'pie') {
    return undefined;
  }
  if (unit === 'percent') {
    return 'pieRateWarning';
  }
  return isTimeGrouping(query.groupBy) ? 'pieTimeWarning' : undefined;
};

export interface StatisticsResultsProps {
  /** Metrics whose data this role may not read: their tiles and chart show a permission state. */
  readonly isForbidden: (id: MetricId) => boolean;
  readonly kpis: readonly KpiValue[] | undefined;
  readonly loading: boolean;
  readonly metric: MetricCatalogEntry | undefined;
  /** Open pipeline today next to the period's opened and closed opportunities. */
  readonly pipeline: PipelineSummary | undefined;
  readonly query: StatisticsQuery;
  readonly result: MetricResult | undefined;
}

/** Whole-Kč rows that add up to the whole-Kč total, so the table never disagrees with "Celkem" by rounding. */
const displayedSeries = (result: MetricResult | undefined, unit: MetricUnit): readonly MetricPoint[] => {
  const rawSeries = result?.series ?? [];
  return unit === 'CZK' && result !== undefined && result.total !== null
    ? roundSeriesToTotal(rawSeries, result.total, chartScale(unit))
    : rawSeries;
};

/** KPI row, the pipeline card, the selected metric as a chart, and its series as a dense table. */
export const StatisticsResults = ({
  isForbidden,
  kpis,
  loading,
  metric,
  pipeline,
  query,
  result,
}: StatisticsResultsProps) => {
  const { t } = useModernI18n();
  const unit = metric?.unit ?? 'count';
  const title = metric?.label ?? '';
  const from = formatPeriodDay(query.from);
  const to = formatPeriodDay(query.to);
  const blocked = !loading && isForbidden(query.metric);
  const series = blocked ? [] : displayedSeries(result, unit);
  const pieWarning = pieWarningKey(query, unit);
  const showTable = !loading && series.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-250">
      <KpiRow
        isForbidden={isForbidden}
        kpis={loading ? undefined : kpis}
        loadingLabel={t('sales-insights.loadingContent')}
        noAccessLabel={t(`${key}.noAccess`)}
      />

      <PipelineSummaryCard
        forbidden={isForbidden('pipeline_open_value')}
        from={query.from}
        loading={loading}
        summary={pipeline}
        to={query.to}
      />

      <SectionCard
        actions={
          result === undefined || blocked ? undefined : (
            <span className="tabular-nums text-sm">
              {t(unit === 'percent' ? `${key}.rateTotal` : `${key}.total`, {
                value: formatMetricValue(result.total, unit),
              })}
            </span>
          )
        }
        flush
        title={title}
      >
        <div className="flex min-w-0 flex-col gap-150 px-250 pb-250">
          <p className="text-fg-secondary text-sm">{t(`${key}.chartDescription`, { from, to })}</p>
          {isSnapshotMetric(query.metric) && <p className="text-fg-secondary text-sm">{t(`${key}.snapshotNote`)}</p>}
          {query.metric === 'stock_value' && <p className="text-fg-secondary text-sm">{t(`${key}.stockNote`)}</p>}
          {query.groupBy === 'tag' && <p className="text-fg-secondary text-sm">{t(`${key}.tagNote`)}</p>}
          <ChartBody
            ariaLabel={t(`${key}.chartLabel`, { from, metric: title, to })}
            chart={query.chart}
            emptyText={blocked ? t(`${key}.noAccessMetric`) : t(`${key}.empty`)}
            loading={loading || (result === undefined && !blocked)}
            loadingLabel={t('sales-insights.loadingContent')}
            otherLabel={t(`${key}.other`)}
            series={series}
            unit={unit}
            warning={pieWarning === undefined ? undefined : t(`${key}.${pieWarning}`)}
          />
        </div>
      </SectionCard>

      {showTable && (
        <DataTable
          // A new grouping starts unsorted, so a sort chosen for the previous grouping does not carry over.
          columns={seriesColumns(unit, query.groupBy, t(`${key}.table.group`), t(`${key}.table.value`))}
          data={[...series]}
          getRowId={(row) => row.key}
          key={query.groupBy}
          maxHeight="calc(100dvh - 15rem)"
          size="sm"
          stickyHeader
          translations={{ emptyTitle: t(`${key}.empty`), loadingLabel: t('sales-insights.loading') }}
        />
      )}
    </div>
  );
};
