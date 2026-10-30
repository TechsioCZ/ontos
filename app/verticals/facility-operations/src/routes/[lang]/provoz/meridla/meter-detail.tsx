import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Meter detail (ops-meters lane): master data, consumption chart, full reading history with truthful differences,
// anomaly highlight, photo preview and voiding. Rendered inside the page's SidePanel.
import {
  DetailList,
  SectionCard,
  dividedListClassName,
  formatDate,
  formatDateTime,
  formatMoney,
  surfaceTileClassName,
} from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DateTime, Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { readingRows } from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterReading, ReadingRow } from '../../../../../shared/domain/meters.ts';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import { LinkedDocuments } from '../../../../ui/linked-documents.tsx';
import { loadRecords } from '../../../../ui/use-agenda.ts';
import type { FailureReason } from '../../../../ui/use-agenda.ts';
import { MeterForm, ReadingForm } from './meter-forms.tsx';
import type { RunCommand } from './meter-forms.tsx';
import {
  formatChange,
  formatQuantity,
  formatRate,
  mediumVariant,
  personLabel,
  pluralCategory,
  recentAnomaly,
} from './meters-view.ts';

const k = 'facility-operations.meters';
const NOT_PROVIDED = 'facility-operations.common.notProvided';

const DetailModeSchema = Schema.Literals(['view', 'edit', 'reading']);
export type DetailMode = typeof DetailModeSchema.Type;

interface PhotoPreview {
  readonly name: string;
  readonly url: string;
}

interface ChartDatum {
  readonly consumption: number;
  readonly period: string;
  readonly series: string;
}

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

export interface MeterCapabilities {
  readonly canManage: boolean;
  readonly canReadFinancial: boolean;
  readonly canReadPhotos: boolean;
  readonly canUploadPhotos: boolean;
  readonly canWrite: boolean;
}

const ReadingConsumption = ({
  language,
  reading,
  row,
}: {
  readonly language: string;
  readonly reading: MeterReading;
  readonly row: ReadingRow | undefined;
}) => {
  const { t } = useModernI18n();
  let content: ReactNode;
  if (reading.voided !== undefined) {
    content = (
      <span>
        <Badge size="sm" variant="outline">
          {t(`${k}.void.voided`)}
        </Badge>
      </span>
    );
  } else if (row === undefined || row.status === 'first') {
    content = <span className="text-fg-secondary text-sm italic">{t(`${k}.row.first`)}</span>;
  } else if (row.status === 'unitChanged') {
    content = <span className="text-fg-secondary text-sm italic">{t(`${k}.row.unitChanged`)}</span>;
  } else {
    const dailyRateLabel =
      row.dailyRate === undefined ? '' : t(`${k}.row.perDay`, { value: formatRate(row.dailyRate, reading.unit) });
    content = (
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
          {t(`${k}.row.days_${pluralCategory(row.days ?? 0, language)}`, { count: row.days ?? 0 })}
          {dailyRateLabel === '' ? '' : ` · ${dailyRateLabel}`}
        </span>
      </>
    );
  }
  return <div className="flex min-w-[9rem] flex-1 flex-col tabular-nums">{content}</div>;
};

const MeterHistoryItem = ({
  capabilities,
  language,
  onShowPhoto,
  onVoid,
  photoLoading,
  reading,
  row,
  who,
}: {
  readonly capabilities: MeterCapabilities;
  readonly language: string;
  readonly onShowPhoto: (reading: MeterReading) => void;
  readonly onVoid: (reading: MeterReading) => void;
  readonly photoLoading: string | undefined;
  readonly reading: MeterReading;
  readonly row: ReadingRow | undefined;
  readonly who: (principal: PrincipalRef) => string;
}) => {
  const { t } = useModernI18n();
  const { canManage, canReadFinancial, canReadPhotos } = capabilities;
  const { voided } = reading;
  const struck = voided === undefined ? '' : 'line-through';
  return (
    <li
      className={`flex flex-col gap-100 p-150 ${row?.anomaly === true ? 'bg-bg-danger-subtle' : ''} ${voided === undefined ? '' : 'bg-surface'}`}
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
        <ReadingConsumption language={language} reading={reading} row={row} />
        {canReadFinancial && (
          <div className="flex flex-col items-end tabular-nums">
            <span className="text-fg-secondary text-xs">{t(`${k}.detail.cost`)}</span>
            {reading.costMinor === undefined ? (
              <span className="text-fg-secondary text-sm">{t('facility-operations.common.noData')}</span>
            ) : (
              <span className="text-sm">{formatMoney(reading.costMinor)}</span>
            )}
          </div>
        )}
        {canManage && voided === undefined && (
          <Button onClick={() => onVoid(reading)} size="sm" theme="borderless" variant="danger">
            {t(`${k}.actions.void`)}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-150 gap-y-50 text-fg-secondary text-xs">
        <span>
          {t(`${k}.detail.readBy`)}: {reading.readBy ?? t(NOT_PROVIDED)}
        </span>
        <span>
          {t(`${k}.detail.author`, {
            at: reading.createdAt.pipe(DateTime.formatIso, formatDateTime),
            who: who(reading.createdBy),
          })}
        </span>
        {canReadPhotos && reading.photo !== undefined && (
          <Button
            isLoading={photoLoading === reading.id}
            onClick={() => onShowPhoto(reading)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t(`${k}.actions.showPhoto`)}
          </Button>
        )}
      </div>
      {reading.note !== undefined && reading.note !== '' && <p className="text-fg-primary text-sm">„{reading.note}“</p>}
      {voided !== undefined && (
        <p className="text-fg-secondary text-xs">
          {t(`${k}.void.voidedBy`, {
            at: voided.at.pipe(DateTime.formatIso, formatDateTime),
            reason: voided.reason,
            who: who(voided.by),
          })}
        </p>
      )}
    </li>
  );
};

const MeterMasterData = ({
  canReadFinancial,
  language,
  meter,
  who,
}: {
  readonly canReadFinancial: boolean;
  readonly language: string;
  readonly meter: Meter;
  readonly who: (principal: PrincipalRef) => string;
}) => {
  const { t } = useModernI18n();
  const { location } = meter;
  const optionalText = (value: string | undefined) => value ?? t(NOT_PROVIDED);
  let locationValue: ReactNode = t(NOT_PROVIDED);
  if (location !== undefined) {
    locationValue = location.label;
    if (!location.id.startsWith('label:')) {
      locationValue = (
        <Tooltip content={t(`${k}.actions.openProperty`)}>
          <a
            className="text-primary underline"
            href={`/${language}/nemovitosti?resourceId=${encodeURIComponent(location.id)}`}
          >
            {location.label}
          </a>
        </Tooltip>
      );
    }
  }
  return (
    <SectionCard title={t(`${k}.detail.masterData`)}>
      <DetailList
        items={[
          { label: t(`${k}.fields.serialNumber`), value: meter.serialNumber },
          { label: t(`${k}.fields.unit`), value: meter.unit },
          {
            label: t(`${k}.fields.location`),
            value: locationValue,
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
            label: t('facility-operations.common.createdAt'),
            value: `${meter.createdAt.pipe(DateTime.formatIso, formatDateTime)} · ${who(meter.createdBy)}`,
          },
          {
            label: t('facility-operations.common.updatedAt'),
            value: `${meter.updatedAt.pipe(DateTime.formatIso, formatDateTime)} · ${who(meter.updatedBy)}`,
          },
        ]}
      />
    </SectionCard>
  );
};

interface ShowMeterPhotoInput {
  readonly reading: MeterReading;
  readonly setPhoto: (photo: PhotoPreview) => void;
  readonly setPhotoLoading: (id: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}

const showMeterPhoto = Effect.fn('Facility.showMeterPhoto')(function* showMeterPhoto({
  reading,
  setPhoto,
  setPhotoLoading,
  t,
  toast,
}: ShowMeterPhotoInput) {
  if (reading.photo === undefined) {
    return;
  }
  setPhotoLoading(reading.id);
  const outcome = yield* loadRecords({ agendas: [], fileId: reading.photo.id });
  setPhotoLoading(undefined);
  if (outcome.ok && outcome.data.file !== undefined) {
    setPhoto({
      name: outcome.data.file.name,
      url: `data:${outcome.data.file.mime};base64,${outcome.data.file.contentBase64}`,
    });
  } else {
    toast.create({ title: t('facility-operations.common.errors.forbidden'), type: 'error' });
  }
});

interface ConfirmMeterReadingVoidInput {
  readonly meter: Meter;
  readonly reason: string;
  readonly run: RunCommand;
  readonly setReason: (reason: string) => void;
  readonly setVoidBusy: (busy: boolean) => void;
  readonly setVoidError: (error: FailureReason | 'required' | undefined) => void;
  readonly setVoiding: (reading: MeterReading | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly voiding: MeterReading | undefined;
}

const confirmMeterReadingVoid = Effect.fn('Facility.confirmMeterReadingVoid')(function* confirmMeterReadingVoid({
  meter,
  reason,
  run,
  setReason,
  setVoidBusy,
  setVoidError,
  setVoiding,
  t,
  toast,
  voiding,
}: ConfirmMeterReadingVoidInput) {
  if (voiding === undefined) {
    return;
  }
  if (reason.trim() === '') {
    setVoidError('required');
    return;
  }
  setVoidBusy(true);
  const outcome = yield* run({
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
});

const meterHistory = (meter: Meter, t: ReturnType<typeof useModernI18n>['t']) => {
  const rows = readingRows(meter);
  const rowById = new Map<string, ReadingRow>(rows.map((row) => [row.reading.id, row]));
  const history = (meter.readings ?? []).toSorted(
    (left, right) => right.date.localeCompare(left.date) || iso(right.createdAt).localeCompare(iso(left.createdAt)),
  );
  const okRows = rows.filter((row) => row.status === 'ok' && row.consumption !== undefined);
  const normalLabel = t(`${k}.detail.series.normal`);
  const anomalyLabel = t(`${k}.detail.series.anomaly`);
  // One chart axis = one unit: periods measured in an earlier unit are not drawn on the current unit's axis.
  const chartRows = okRows.filter((row) => row.reading.unit === meter.unit);
  const otherUnits = [...new Set(okRows.flatMap((row) => (row.reading.unit === meter.unit ? [] : [row.reading.unit])))];
  const chartData: ChartDatum[] = chartRows.map((row) => ({
    consumption: row.consumption ?? 0,
    period: formatDate(row.reading.date),
    series: row.anomaly ? anomalyLabel : normalLabel,
  }));
  const hasAnomaly = chartRows.some((row) => row.anomaly);
  return { chartData, hasAnomaly, history, otherUnits, rowById };
};

const meterAnomalySummary = (anomaly: ReturnType<typeof recentAnomaly>, t: ReturnType<typeof useModernI18n>['t']) =>
  anomaly?.change === undefined ? '' : t(`${k}.row.anomaly`, { change: formatChange(anomaly.change) });

export const MeterDetail = ({
  actor,
  capabilities,
  language,
  meter,
  meters,
  mode,
  onModeChange,
  run,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly capabilities: MeterCapabilities;
  readonly language: string;
  readonly meter: Meter;
  readonly meters: readonly Meter[];
  readonly mode: DetailMode;
  readonly onModeChange: (mode: DetailMode) => void;
  readonly run: RunCommand;
}) => {
  const { canManage, canReadFinancial, canUploadPhotos, canWrite } = capabilities;
  const { t } = useModernI18n();
  const toast = useToast();
  const [voiding, setVoiding] = useState<MeterReading | undefined>();
  const [reason, setReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<FailureReason | 'required' | undefined>();
  const [photo, setPhoto] = useState<PhotoPreview | undefined>();
  const [photoLoading, setPhotoLoading] = useState<string | undefined>();

  const { chartData, hasAnomaly, history, otherUnits, rowById } = meterHistory(meter, t);
  const anomaly = recentAnomaly(meter);
  const anomalySummary = meterAnomalySummary(anomaly, t);
  const who = (principal: PrincipalRef) => personLabel(t, principal, actor);

  const showPhoto = (reading: MeterReading) => showMeterPhoto({ reading, setPhoto, setPhotoLoading, t, toast });

  const confirmVoid = () =>
    confirmMeterReadingVoid({
      meter,
      reason,
      run,
      setReason,
      setVoidBusy,
      setVoidError,
      setVoiding,
      t,
      toast,
      voiding,
    });

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
            {`${anomalySummary} · ${formatDate(anomaly.reading.date)}`}
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
        {otherUnits.length > 0 && (
          <p className="text-fg-secondary text-xs">
            {t(`${k}.detail.chartOtherUnits`, { unit: meter.unit, units: otherUnits.join(', ') })}
          </p>
        )}
      </SectionCard>

      <SectionCard title={t(`${k}.detail.history`)}>
        <p className="text-fg-secondary text-xs">{t(`${k}.detail.historyHint`)}</p>
        {voiding !== undefined && (
          <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
            <strong className="text-sm">{t(`${k}.void.title`, { date: formatDate(voiding.date) })}</strong>
            {voidError !== undefined && (
              <StatusText showIcon status="error">
                {voidError === 'required'
                  ? t('facility-operations.common.required')
                  : t(`facility-operations.common.errors.${voidError}`)}
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
                {t('facility-operations.common.cancel')}
              </Button>
              <Button
                isLoading={voidBusy}
                loadingText={t('facility-operations.common.saving')}
                onClick={() => {
                  void browserRuntime.runPromise(confirmVoid());
                }}
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
          <ol className={`flex flex-col ${dividedListClassName}`}>
            {history.map((reading) => (
              <MeterHistoryItem
                capabilities={capabilities}
                key={reading.id}
                language={language}
                onShowPhoto={(selected) => {
                  void browserRuntime.runPromise(showPhoto(selected));
                }}
                onVoid={(selected) => {
                  setVoiding(selected);
                  setReason('');
                  setVoidError(undefined);
                }}
                photoLoading={photoLoading}
                reading={reading}
                row={rowById.get(reading.id)}
                who={who}
              />
            ))}
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
                {t('facility-operations.common.close')}
              </Button>
            </figcaption>
          </figure>
        )}
      </SectionCard>

      <CommentThread subject={{ id: meter.id, kind: 'meter', label: meter.serialNumber }} />
      <LinkedDocuments hideWhenForbidden subject={{ id: meter.id, kind: 'meter', label: meter.serialNumber }} />
      <SectionCard>
        <ChangeHistory entityId={meter.id} refreshKey={iso(meter.updatedAt)} />
      </SectionCard>

      <MeterMasterData canReadFinancial={canReadFinancial} language={language} meter={meter} who={who} />
    </div>
  );
};
