// @effect-diagnostics asyncFunction:off globalDate:off
// Siampark provoz — Měřidla a energie (S04). OWNED BY THE `meters` LANE (ops-meters).
// List of meters with last reading, truthful consumption and anomaly highlight → detail side panel with history and
// chart → record reading / edit meter; consumption and costs per property/unit below the list.
import { EmptyState, PageHeader, SidePanel, StatCard, StatRow, formatDate, formatMoney, matchesSearch } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { useEffect, useState } from 'react';
import { daysBetween, latestRow, meterMedia, monthlySeries, validReadingsOf } from '../../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium } from '../../../../../../shared/domain/meters.ts';
import { AgendaFrame, AgendaGate } from '../../../../../ui/agenda-frame.tsx';
import { useAgendaRecords } from '../../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
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
  trendOf,
} from './meters-view.ts';

const k = 'siampark-ops.meters';

const pragueToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Prague', year: 'numeric' }).format(
    Date.now(),
  );

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

const MetersView = () => {
  const { language, t } = useModernI18n();
  const toast = useToast();
  const ops = useAgendaRecords(['meters']);
  const envelope = ops.data?.agendas.meters;
  const meters = envelope?.state.meters ?? [];
  const canWrite = envelope?.canWrite === true;
  const actor = ops.data?.actorPrincipalRef;

  const [medium, setMedium] = useState<MeterMedium | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const [detailMode, setDetailMode] = useState<DetailMode>('view');
  const [creating, setCreating] = useState(false);
  const [recording, setRecording] = useState(false);

  // Deep link: /siampark/provoz/meridla?meter=<id> opens that meter's detail.
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('meter');
    if (linked !== null && linked !== '') {
      setDetailId(linked);
    }
  }, []);

  const detail = meters.find((meter) => meter.id === detailId);
  const today = pragueToday();
  const active = meters.filter((meter) => meter.status !== 'RETIRED');
  const recentReadings = meters.flatMap(validReadingsOf).filter((reading) => {
    const age = daysBetween(reading.date, today);
    return age >= 0 && age <= 30;
  }).length;
  const anomalies = active.filter(isAnomalous);
  const costMonths = monthlySeries(meters).filter((point) => point.costMinor !== undefined);
  const costMonth = costMonths.map((point) => point.month).sort().at(-1);
  const costPoints = costMonth === undefined ? [] : monthlySeries(meters).filter((point) => point.month === costMonth);
  const costTotal = costPoints.reduce((sum, point) => sum + (point.costMinor ?? 0), 0);
  const costMissing = costPoints.reduce((sum, point) => sum + point.periodsWithoutCost, 0);

  const visible = meters
    .filter((meter) => medium === 'ALL' || meter.medium === medium)
    .filter((meter) => !anomaliesOnly || isAnomalous(meter))
    .filter((meter) => search.trim() === '' || matchesSearch(meterSearchText(meter, t), search))
    .toSorted(
      (left, right) =>
        Number(isAnomalous(right)) - Number(isAnomalous(left)) ||
        (left.location?.label ?? '').localeCompare(right.location?.label ?? '', 'cs') ||
        left.serialNumber.localeCompare(right.serialNumber, 'cs'),
    );

  const columns: ColumnDef<Meter>[] = [
    {
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold">{row.original.serialNumber}</span>
          <span className="truncate text-fg-secondary text-xs">
            {row.original.supplyPoint ?? t('siampark-ops.common.notProvided')}
          </span>
        </div>
      ),
      header: t(`${k}.columns.meter`),
      id: 'meter',
    },
    {
      cell: ({ row }) => (
        <Badge size="sm" variant={mediumVariant[row.original.medium]}>
          {t(`${k}.medium.${row.original.medium}`)}
        </Badge>
      ),
      header: t(`${k}.columns.medium`),
      id: 'medium',
    },
    {
      cell: ({ row }) => (
        <span className="text-sm">{row.original.location?.label ?? t('siampark-ops.common.notProvided')}</span>
      ),
      header: t(`${k}.columns.location`),
      id: 'location',
    },
    {
      cell: ({ row }) => {
        const last = latestRow(row.original);
        return last === undefined ? (
          <span className="text-fg-secondary text-xs italic">{t(`${k}.row.noReadings`)}</span>
        ) : (
          <div className="flex flex-col tabular-nums">
            <span>{formatQuantity(last.reading.value, last.reading.unit)}</span>
            <span className="text-fg-secondary text-xs">{formatDate(last.reading.date)}</span>
          </div>
        );
      },
      header: t(`${k}.columns.lastReading`),
      id: 'lastReading',
    },
    {
      cell: ({ row }) => {
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
            <span className="text-fg-secondary text-xs">{t(`${k}.row.days`, { days: last.days ?? 0 })}</span>
          </div>
        );
      },
      header: t(`${k}.columns.consumption`),
      id: 'consumption',
    },
    {
      cell: ({ row }) => <Trend meter={row.original} />,
      header: t(`${k}.columns.trend`),
      id: 'trend',
    },
    {
      cell: ({ row }) => {
        if (row.original.status === 'RETIRED') {
          return (
            <Badge size="sm" variant="outline">
              {t(`${k}.row.retired`)}
            </Badge>
          );
        }
        const last = latestRow(row.original);
        if (last?.anomaly === true && last.change !== undefined) {
          return (
            <Badge size="sm" variant="danger">
              {t(`${k}.row.anomaly`, { change: formatChange(last.change) })}
            </Badge>
          );
        }
        return last?.status === 'ok' ? (
          <Badge size="sm" variant="success">
            {t(`${k}.row.normal`)}
          </Badge>
        ) : (
          <Badge size="sm" variant="outline">
            {t('siampark-ops.common.noData')}
          </Badge>
        );
      },
      header: t(`${k}.columns.state`),
      id: 'state',
    },
  ];

  const closeDetail = () => {
    setDetailId(undefined);
    setDetailMode('view');
  };

  return (
    <>
      <PageHeader
        actions={
          canWrite ? (
            <>
              <Button onClick={() => setCreating(true)} theme="outlined" variant="secondary">
                {t(`${k}.actions.newMeter`)}
              </Button>
              <Button onClick={() => setRecording(true)} variant="primary">
                {t(`${k}.actions.recordReading`)}
              </Button>
            </>
          ) : envelope === undefined ? undefined : (
            <Badge size="sm" variant="outline">
              {t('siampark-ops.common.readOnly')}
            </Badge>
          )
        }
        description={t(`${k}.description`)}
        title={t(`${k}.title`)}
      />
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        <StatRow>
          <StatCard
            hint={t(`${k}.stats.countHint`, { total: meters.length })}
            label={t(`${k}.stats.count`)}
            value={String(active.length)}
          />
          <StatCard hint={t(`${k}.stats.readings30Hint`)} label={t(`${k}.stats.readings30`)} value={String(recentReadings)} />
          <StatCard
            hint={
              anomalies.length === 0
                ? t(`${k}.stats.anomaliesNone`)
                : `${t(`${k}.stats.anomaliesHint`)}: ${anomalies.map((meter) => meter.serialNumber).join(', ')}`
            }
            label={t(`${k}.stats.anomalies`)}
            value={String(anomalies.length)}
          />
          <StatCard
            hint={costMissing > 0 ? t(`${k}.stats.costMissing`, { count: costMissing }) : t(`${k}.stats.costHint`)}
            label={
              costMonth === undefined
                ? t(`${k}.stats.cost`, { month: '' })
                : t(`${k}.stats.cost`, { month: monthLongLabel(costMonth, language) })
            }
            value={costMonth === undefined ? t('siampark-ops.common.noData') : formatMoney(costTotal)}
          />
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
            translations={{
              emptyDescription: t('siampark-ops.common.states.emptyDescription'),
              emptyTitle: t('siampark-ops.common.states.emptyTitle'),
            }}
          />
        )}

        {meters.length > 0 && <ConsumptionByPlace language={language} meters={meters} />}
      </AgendaGate>

      <SidePanel
        closeOnInteractOutside={detailMode === 'view'}
        description={detail?.location?.label}
        onOpenChange={(next) => {
          if (!next) {
            closeDetail();
          }
        }}
        open={detail !== undefined}
        resizeLabel={t('siampark-ops.common.close')}
        size="xl"
        title={
          detail === undefined
            ? ''
            : detailMode === 'edit'
              ? t(`${k}.edit.title`, { serial: detail.serialNumber })
              : detailMode === 'reading'
                ? t(`${k}.reading.titleFor`, { serial: detail.serialNumber })
                : `${detail.serialNumber} · ${t(`${k}.medium.${detail.medium}`)}`
        }
      >
        {detail !== undefined && (
          <div className="py-200">
            <MeterDetail
              actor={actor}
              canWrite={canWrite}
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
        resizeLabel={t('siampark-ops.common.close')}
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
        resizeLabel={t('siampark-ops.common.close')}
        size="lg"
        title={t(`${k}.reading.title`)}
      >
        {recording && (
          <div className="py-200">
            <ReadingForm
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

export const MetersPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.meters.title" />
    <MetersView />
  </AgendaFrame>
);

export default MetersPage;
