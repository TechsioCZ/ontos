// @effect-diagnostics asyncFunction:off globalDate:off
// Meter master-data form and reading form (ops-meters lane). Both write through the governed apply-command Action.
import { formatDate } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useRef, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { meterMedia, readingProblem, readingRows } from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium, MeterPhoto, MeterReading } from '../../../../../shared/domain/meters.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { defaultUnitOf, formatChange, formatQuantity } from './meters-view.ts';

const k = 'facility-operations.meters';
const NONE = 'none';

export type RunCommand = (command: OpsCommand) => Promise<CommandOutcome>;

const pragueToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Prague',
    year: 'numeric',
  }).format(Date.now());

/** Parses a typed decimal (`1 234,5` or `1234.5`). `undefined` for empty or invalid input. */
export const parseDecimal = (raw: string): number | undefined => {
  const cleaned = raw.replace(/\s/gu, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d+)?$/u.test(cleaned)) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

const optional = <Key extends string>(key: Key, value: string) =>
  value.trim() === '' ? {} : ({ [key]: value.trim() } as Record<Key, string>);

// ---------------------------------------------------------------------------------------------------------------
// Meter master data
// ---------------------------------------------------------------------------------------------------------------

interface MeterDraft {
  serialNumber: string;
  medium: MeterMedium;
  unit: string;
  location: string;
  supplyPoint: string;
  supplier: string;
  consumer: string;
  contract: string;
  note: string;
  retired: boolean;
}

const draftOf = (meter: Meter | undefined): MeterDraft => ({
  consumer: meter?.consumer ?? '',
  contract: meter?.contract ?? '',
  location: meter?.location === undefined ? '' : `${meter.location.kind}:${meter.location.id}`,
  medium: meter?.medium ?? 'ELECTRICITY',
  note: meter?.note ?? '',
  retired: meter?.status === 'RETIRED',
  serialNumber: meter?.serialNumber ?? '',
  supplier: meter?.supplier ?? '',
  supplyPoint: meter?.supplyPoint ?? '',
  unit: meter?.unit ?? defaultUnitOf.ELECTRICITY,
});

/** Create (no `meter`) or edit form. Calls `onSaved` after the change is persisted. */
export const MeterForm = ({
  meter,
  onCancel,
  onSaved,
  run,
}: {
  readonly meter?: Meter;
  readonly onCancel: () => void;
  readonly onSaved: (meterId: string | undefined) => void;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const properties = usePropertyOptions();
  const [draft, setDraft] = useState<MeterDraft>(() => draftOf(meter));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  const set = <Key extends keyof MeterDraft>(key: Key, value: MeterDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const pickedLocation = (): PropertyRef | undefined => {
    if (draft.location === '') {
      return undefined;
    }
    if (properties.status === 'ready') {
      const found = properties.options.find((option) => option.value === draft.location)?.ref;
      if (found !== undefined) {
        return found;
      }
    }
    // Keep the existing snapshot when the property read is unavailable.
    return meter?.location !== undefined && draft.location === `${meter.location.kind}:${meter.location.id}`
      ? meter.location
      : undefined;
  };

  const submit = async () => {
    if (draft.serialNumber.trim() === '' || draft.unit.trim() === '') {
      setError('required');
      return;
    }
    const location = pickedLocation();
    const fields = {
      medium: draft.medium,
      serialNumber: draft.serialNumber.trim(),
      unit: draft.unit.trim(),
      ...(location === undefined ? {} : { location }),
      ...optional('supplyPoint', draft.supplyPoint),
      ...optional('supplier', draft.supplier),
      ...optional('consumer', draft.consumer),
      ...optional('contract', draft.contract),
      ...optional('note', draft.note),
    };
    setBusy(true);
    const outcome = await run(
      (meter === undefined
        ? { _tag: 'MeterCreate', ...fields }
        : {
            _tag: 'MeterUpdate',
            ...fields,
            meterId: meter.id,
            status: draft.retired ? 'RETIRED' : 'ACTIVE',
          }) as OpsCommand,
    );
    setBusy(false);
    if (outcome.ok) {
      onSaved(outcome.result.entityIds[0]);
    } else {
      setError(outcome.reason);
    }
  };

  const locationItems = [
    { displayValue: t('facility-operations.property.none'), label: t('facility-operations.property.none'), value: NONE },
    ...(properties.status === 'ready'
      ? properties.options.map((option) => ({
          displayValue: option.ref.label,
          label: option.ref.label,
          value: option.value,
        }))
      : meter?.location === undefined
        ? []
        : [
            {
              displayValue: meter.location.label,
              label: meter.location.label,
              value: `${meter.location.kind}:${meter.location.id}`,
            },
          ]),
  ];

  return (
    <div className="flex flex-col gap-200">
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error === 'required' ? t('facility-operations.common.required') : t(`facility-operations.common.errors.${error}`)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.serialNumber`)}
          id="meter-serial"
          label={t(`${k}.fields.serialNumber`)}
          maxLength={64}
          onChange={(event) => set('serialNumber', event.target.value)}
          required
          value={draft.serialNumber}
        />
        <Select
          items={meterMedia.map((medium) => ({
            displayValue: t(`${k}.medium.${medium}`),
            label: t(`${k}.medium.${medium}`),
            value: medium,
          }))}
          label={t(`${k}.fields.medium`)}
          name="medium"
          onValueChange={({ value }) => {
            const medium = (value[0] ?? 'ELECTRICITY') as MeterMedium;
            setDraft((current) => ({
              ...current,
              medium,
              unit:
                meter === undefined && (current.unit === '' || current.unit === defaultUnitOf[current.medium])
                  ? defaultUnitOf[medium]
                  : current.unit,
            }));
          }}
          size="md"
          value={[draft.medium]}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.unit`)}
          id="meter-unit"
          label={t(`${k}.fields.unit`)}
          maxLength={16}
          onChange={(event) => set('unit', event.target.value)}
          required
          value={draft.unit}
        />
        <Select
          items={locationItems}
          label={t(`${k}.fields.location`)}
          name="location"
          onValueChange={({ value }) => set('location', value[0] === undefined || value[0] === NONE ? '' : value[0])}
          size="md"
          value={[draft.location === '' ? NONE : draft.location]}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.supplyPoint`)}
          id="meter-supply-point"
          label={t(`${k}.fields.supplyPoint`)}
          maxLength={120}
          onChange={(event) => set('supplyPoint', event.target.value)}
          value={draft.supplyPoint}
        />
        <FormInput
          autoComplete="off"
          id="meter-supplier"
          label={t(`${k}.fields.supplier`)}
          maxLength={200}
          onChange={(event) => set('supplier', event.target.value)}
          value={draft.supplier}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.consumer`)}
          id="meter-consumer"
          label={t(`${k}.fields.consumer`)}
          maxLength={200}
          onChange={(event) => set('consumer', event.target.value)}
          value={draft.consumer}
        />
        <FormInput
          autoComplete="off"
          id="meter-contract"
          label={t(`${k}.fields.contract`)}
          maxLength={200}
          onChange={(event) => set('contract', event.target.value)}
          value={draft.contract}
        />
      </div>
      <FormTextarea
        id="meter-note"
        label={t(`${k}.fields.note`)}
        maxLength={4000}
        onChange={(event) => set('note', event.target.value)}
        rows={2}
        value={draft.note}
      />
      {meter !== undefined && (
        <label className="flex items-center gap-100 text-sm">
          <input checked={draft.retired} onChange={(event) => set('retired', event.target.checked)} type="checkbox" />
          {t(`${k}.edit.retire`)}
        </label>
      )}
      <div className="flex flex-wrap justify-end gap-100">
        <Button onClick={onCancel} theme="outlined" variant="secondary">
          {t('facility-operations.common.cancel')}
        </Button>
        <Button
          isLoading={busy}
          loadingText={t('facility-operations.common.saving')}
          onClick={() => void submit()}
          variant="primary"
        >
          {meter === undefined ? t(`${k}.create.submit`) : t(`${k}.edit.submit`)}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

type ReadingError =
  | FailureReason
  | 'invalidValue'
  | 'invalidDate'
  | 'invalidCost'
  | 'pickMeter'
  | 'photoTooLarge'
  | 'photoFailed'
  | `problems.${string}`;

/** Preview of the consumption the new reading would produce (same rules as the history). */
const previewOf = (meter: Meter, date: string, value: number) => {
  // readingRows only looks at date, value, unit and voided; the draft is never stored.
  const draft = { date, id: 'draft', unit: meter.unit, value } as unknown as MeterReading;
  const row = readingRows({ readings: [...(meter.readings ?? []), draft] }).find((entry) => entry.reading === draft);
  if (row === undefined || row.status !== 'ok' || row.consumption === undefined || row.previous === undefined) {
    return { kind: 'first' as const };
  }
  return {
    anomaly: row.anomaly,
    change: row.change,
    consumption: row.consumption,
    kind: 'ok' as const,
    previous: row.previous,
  };
};

export const ReadingForm = ({
  canRecordCosts,
  canUploadPhoto,
  meters,
  fixedMeterId,
  onCancel,
  onSaved,
  run,
}: {
  readonly canRecordCosts: boolean;
  readonly canUploadPhoto: boolean;
  readonly meters: readonly Meter[];
  readonly fixedMeterId?: string;
  readonly onCancel: () => void;
  readonly onSaved: (meterId: string) => void;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const [meterId, setMeterId] = useState(fixedMeterId ?? '');
  const [date, setDate] = useState(pragueToday);
  const [value, setValue] = useState('');
  const [readBy, setReadBy] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | undefined>(undefined);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReadingError | undefined>(undefined);
  const meter = meters.find((entry) => entry.id === meterId);
  const parsed = parseDecimal(value);
  const preview =
    meter !== undefined && parsed !== undefined && date !== '' ? previewOf(meter, date, parsed) : undefined;
  const problem =
    meter !== undefined && parsed !== undefined && date !== ''
      ? readingProblem(meter, { date, value: parsed }, pragueToday())
      : undefined;

  const submit = async () => {
    if (meter === undefined) {
      setError('pickMeter');
      return;
    }
    if (date === '') {
      setError('invalidDate');
      return;
    }
    if (parsed === undefined) {
      setError('invalidValue');
      return;
    }
    const costValue = cost.trim() === '' ? undefined : parseDecimal(cost);
    if (cost.trim() !== '' && costValue === undefined) {
      setError('invalidCost');
      return;
    }
    if (problem !== undefined) {
      setError(`problems.${problem}`);
      return;
    }
    if (photo !== undefined && photo.size > MAX_UPLOAD_BYTES) {
      setError('photoTooLarge');
      return;
    }
    setBusy(true);
    let stored: MeterPhoto | undefined;
    if (photo !== undefined) {
      const uploaded = await uploadFile(photo);
      if (!uploaded.ok) {
        setBusy(false);
        setError(uploaded.reason === 'forbidden' ? 'forbidden' : 'photoFailed');
        return;
      }
      stored = uploaded.file;
    }
    const outcome = await run({
      _tag: 'MeterReadingRecord',
      date,
      meterId: meter.id,
      value: parsed,
      ...(!canRecordCosts || costValue === undefined ? {} : { costMinor: Math.round(costValue * 100) }),
      ...(stored === undefined ? {} : { photo: stored }),
      ...optional('readBy', readBy),
      ...optional('note', note),
    } as OpsCommand);
    setBusy(false);
    if (outcome.ok) {
      onSaved(meter.id);
    } else {
      setError(outcome.reason);
    }
  };

  const activeMeters = meters.filter((entry) => entry.status !== 'RETIRED');
  const errorText =
    error === undefined
      ? undefined
      : ['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable'].includes(error)
        ? t(`facility-operations.common.errors.${error}`)
        : error === 'pickMeter'
          ? t(`${k}.reading.pickMeter`)
          : t(`${k}.reading.${error}`);

  return (
    <div className="flex flex-col gap-200">
      {errorText !== undefined && (
        <StatusText showIcon status="error">
          {errorText}
        </StatusText>
      )}
      {fixedMeterId === undefined && (
        <Select
          items={activeMeters.map((entry) => {
            const label = `${entry.serialNumber} · ${t(`${k}.medium.${entry.medium}`)}${entry.location === undefined ? '' : ` · ${entry.location.label}`}`;
            return { displayValue: label, label, value: entry.id };
          })}
          label={t(`${k}.reading.meter`)}
          name="meter"
          placeholder={t(`${k}.reading.pickMeter`)}
          onValueChange={({ value: picked }) => {
            setMeterId(picked[0] ?? '');
            setError(undefined);
          }}
          size="md"
          value={meterId === '' ? [] : [meterId]}
        />
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          id="reading-date"
          label={t(`${k}.reading.date`)}
          max={pragueToday()}
          onChange={(event) => setDate(event.target.value)}
          required
          type="date"
          value={date}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.reading.valueHelp`)}
          id="reading-value"
          inputMode="decimal"
          label={t(`${k}.reading.value`, { unit: meter?.unit ?? '—' })}
          onChange={(event) => setValue(event.target.value)}
          required
          validateStatus={value !== '' && parsed === undefined ? 'error' : problem === undefined ? 'default' : 'error'}
          value={value}
        />
      </div>
      {meter !== undefined && parsed !== undefined && problem !== undefined && (
        <StatusText showIcon status="error">
          {t(`${k}.reading.problems.${problem}`)}
        </StatusText>
      )}
      {meter !== undefined && problem === undefined && preview !== undefined && (
        <div
          className={`rounded-md border p-150 text-sm ${
            preview.kind === 'ok' && preview.anomaly
              ? 'border-danger bg-danger-light'
              : 'border-border-primary bg-surface-subtle'
          }`}
          data-testid="reading-preview"
        >
          {preview.kind === 'first' ? (
            t(`${k}.reading.previewFirst`)
          ) : (
            <div className="flex flex-col gap-50">
              <span>
                {t(`${k}.reading.preview`, {
                  date: formatDate(preview.previous.date),
                  value: formatQuantity(preview.consumption, meter.unit),
                })}
              </span>
              {preview.anomaly && preview.change !== undefined && (
                <strong>{t(`${k}.reading.previewAnomaly`, { change: formatChange(preview.change) })}</strong>
              )}
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          id="reading-read-by"
          label={t(`${k}.reading.readBy`)}
          maxLength={120}
          onChange={(event) => setReadBy(event.target.value)}
          value={readBy}
        />
        {canRecordCosts && (
          <FormInput
            autoComplete="off"
            helpText={t(`${k}.reading.costHelp`)}
            id="reading-cost"
            inputMode="decimal"
            label={t(`${k}.reading.cost`)}
            onChange={(event) => setCost(event.target.value)}
            validateStatus={cost.trim() !== '' && parseDecimal(cost) === undefined ? 'error' : 'default'}
            value={cost}
          />
        )}
      </div>
      <FormTextarea
        id="reading-note"
        label={t(`${k}.reading.note`)}
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      {canUploadPhoto ? (
        <div className="flex flex-col gap-50">
          <span className="font-medium text-sm">{t(`${k}.reading.photo`)}</span>
          <input
            accept="image/*"
            className="hidden"
            id="reading-photo"
            onChange={(event) => setPhoto(event.target.files?.[0])}
            ref={photoInput}
            type="file"
          />
          <div className="flex flex-wrap items-center gap-150">
            <Button onClick={() => photoInput.current?.click()} size="sm" theme="outlined" variant="secondary">
              {t(`${k}.reading.photoPick`)}
            </Button>
            <span className="text-sm">
              {photo === undefined ? t(`${k}.reading.photoNone`) : `${photo.name} (${Math.ceil(photo.size / 1024)} kB)`}
            </span>
            {photo !== undefined && (
              <Button
                onClick={() => {
                  setPhoto(undefined);
                  if (photoInput.current !== null) {
                    photoInput.current.value = '';
                  }
                }}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {t('facility-operations.common.cancel')}
              </Button>
            )}
          </div>
          <span className="text-fg-secondary text-xs">{t(`${k}.reading.photoHelp`)}</span>
        </div>
      ) : (
        <p className="text-fg-secondary text-xs">{t(`${k}.reading.photoRestricted`)}</p>
      )}
      <div className="flex flex-wrap justify-end gap-100">
        <Button onClick={onCancel} theme="outlined" variant="secondary">
          {t('facility-operations.common.cancel')}
        </Button>
        <Button
          disabled={problem !== undefined}
          isLoading={busy}
          loadingText={t('facility-operations.common.saving')}
          onClick={() => void submit()}
          variant="primary"
        >
          {t(`${k}.reading.submit`)}
        </Button>
      </div>
    </div>
  );
};
