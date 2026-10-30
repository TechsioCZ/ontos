import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Facility operations — Měřidla a energie (S04). OWNED BY THE `meters` LANE (ops-meters).
// List of meters with last reading, truthful consumption and anomaly highlight → detail side panel with history and
// chart → record reading / edit meter; consumption and costs per property/unit below the list.
import {
  EmptyState,
  PageHeader,
  SidePanel,
  StatCard,
  StatRow,
  formatDate,
  formatMoney,
  matchesSearch,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { DateTime, Option, Schema } from 'effect';
import {
  daysBetween,
  latestRow,
  meterMedia,
  monthlySeries,
  validReadingsOf,
} from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium } from '../../../../../shared/domain/meters.ts';
import { AgendaFrame, AgendaGate } from '../../../../ui/agenda-frame.tsx';
import { preloadAgendaRecords, useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { ConsumptionByPlace } from './consumption-by-place.tsx';
import { MeterDetail } from './meter-detail.tsx';
import type { DetailMode } from './meter-detail.tsx';
import { MeterForm, ReadingForm } from './meter-forms.tsx';
import {
  formatChange,
  formatQuantity,
  isAnomalous,
  mediumVariant,
  meterSearchText,
  monthLongLabel,
  pluralCategory,
  recentAnomaly,
  trendOf,
} from './meters-view.ts';

const NOT_PROVIDED = 'facility-operations.common.notProvided';
const CLOSE_LABEL = 'facility-operations.common.close';
const SearchValueSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const RouteSearchSchema = Schema.toCodecJson(Schema.URLSearchParams).pipe(
  Schema.decodeTo(Schema.fromURLSearchParams(Schema.Struct({ meter: Schema.optionalKey(SearchValueSchema) }))),
);
const isSearchList = Schema.is(Schema.Array(Schema.String));
const useInitialSelection = () =>
  useRouterState({
    select: (state) => {
      const parsed = Schema.decodeOption(RouteSearchSchema)(state.location.searchStr);
      const value = parsed.pipe(
        Option.map((search) => search.meter),
        Option.getOrUndefined,
      );
      const first = isSearchList(value) ? value[0] : value;
      return first === '' ? undefined : first;
    },
  });

const k = 'facility-operations.meters';

const pragueDate = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
const pragueToday = (): string => pragueDate.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

/** Tiny bar sparkline of the daily consumption of the last periods; anomalies in the danger colour. */
const Trend = ({ meter }: { readonly meter: Meter }) => {
  const points = trendOf(meter);
  if (points.length < 2) {
    return <span className="text-fg-secondary text-xs">—</span>;
  }
  const max = Math.max(...points.map((point) => point.rate), 0.0001);
  const width = 12;
  const gap = 4;
  const height = 28;
  return (
    <svg
      aria-hidden="true"
      height={height}
      viewBox={`0 0 ${points.length * (width + gap)} ${height}`}
      width={points.length * (width + gap)}
    >
      {points.map((point, index) => {
        const barHeight = Math.max(2, (point.rate / max) * (height - 2));
        return (
          <rect
            fill={point.anomaly ? 'var(--color-danger)' : 'var(--color-chart-series-1, var(--color-primary))'}
            height={barHeight}
            key={`${index}-${point.rate}`}
            rx={2}
            width={width}
            x={index * (width + gap)}
            y={height - barHeight}
          />
        );
      })}
    </svg>
  );
};

const MeterNumberCell = ({ row }: CellContext<Meter>) => {
  const { t } = useModernI18n();
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-semibold">{row.original.serialNumber}</span>
      <span className="truncate text-fg-secondary text-xs">{row.original.supplyPoint ?? t(NOT_PROVIDED)}</span>
    </div>
  );
};

const MeterMediumCell = ({ row }: CellContext<Meter>) => {
  const { t } = useModernI18n();
  return (
    <Badge size="sm" variant={mediumVariant[row.original.medium]}>
      {t(`${k}.medium.${row.original.medium}`)}
    </Badge>
  );
};

const MeterLocationCell = ({ row }: CellContext<Meter>) => {
  const { t } = useModernI18n();
  return (
    <Tooltip content={row.original.location?.label ?? t(NOT_PROVIDED)}>
      <span className="line-clamp-2 text-sm">{row.original.location?.label ?? t(NOT_PROVIDED)}</span>
    </Tooltip>
  );
};

const MeterLastReadingCell = ({ row }: CellContext<Meter>) => {
  const { t } = useModernI18n();
  const last = latestRow(row.original);
  return last === undefined ? (
    <span className="text-fg-secondary text-xs italic">{t(`${k}.row.noReadings`)}</span>
  ) : (
    <div className="flex flex-col tabular-nums">
      <span>{formatQuantity(last.reading.value, last.reading.unit)}</span>
      <span className="text-fg-secondary text-xs">{formatDate(last.reading.date)}</span>
    </div>
  );
};

const MeterConsumptionCell = ({ row }: CellContext<Meter>) => {
  const { language, t } = useModernI18n();
  const last = latestRow(row.original);
  if (last === undefined) {
    return <span className="text-fg-secondary text-xs">—</span>;
  }
  if (last.status === 'first') {
    return <span className="text-fg-secondary text-xs italic">{t(`${k}.row.first`)}</span>;
  }
  if (last.status === 'unitChanged') {
    return <span className="text-fg-secondary text-xs italic">{t(`${k}.row.unitChanged`)}</span>;
  }
  return (
    <div className="flex flex-col tabular-nums">
      <strong>{formatQuantity(last.consumption ?? 0, last.reading.unit)}</strong>
      <span className="text-fg-secondary text-xs">
        {t(`${k}.row.days_${pluralCategory(last.days ?? 0, language)}`, { count: last.days ?? 0 })}
      </span>
    </div>
  );
};

const MeterTrendCell = ({ row }: CellContext<Meter>) => <Trend meter={row.original} />;

const MeterStateCell = ({ row }: CellContext<Meter>) => {
  const { t } = useModernI18n();
  if (row.original.status === 'RETIRED') {
    return (
      <Badge size="sm" variant="outline">
        {t(`${k}.row.retired`)}
      </Badge>
    );
  }
  const anomaly = recentAnomaly(row.original);
  const last = latestRow(row.original);
  if (anomaly?.change !== undefined) {
    return (
      <div className="flex flex-col items-start gap-50">
        <span className="whitespace-nowrap">
          <Badge size="sm" variant="danger">
            {t(`${k}.row.anomaly`, { change: formatChange(anomaly.change) })}
          </Badge>
        </span>
        <span className="whitespace-nowrap text-fg-secondary text-xs">
          {t(`${k}.row.anomalyPeriod`, { date: formatDate(anomaly.reading.date) })}
        </span>
      </div>
    );
  }
  return (
    <span className="whitespace-nowrap">
      {last?.status === 'ok' ? (
        <Badge size="sm" variant="success">
          {t(`${k}.row.normal`)}
        </Badge>
      ) : (
        <Badge size="sm" variant="outline">
          {t('facility-operations.common.noData')}
        </Badge>
      )}
    </span>
  );
};

interface MeterFilters {
  readonly anomaliesOnly: boolean;
  readonly medium: MeterMedium | 'ALL';
  readonly search: string;
  readonly t: ReturnType<typeof useModernI18n>['t'];
}
const meterOverview = (meters: readonly Meter[], { anomaliesOnly, medium, search, t }: MeterFilters) => {
  const today = pragueToday();
  const active = meters.filter((meter) => meter.status !== 'RETIRED');
  let recentReadings = 0;
  for (const meter of meters) {
    for (const reading of validReadingsOf(meter)) {
      const age = daysBetween(reading.date, today);
      if (age >= 0 && age <= 30) {
        recentReadings += 1;
      }
    }
  }
  const anomalies = active.filter(isAnomalous);
  const series = monthlySeries(meters);
  const costMonths = series.filter((point) => point.costMinor !== undefined);
  const costMonth = costMonths
    .map((point) => point.month)
    .toSorted()
    .at(-1);
  const costPoints = costMonth === undefined ? [] : series.filter((point) => point.month === costMonth);
  const costTotal = costPoints.reduce((sum, point) => sum + (point.costMinor ?? 0), 0);
  const costMissing = costPoints.reduce((sum, point) => sum + point.periodsWithoutCost, 0);

  const visible = meters
    .filter(
      (meter) =>
        (medium === 'ALL' || meter.medium === medium) &&
        (!anomaliesOnly || isAnomalous(meter)) &&
        (search.trim() === '' || matchesSearch(meterSearchText(meter, t), search)),
    )
    .toSorted(
      (left, right) =>
        Number(isAnomalous(right)) - Number(isAnomalous(left)) ||
        (left.location?.label ?? '').localeCompare(right.location?.label ?? '', 'cs') ||
        left.serialNumber.localeCompare(right.serialNumber, 'cs'),
    );

  return { active, anomalies, costMissing, costMonth, costTotal, recentReadings, visible };
};

const useMetersView = () => {
  const { language, t } = useModernI18n();
  const toast = useToast();
  const ops = useAgendaRecords(['meters']);
  const envelope = ops.data?.agendas.meters;
  const meters = envelope?.state.meters ?? [];
  const canWrite = envelope?.canWrite === true;
  const canReadFinancial = envelope?.canReadFinancial === true;
  const canManage = envelope?.canManage === true;
  const actor = ops.data?.actorPrincipalRef;
  const fileAccess = ops.data?.access.find((entry) => entry.agenda === 'documents');

  const [medium, setMedium] = useState<MeterMedium | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const initialSelection = useInitialSelection();
  const [detailId, setDetailId] = useState<string | undefined>(initialSelection);
  const [detailMode, setDetailMode] = useState<DetailMode>('view');
  const [creating, setCreating] = useState(false);
  const [recording, setRecording] = useState(false);

  const detail = meters.find((meter) => meter.id === detailId);
  const { active, anomalies, costMissing, costMonth, costTotal, recentReadings, visible } = meterOverview(meters, {
    anomaliesOnly,
    medium,
    search,
    t,
  });
  const columns: ColumnDef<Meter>[] = [
    {
      cell: MeterNumberCell,
      header: t(`${k}.columns.meter`),
      id: 'meter',
      meta: { width: 180 },
    },
    {
      cell: MeterMediumCell,
      header: t(`${k}.columns.medium`),
      id: 'medium',
      meta: { width: 86 },
    },
    {
      cell: MeterLocationCell,
      header: t(`${k}.columns.location`),
      id: 'location',
      meta: { width: 205 },
    },
    {
      cell: MeterLastReadingCell,
      header: t(`${k}.columns.lastReading`),
      id: 'lastReading',
      meta: { width: 128 },
    },
    {
      cell: MeterConsumptionCell,
      header: t(`${k}.columns.consumption`),
      id: 'consumption',
      meta: { width: 160 },
    },
    {
      cell: MeterTrendCell,
      header: t(`${k}.columns.trend`),
      id: 'trend',
      meta: { width: 100 },
    },
    {
      cell: MeterStateCell,
      header: t(`${k}.columns.state`),
      id: 'state',
      meta: { width: 160 },
    },
  ];

  const closeDetail = () => {
    setDetailId(undefined);
    setDetailMode('view');
  };

  return {
    active,
    actor,
    anomalies,
    anomaliesOnly,
    canManage,
    canReadFinancial,
    canWrite,
    closeDetail,
    columns,
    costMissing,
    costMonth,
    costTotal,
    creating,
    detail,
    detailMode,
    envelope,
    fileAccess,
    language,
    medium,
    meters,
    ops,
    recentReadings,
    recording,
    search,
    setAnomaliesOnly,
    setCreating,
    setDetailId,
    setDetailMode,
    setMedium,
    setRecording,
    setSearch,
    t,
    toast,
    visible,
  };
};

const MeterPanels = ({ view }: { readonly view: ReturnType<typeof useMetersView> }) => {
  const {
    actor,
    canManage,
    canReadFinancial,
    canWrite,
    closeDetail,
    creating,
    detail,
    detailMode,
    fileAccess,
    language,
    meters,
    ops,
    recording,
    setCreating,
    setDetailId,
    setDetailMode,
    setRecording,
    t,
    toast,
  } = view;
  let detailTitle = '';
  if (detail !== undefined) {
    if (detailMode === 'edit') {
      detailTitle = t(`${k}.edit.title`, { serial: detail.serialNumber });
    } else if (detailMode === 'reading') {
      detailTitle = t(`${k}.reading.titleFor`, { serial: detail.serialNumber });
    } else {
      const mediumLabel = t(`${k}.medium.${detail.medium}`);
      detailTitle = `${detail.serialNumber} · ${mediumLabel}`;
    }
  }

  return (
    <>
      <SidePanel
        closeOnInteractOutside={detailMode === 'view'}
        description={detail?.location?.label}
        onOpenChange={(next) => {
          if (!next) {
            closeDetail();
          }
        }}
        open={detail !== undefined}
        resizeLabel={t(CLOSE_LABEL)}
        size="xl"
        title={detailTitle}
      >
        {detail !== undefined && (
          <div className="py-200">
            <MeterDetail
              actor={actor}
              capabilities={{
                canManage,
                canReadFinancial,
                canReadPhotos: fileAccess?.canRead === true,
                canUploadPhotos: fileAccess?.canWrite === true,
                canWrite,
              }}
              language={language}
              meter={detail}
              meters={meters}
              mode={detailMode}
              onModeChange={setDetailMode}
              run={ops.run}
            />
          </div>
        )}
      </SidePanel>

      <SidePanel
        closeOnInteractOutside={false}
        onOpenChange={(next) => setCreating(next)}
        open={creating}
        resizeLabel={t(CLOSE_LABEL)}
        size="lg"
        title={t(`${k}.create.title`)}
      >
        {creating && (
          <div className="py-200">
            <MeterForm
              onCancel={() => setCreating(false)}
              onSaved={(meterId) => {
                toast.create({ title: t(`${k}.created`), type: 'success' });
                setCreating(false);
                if (meterId !== undefined) {
                  setDetailId(meterId);
                  setDetailMode('view');
                }
              }}
              run={ops.run}
            />
          </div>
        )}
      </SidePanel>

      <SidePanel
        closeOnInteractOutside={false}
        onOpenChange={(next) => setRecording(next)}
        open={recording}
        resizeLabel={t(CLOSE_LABEL)}
        size="lg"
        title={t(`${k}.reading.title`)}
      >
        {recording && (
          <div className="py-200">
            <ReadingForm
              canRecordCosts={canManage}
              canUploadPhoto={fileAccess?.canWrite === true}
              meters={meters}
              onCancel={() => setRecording(false)}
              onSaved={(meterId) => {
                toast.create({ title: t(`${k}.reading.saved`), type: 'success' });
                setRecording(false);
                setDetailId(meterId);
                setDetailMode('view');
              }}
              run={ops.run}
            />
          </div>
        )}
      </SidePanel>
    </>
  );
};

const MetersView = () => {
  const view = useMetersView();
  const {
    active,
    anomalies,
    anomaliesOnly,
    canManage,
    canReadFinancial,
    canWrite,
    columns,
    costMissing,
    costMonth,
    costTotal,
    envelope,
    language,
    medium,
    meters,
    ops,
    recentReadings,
    search,
    setAnomaliesOnly,
    setCreating,
    setDetailId,
    setDetailMode,
    setMedium,
    setRecording,
    setSearch,
    t,
    visible,
  } = view;
  let headerActions: ReactNode;
  if (canWrite) {
    headerActions = (
      <>
        {canManage && (
          <Button onClick={() => setCreating(true)} theme="outlined" variant="secondary">
            {t(`${k}.actions.newMeter`)}
          </Button>
        )}
        <Button onClick={() => setRecording(true)} variant="primary">
          {t(`${k}.actions.recordReading`)}
        </Button>
      </>
    );
  } else if (envelope !== undefined) {
    headerActions = (
      <Badge size="sm" variant="outline">
        {t('facility-operations.common.readOnly')}
      </Badge>
    );
  }
  let descriptionKey = 'operationalReadOnlyDescription';
  if (canReadFinancial) {
    descriptionKey = 'description';
  } else if (canWrite) {
    descriptionKey = 'operationalDescription';
  }
  const anomalyHintLabel = t(`${k}.stats.anomaliesHint`);
  const anomalyHint =
    anomalies.length === 0
      ? t(`${k}.stats.anomaliesNone`)
      : `${anomalyHintLabel}: ${anomalies.map((meter) => meter.serialNumber).join(', ')}`;

  return (
    <>
      <PageHeader actions={headerActions} description={t(`${k}.${descriptionKey}`)} title={t(`${k}.title`)} />
      <AgendaGate
        onRetry={() => {
          void browserRuntime.runPromise(ops.reload());
        }}
        readable={envelope !== undefined}
        status={ops.status}
      >
        <StatRow>
          <StatCard
            hint={t(`${k}.stats.countHint`, { total: meters.length })}
            label={t(`${k}.stats.count`)}
            value={String(active.length)}
          />
          <StatCard
            hint={t(`${k}.stats.readings30Hint`)}
            label={t(`${k}.stats.readings30`)}
            value={String(recentReadings)}
          />
          <StatCard hint={anomalyHint} label={t(`${k}.stats.anomalies`)} value={String(anomalies.length)} />
          {canReadFinancial && (
            <StatCard
              hint={costMissing > 0 ? t(`${k}.stats.costMissing`, { count: costMissing }) : t(`${k}.stats.costHint`)}
              label={
                costMonth === undefined
                  ? t(`${k}.stats.cost`, { month: '' })
                  : t(`${k}.stats.cost`, { month: monthLongLabel(costMonth, language) })
              }
              value={costMonth === undefined ? t('facility-operations.common.noData') : formatMoney(costTotal)}
            />
          )}
        </StatRow>

        <div className="flex flex-wrap items-center gap-150">
          <fieldset
            aria-label={t(`${k}.filters.mediumLabel`)}
            className="inline-flex flex-wrap rounded-button-sm border border-border-primary p-50"
          >
            {(['ALL', ...meterMedia.filter((entry) => meters.some((meter) => meter.medium === entry))] as const).map(
              (entry) => (
                <Button
                  aria-pressed={entry === medium}
                  key={entry}
                  onClick={() => setMedium(entry)}
                  size="sm"
                  theme={entry === medium ? 'solid' : 'borderless'}
                  variant={entry === medium ? 'primary' : 'secondary'}
                >
                  {entry === 'ALL' ? t(`${k}.filters.all`) : t(`${k}.medium.${entry}`)}
                </Button>
              ),
            )}
          </fieldset>
          <Button
            aria-pressed={anomaliesOnly}
            onClick={() => setAnomaliesOnly((current) => !current)}
            size="sm"
            theme={anomaliesOnly ? 'solid' : 'outlined'}
            variant={anomaliesOnly ? 'danger' : 'secondary'}
          >
            {t(`${k}.filters.anomaliesOnly`)}
            {anomalies.length > 0 ? ` (${anomalies.length})` : ''}
          </Button>
          <div className="min-w-[16rem] flex-1">
            <Input
              aria-label={t(`${k}.filters.search`)}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(`${k}.filters.search`)}
              size="sm"
              type="search"
              value={search}
            />
          </div>
        </div>

        {meters.length > 0 && visible.length === 0 ? (
          <EmptyState description={t(`${k}.filters.noMatchDescription`)} title={t(`${k}.filters.noMatchTitle`)} />
        ) : (
          <DataTable
            columns={columns}
            data={visible}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.original.serialNumber}
            loading={false}
            onRowClick={(row) => {
              setDetailId(row.original.id);
              setDetailMode('view');
            }}
            size="sm"
            tableLayout="fixed"
            translations={{
              emptyDescription: t('facility-operations.common.states.emptyDescription'),
              emptyTitle: t('facility-operations.common.states.emptyTitle'),
            }}
          />
        )}

        {meters.length > 0 && (
          <ConsumptionByPlace canReadFinancial={canReadFinancial} language={language} meters={meters} />
        )}
      </AgendaGate>

      <MeterPanels view={view} />
    </>
  );
};

export const MetersPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.meters.title" />
    <MetersView />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the first render already has the meters agenda. */
export const preloadPage = preloadAgendaRecords(['meters']);
export default MetersPage;
