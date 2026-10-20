// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
// Meter detail (ops-meters lane): master data, consumption chart, full reading history with truthful differences,
// anomaly highlight, photo preview and voiding. Rendered inside the page's SidePanel.
import { DetailList, SectionCard, formatDate, formatDateTime, formatMoney } from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DateTime } from 'effect';
import { useState } from 'react';
import { readingRows } from '../../../../../../shared/domain/meters.ts';
import type { Meter, MeterReading, ReadingRow } from '../../../../../../shared/domain/meters.ts';
import { CommentThread } from '../../../../../ui/comment-thread.tsx';
import { LinkedDocuments } from '../../../../../ui/linked-documents.tsx';
import { loadRecords } from '../../../../../ui/use-agenda.ts';
import type { FailureReason } from '../../../../../ui/use-agenda.ts';
import { MeterForm, ReadingForm } from './meter-forms.tsx';
import type { RunCommand } from './meter-forms.tsx';
import { formatChange, formatQuantity, formatRate, mediumVariant, personLabel, recentAnomaly } from './meters-view.ts';

const k = 'siampark-ops.meters';

export type DetailMode = 'view' | 'edit' | 'reading';

interface ChartDatum {
  readonly period: string;
  readonly consumption: number;
  readonly series: string;
}

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

export const MeterDetail = ({
  actor,
  canReadPhotos,
  canUploadPhotos,
  canWrite,
  canManage,
  canReadFinancial,
  language,
  meter,
  meters,
  mode,
  onModeChange,
  run,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly canReadPhotos: boolean;
  readonly canUploadPhotos: boolean;
  readonly canWrite: boolean;
  readonly canManage: boolean;
  readonly canReadFinancial: boolean;
  readonly language: string;
  readonly meter: Meter;
  readonly meters: readonly Meter[];
  readonly mode: DetailMode;
  readonly onModeChange: (mode: DetailMode) => void;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const [voiding, setVoiding] = useState<MeterReading | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<FailureReason | 'required' | undefined>(undefined);
  const [photo, setPhoto] = useState<{ readonly url: string; readonly name: string } | undefined>(undefined);
  const [photoLoading, setPhotoLoading] = useState<string | undefined>(undefined);

  const rows = readingRows(meter);
  const anomaly = recentAnomaly(meter);
  const rowById = new Map<string, ReadingRow>(rows.map((row) => [row.reading.id, row]));
  const history = [...(meter.readings ?? [])].sort(
    (left, right) => right.date.localeCompare(left.date) || iso(right.createdAt).localeCompare(iso(left.createdAt)),
  );
  const okRows = rows.filter((row) => row.status === 'ok' && row.consumption !== undefined);
  const normalLabel = t(`${k}.detail.series.normal`);
  const anomalyLabel = t(`${k}.detail.series.anomaly`);
  const chartData: ChartDatum[] = okRows.map((row) => ({
    consumption: row.consumption ?? 0,
    period: formatDate(row.reading.date),
    series: row.anomaly ? anomalyLabel : normalLabel,
  }));
  const hasAnomaly = okRows.some((row) => row.anomaly);
  const who = (principal: PrincipalRef) => personLabel(t, principal, actor);

  const showPhoto = async (reading: MeterReading) => {
    if (reading.photo === undefined) {
      return;
    }
    setPhotoLoading(reading.id);
    const outcome = await loadRecords({ agendas: [], fileId: reading.photo.id });
    setPhotoLoading(undefined);
    if (outcome.ok && outcome.data.file !== undefined) {
      setPhoto({
        name: outcome.data.file.name,
        url: `data:${outcome.data.file.mime};base64,${outcome.data.file.contentBase64}`,
      });
    } else {
      toast.create({ title: t('siampark-ops.common.errors.forbidden'), type: 'error' });
    }
  };

  const confirmVoid = async () => {
    if (voiding === undefined) {
      return;
    }
    if (reason.trim() === '') {
      setVoidError('required');
      return;
    }
    setVoidBusy(true);
    const outcome = await run({
      _tag: 'MeterReadingVoid',
      meterId: meter.id,
      readingId: voiding.id,
      reason: reason.trim(),
    });
    setVoidBusy(false);
    if (outcome.ok) {
      toast.create({ title: t(`${k}.void.done`), type: 'success' });
      setVoiding(undefined);
      setReason('');
      setVoidError(undefined);
    } else {
      setVoidError(outcome.reason);
    }
  };

  if (mode === 'edit' && canManage) {
    return (
      <MeterForm
        meter={meter}
        onCancel={() => onModeChange('view')}
        onSaved={() => {
          toast.create({ title: t(`${k}.edit.saved`), type: 'success' });
          onModeChange('view');
        }}
        run={run}
      />
    );
  }
  if (mode === 'reading' && canWrite) {
    return (
      <ReadingForm
        canRecordCosts={canManage}
        canUploadPhoto={canUploadPhotos}
        fixedMeterId={meter.id}
        meters={meters}
        onCancel={() => onModeChange('view')}
        onSaved={() => {
          toast.create({ title: t(`${k}.reading.saved`), type: 'success' });
          onModeChange('view');
        }}
        run={run}
      />
    );
  }

  const location = meter.location;
  const optionalText = (value: string | undefined) => value ?? t('siampark-ops.common.notProvided');

  return (
    <div className="flex flex-col gap-250">
      <div className="flex flex-wrap items-center gap-100">
        <Badge size="sm" variant={mediumVariant[meter.medium]}>
          {t(`${k}.medium.${meter.medium}`)}
        </Badge>
        <Badge size="sm" variant={meter.status === 'RETIRED' ? 'outline' : 'success'}>
          {t(`${k}.status.${meter.status ?? 'ACTIVE'}`)}
        </Badge>
        {anomaly?.change !== undefined && (
          <Badge size="sm" variant="danger">
            {`${t(`${k}.row.anomaly`, { change: formatChange(anomaly.change) })} · ${formatDate(anomaly.reading.date)}`}
          </Badge>
        )}
        <span className="flex-1" />
        {canWrite && (
          <>
            {canManage && (
              <Button onClick={() => onModeChange('edit')} size="sm" theme="outlined" variant="secondary">
                {t(`${k}.actions.edit`)}
              </Button>
            )}
            {meter.status !== 'RETIRED' && (
              <Button onClick={() => onModeChange('reading')} size="sm" variant="primary">
                {t(`${k}.actions.recordReading`)}
              </Button>
            )}
          </>
        )}
      </div>

      <SectionCard title={t(`${k}.detail.chart`)}>
        {chartData.length === 0 ? (
          <p className="text-fg-secondary text-sm">{t(`${k}.detail.chartEmpty`)}</p>
        ) : (
          <Chart
            ariaLabel={t(`${k}.detail.chartAria`, { serial: meter.serialNumber })}
            data={chartData}
            formatValue={(value) => formatQuantity(value, meter.unit)}
            height={200}
            legend={hasAnomaly}
            series="series"
            stacked
            type="bar"
            x="period"
            y="consumption"
          />
        )}
      </SectionCard>

      <SectionCard title={t(`${k}.detail.history`)}>
        <p className="text-fg-secondary text-xs">{t(`${k}.detail.historyHint`)}</p>
        {voiding !== undefined && (
          <div className="flex flex-col gap-150 rounded-md border border-border-primary bg-surface-subtle p-200">
            <strong className="text-sm">{t(`${k}.void.title`, { date: formatDate(voiding.date) })}</strong>
            {voidError !== undefined && (
              <StatusText showIcon status="error">
                {voidError === 'required'
                  ? t('siampark-ops.common.required')
                  : t(`siampark-ops.common.errors.${voidError}`)}
              </StatusText>
            )}
            <FormInput
              autoComplete="off"
              helpText={t(`${k}.void.reasonHelp`)}
              id="void-reason"
              label={t(`${k}.void.reason`)}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              required
              value={reason}
            />
            <div className="flex justify-end gap-100">
              <Button
                onClick={() => {
                  setVoiding(undefined);
                  setVoidError(undefined);
                }}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t('siampark-ops.common.cancel')}
              </Button>
              <Button
                isLoading={voidBusy}
                loadingText={t('siampark-ops.common.saving')}
                onClick={() => void confirmVoid()}
                size="sm"
                variant="danger"
              >
                {t(`${k}.void.submit`)}
              </Button>
            </div>
          </div>
        )}
        {history.length === 0 ? (
          <p className="text-fg-secondary text-sm">{t(`${k}.row.noReadings`)}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border-primary rounded-md border border-border-primary">
            {history.map((reading) => {
              const row = rowById.get(reading.id);
              const voided = reading.voided;
              const struck = voided === undefined ? '' : 'line-through';
              return (
                <li
                  className={`flex flex-col gap-100 p-150 ${row?.anomaly === true ? 'bg-danger-light' : ''} ${voided === undefined ? '' : 'bg-surface-subtle'}`}
                  data-testid={`reading-${reading.date}`}
                  key={reading.id}
                >
                  <div className="flex flex-wrap items-start gap-200">
                    <div className="flex min-w-[7rem] flex-col">
                      <span className={`font-semibold ${struck}`}>{formatDate(reading.date)}</span>
                      <span className={`text-fg-secondary text-xs tabular-nums ${struck}`}>
                        {t(`${k}.detail.value`)}: {formatQuantity(reading.value, reading.unit)}
                      </span>
                    </div>
                    <div className="flex min-w-[9rem] flex-1 flex-col tabular-nums">
                      {voided !== undefined ? (
                        <span>
                          <Badge size="sm" variant="outline">
                            {t(`${k}.void.voided`)}
                          </Badge>
                        </span>
                      ) : row === undefined || row.status === 'first' ? (
                        <span className="text-fg-secondary text-sm italic">{t(`${k}.row.first`)}</span>
                      ) : row.status === 'unitChanged' ? (
                        <span className="text-fg-secondary text-sm italic">{t(`${k}.row.unitChanged`)}</span>
                      ) : (
                        <>
                          <span className="flex flex-wrap items-center gap-100">
                            <strong>{formatQuantity(row.consumption ?? 0, reading.unit)}</strong>
                            {row.anomaly && row.change !== undefined && (
                              <Badge size="sm" variant="danger">
                                {t(`${k}.row.anomaly`, { change: formatChange(row.change) })}
                              </Badge>
                            )}
                          </span>
                          <span className="text-fg-secondary text-xs">
                            {t(`${k}.row.days_${new Intl.PluralRules(language).select(row.days ?? 0)}`, {
                              count: row.days ?? 0,
                            })}
                            {row.dailyRate === undefined
                              ? ''
                              : ` · ${t(`${k}.row.perDay`, { value: formatRate(row.dailyRate, reading.unit) })}`}
                          </span>
                        </>
                      )}
                    </div>
                    {canReadFinancial && (
                      <div className="flex flex-col items-end tabular-nums">
                        <span className="text-fg-secondary text-xs">{t(`${k}.detail.cost`)}</span>
                        {reading.costMinor === undefined ? (
                          <span className="text-fg-secondary text-sm">{t('siampark-ops.common.noData')}</span>
                        ) : (
                          <span className="text-sm">{formatMoney(reading.costMinor)}</span>
                        )}
                      </div>
                    )}
                    {canManage && voided === undefined && (
                      <Button
                        onClick={() => {
                          setVoiding(reading);
                          setReason('');
                          setVoidError(undefined);
                        }}
                        size="sm"
                        theme="borderless"
                        variant="danger"
                      >
                        {t(`${k}.actions.void`)}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-150 gap-y-50 text-fg-secondary text-xs">
                    <span>
                      {t(`${k}.detail.readBy`)}: {reading.readBy ?? t('siampark-ops.common.notProvided')}
                    </span>
                    <span>
                      {t(`${k}.detail.author`, {
                        at: formatDateTime(iso(reading.createdAt)),
                        who: who(reading.createdBy),
                      })}
                    </span>
                    {canReadPhotos && reading.photo !== undefined && (
                      <Button
                        isLoading={photoLoading === reading.id}
                        onClick={() => void showPhoto(reading)}
                        size="sm"
                        theme="borderless"
                        variant="secondary"
                      >
                        {t(`${k}.actions.showPhoto`)}
                      </Button>
                    )}
                  </div>
                  {reading.note !== undefined && reading.note !== '' && (
                    <p className="text-fg-primary text-sm">„{reading.note}“</p>
                  )}
                  {voided !== undefined && (
                    <p className="text-fg-secondary text-xs">
                      {t(`${k}.void.voidedBy`, {
                        at: formatDateTime(iso(voided.at)),
                        reason: voided.reason,
                        who: who(voided.by),
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {photo !== undefined && (
          <figure className="flex flex-col gap-100">
            <img
              alt={photo.name}
              className="max-h-[320px] rounded-md border border-border-primary object-contain"
              src={photo.url}
            />
            <figcaption className="flex items-center justify-between text-fg-secondary text-xs">
              {photo.name}
              <Button onClick={() => setPhoto(undefined)} size="sm" theme="borderless" variant="secondary">
                {t('siampark-ops.common.close')}
              </Button>
            </figcaption>
          </figure>
        )}
      </SectionCard>

      <CommentThread subject={{ id: meter.id, kind: 'meter', label: meter.serialNumber }} />
      <LinkedDocuments hideWhenForbidden subject={{ id: meter.id, kind: 'meter', label: meter.serialNumber }} />

      <SectionCard title={t(`${k}.detail.masterData`)}>
        <DetailList
          items={[
            { label: t(`${k}.fields.serialNumber`), value: meter.serialNumber },
            { label: t(`${k}.fields.unit`), value: meter.unit },
            {
              label: t(`${k}.fields.location`),
              value:
                location === undefined ? (
                  t('siampark-ops.common.notProvided')
                ) : location.id.startsWith('label:') ? (
                  location.label
                ) : (
                  <a
                    className="text-primary underline"
                    href={`/${language}/siampark/properties?resourceId=${encodeURIComponent(location.id)}`}
                    title={t(`${k}.actions.openProperty`)}
                  >
                    {location.label}
                  </a>
                ),
            },
            { label: t(`${k}.fields.supplyPoint`), value: optionalText(meter.supplyPoint) },
            ...(canReadFinancial
              ? [
                  { label: t(`${k}.fields.supplier`), value: optionalText(meter.supplier) },
                  { label: t(`${k}.fields.consumer`), value: optionalText(meter.consumer) },
                  { label: t(`${k}.fields.contract`), value: optionalText(meter.contract) },
                  { label: t(`${k}.fields.note`), value: optionalText(meter.note) },
                ]
              : []),
            {
              label: t('siampark-ops.common.createdAt'),
              value: `${formatDateTime(iso(meter.createdAt))} · ${who(meter.createdBy)}`,
            },
            {
              label: t('siampark-ops.common.updatedAt'),
              value: `${formatDateTime(iso(meter.updatedAt))} · ${who(meter.updatedBy)}`,
            },
          ]}
        />
      </SectionCard>
    </div>
  );
};
