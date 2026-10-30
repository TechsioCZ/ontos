import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Meter master-data form and reading form (ops-meters lane). Both write through the governed apply-command Action.
import { formatDate } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect, Result, Schema } from 'effect';
import { useReducer, useRef, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { MeterMediumSchema, meterMedia, readingProblem, readingRows } from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium, MeterPhoto, MeterReadingSchema } from '../../../../../shared/domain/meters.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { defaultUnitOf, formatChange, formatQuantity } from './meters-view.ts';

const k = 'facility-operations.meters';
const CANCEL_LABEL = 'facility-operations.common.cancel';
const NONE = 'none';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;
type MeterFields = Omit<Extract<OpsCommand, { readonly _tag: 'MeterCreate' }>, '_tag'>;
type MutableMeterFields = { -readonly [Key in keyof MeterFields]: MeterFields[Key] };
type ReadingCommand = Extract<OpsCommand, { readonly _tag: 'MeterReadingRecord' }>;
type MutableReadingCommand = { -readonly [Key in keyof ReadingCommand]: ReadingCommand[Key] };

const pragueDateFormatter = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
const pragueToday = (): string => pragueDateFormatter.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

/** Parses a typed decimal (`1 234,5` or `1234.5`). `undefined` for empty or invalid input. */
export const parseDecimal = (raw: string): number | undefined => {
  const cleaned = raw.replaceAll(/\s/gu, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(?:\.\d+)?$/u.test(cleaned)) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

const optional = <Key extends string>(key: Key, value: string) =>
  optionalField(key, value.trim() === '' ? undefined : value.trim());

// ---------------------------------------------------------------------------------------------------------------
// Meter master data
// ---------------------------------------------------------------------------------------------------------------

interface MeterDraft {
  consumer: string;
  contract: string;
  location: string;
  medium: MeterMedium;
  note: string;
  retired: boolean;
  serialNumber: string;
  supplier: string;
  supplyPoint: string;
  unit: string;
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
interface SubmitMeterFormInput {
  readonly draft: MeterDraft;
  readonly meter: Meter | undefined;
  readonly onSaved: (meterId: string | undefined) => void;
  readonly pickedLocation: () => PropertyRef | undefined;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: FailureReason | 'required' | undefined) => void;
}

const submitMeterForm = Effect.fn('Facility.submitMeterForm')(function* submitMeterForm({
  draft,
  meter,
  onSaved,
  pickedLocation,
  run,
  setBusy,
  setError,
}: SubmitMeterFormInput) {
  if (draft.serialNumber.trim() === '' || draft.unit.trim() === '') {
    setError('required');
    return;
  }
  const location = pickedLocation();
  const fields: MutableMeterFields = {
    medium: draft.medium,
    serialNumber: draft.serialNumber.trim(),
    unit: draft.unit.trim(),
    ...optional('supplyPoint', draft.supplyPoint),
    ...optional('supplier', draft.supplier),
    ...optional('consumer', draft.consumer),
    ...optional('contract', draft.contract),
    ...optional('note', draft.note),
  };
  if (location !== undefined) {
    fields.location = location;
  }
  setBusy(true);
  const outcome = yield* run(
    meter === undefined
      ? { _tag: 'MeterCreate', ...fields }
      : {
          _tag: 'MeterUpdate',
          ...fields,
          meterId: meter.id,
          status: draft.retired ? 'RETIRED' : 'ACTIVE',
        },
  );
  setBusy(false);
  if (outcome.ok) {
    onSaved(outcome.result.entityIds[0]);
  } else {
    setError(outcome.reason);
  }
});

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
  const [error, setError] = useState<FailureReason | 'required' | undefined>();
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

  const submit = () => submitMeterForm({ draft, meter, onSaved, pickedLocation, run, setBusy, setError });

  const locationItems = [
    {
      displayValue: t('facility-operations.property.none'),
      label: t('facility-operations.property.none'),
      value: NONE,
    },
  ];
  if (properties.status === 'ready') {
    locationItems.push(
      ...properties.options.map((option) => ({
        displayValue: option.ref.label,
        label: option.ref.label,
        value: option.value,
      })),
    );
  } else if (meter?.location !== undefined) {
    locationItems.push({
      displayValue: meter.location.label,
      label: meter.location.label,
      value: `${meter.location.kind}:${meter.location.id}`,
    });
  }

  return (
    <div className="flex flex-col gap-200">
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error === 'required'
            ? t('facility-operations.common.required')
            : t(`facility-operations.common.errors.${error}`)}
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
            const parsed = Schema.decodeUnknownResult(MeterMediumSchema)(value[0] ?? 'ELECTRICITY');
            if (Result.isFailure(parsed)) {
              return;
            }
            const medium = parsed.success;
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
          {t(CANCEL_LABEL)}
        </Button>
        <Button
          isLoading={busy}
          loadingText={t('facility-operations.common.saving')}
          onClick={() => {
            void browserRuntime.runPromise(submit());
          }}
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
  const draft = { date, unit: meter.unit, value };
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

interface SubmitMeterReadingInput {
  readonly canRecordCosts: boolean;
  readonly cost: string;
  readonly date: (typeof MeterReadingSchema.Encoded)['date'];
  readonly meter: Meter | undefined;
  readonly note: string;
  readonly onSaved: (meterId: string) => void;
  readonly parsed: number | undefined;
  readonly photo: File | undefined;
  readonly problem: ReturnType<typeof readingProblem>;
  readonly readBy: string;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: ReadingError | undefined) => void;
}

const submitMeterReading = Effect.fn('Facility.submitMeterReading')(function* submitMeterReading({
  canRecordCosts,
  cost,
  date,
  meter,
  note,
  onSaved,
  parsed,
  photo,
  problem,
  readBy,
  run,
  setBusy,
  setError,
}: SubmitMeterReadingInput) {
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
    const uploaded = yield* uploadFile(photo);
    if (!uploaded.ok) {
      setBusy(false);
      setError(uploaded.reason === 'forbidden' ? 'forbidden' : 'photoFailed');
      return;
    }
    stored = uploaded.file;
  }
  const command: MutableReadingCommand = {
    _tag: 'MeterReadingRecord',
    date,
    meterId: meter.id,
    value: parsed,
    ...optional('readBy', readBy),
    ...optional('note', note),
  };
  if (canRecordCosts && costValue !== undefined) {
    command.costMinor = Math.round(costValue * 100);
  }
  if (stored !== undefined) {
    command.photo = stored;
  }
  const outcome = yield* run(command);
  setBusy(false);
  if (outcome.ok) {
    onSaved(meter.id);
  } else {
    setError(outcome.reason);
  }
});

interface ReadingDraft {
  readonly cost: string;
  readonly date: (typeof MeterReadingSchema.Encoded)['date'];
  readonly meterId: string;
  readonly note: string;
  readonly photo?: File;
  readonly readBy: string;
  readonly value: string;
}
const readingDraftOf = (fixedMeterId: string | undefined): ReadingDraft => ({
  cost: '',
  date: pragueToday(),
  meterId: fixedMeterId ?? '',
  note: '',
  readBy: '',
  value: '',
});
type ReadingDraftChange = Partial<ReadingDraft> | { readonly clearPhoto: true };
const updateReadingDraft = (draft: ReadingDraft, changes: ReadingDraftChange): ReadingDraft => {
  if ('clearPhoto' in changes) {
    const { photo: _photo, ...withoutPhoto } = draft;
    return withoutPhoto;
  }
  return { ...draft, ...changes };
};

const ReadingPreview = ({
  meter,
  parsed,
  preview,
  problem,
}: {
  readonly meter: Meter | undefined;
  readonly parsed: number | undefined;
  readonly preview: ReturnType<typeof previewOf> | undefined;
  readonly problem: ReturnType<typeof readingProblem>;
}) => {
  const { t } = useModernI18n();
  if (meter === undefined || parsed === undefined) {
    return null;
  }
  if (problem !== undefined) {
    return (
      <StatusText showIcon status="error">
        {t(`${k}.reading.problems.${problem}`)}
      </StatusText>
    );
  }
  if (preview === undefined) {
    return null;
  }
  return (
    <div
      className={`rounded-lg p-150 text-sm ${preview.kind === 'ok' && preview.anomaly ? 'bg-bg-danger-subtle' : 'bg-surface'}`}
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
  );
};

const readingValueStatus = (value: string, parsed: number | undefined, problem: ReturnType<typeof readingProblem>) => {
  if (value !== '' && parsed === undefined) {
    return 'error' as const;
  }
  return problem === undefined ? ('default' as const) : ('error' as const);
};
const readingErrorKey = (error: ReadingError) => {
  if (['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable'].includes(error)) {
    return `facility-operations.common.errors.${error}`;
  }
  return `${k}.reading.${error}`;
};
const readingErrorText = (error: ReadingError | undefined, t: ReturnType<typeof useModernI18n>['t']) =>
  error === undefined ? undefined : t(readingErrorKey(error));

export const ReadingForm = ({
  canRecordCosts,
  canUploadPhoto,
  fixedMeterId,
  meters,
  onCancel,
  onSaved,
  run,
}: {
  readonly canRecordCosts: boolean;
  readonly canUploadPhoto: boolean;
  readonly fixedMeterId?: string;
  readonly meters: readonly Meter[];
  readonly onCancel: () => void;
  readonly onSaved: (meterId: string) => void;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const [draft, updateDraft] = useReducer(updateReadingDraft, fixedMeterId, readingDraftOf);
  const { cost, date, meterId, note, photo, readBy, value } = draft;
  const setMeterId = (nextValue: string) => updateDraft({ meterId: nextValue });
  const setDate = (nextValue: (typeof MeterReadingSchema.Encoded)['date']) => updateDraft({ date: nextValue });
  const setValue = (nextValue: string) => updateDraft({ value: nextValue });
  const setReadBy = (nextValue: string) => updateDraft({ readBy: nextValue });
  const setCost = (nextValue: string) => updateDraft({ cost: nextValue });
  const setNote = (nextValue: string) => updateDraft({ note: nextValue });
  const setPhoto = (nextPhoto: File | undefined) => {
    if (nextPhoto === undefined) {
      updateDraft({ clearPhoto: true });
    } else {
      updateDraft({ photo: nextPhoto });
    }
  };
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReadingError | undefined>();
  const meter = meters.find((entry) => entry.id === meterId);
  const parsed = parseDecimal(value);
  const preview =
    meter !== undefined && parsed !== undefined && date !== '' ? previewOf(meter, date, parsed) : undefined;
  const problem =
    meter !== undefined && parsed !== undefined && date !== ''
      ? readingProblem(meter, { date, value: parsed }, pragueToday())
      : undefined;

  const submit = () =>
    submitMeterReading({
      canRecordCosts,
      cost,
      date,
      meter,
      note,
      onSaved,
      parsed,
      photo,
      problem,
      readBy,
      run,
      setBusy,
      setError,
    });

  const activeMeters = meters.filter((entry) => entry.status !== 'RETIRED');
  const errorText = readingErrorText(error, t);

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
            const mediumLabel = t(`${k}.medium.${entry.medium}`);
            const locationLabel = entry.location === undefined ? '' : ` · ${entry.location.label}`;
            const label = `${entry.serialNumber} · ${mediumLabel}${locationLabel}`;
            return { displayValue: label, label, value: entry.id };
          })}
          label={t(`${k}.reading.meter`)}
          name="meter"
          onValueChange={({ value: picked }) => {
            setMeterId(picked[0] ?? '');
            setError(undefined);
          }}
          placeholder={t(`${k}.reading.pickMeter`)}
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
          validateStatus={readingValueStatus(value, parsed, problem)}
          value={value}
        />
      </div>
      <ReadingPreview meter={meter} parsed={parsed} preview={preview} problem={problem} />
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
                {t(CANCEL_LABEL)}
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
          {t(CANCEL_LABEL)}
        </Button>
        <Button
          disabled={problem !== undefined}
          isLoading={busy}
          loadingText={t('facility-operations.common.saving')}
          onClick={() => {
            void browserRuntime.runPromise(submit());
          }}
          variant="primary"
        >
          {t(`${k}.reading.submit`)}
        </Button>
      </div>
    </div>
  );
};
